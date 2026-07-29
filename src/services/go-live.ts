import { addMinutes } from "date-fns";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { actionsQueue } from "@/lib/queue";
import { planAssignmentReminders } from "@/lib/reminders";
import { notifySystemDeveloper } from "@/services/developer-alerts";

const launchSettingKey = "production-launch";
const introText = "Hi {{firstName}}—Authentic Moments here. We’re launching our new crew reminder number. You’ll receive event reminders and can reply SCHEDULE for upcoming ceremonies, LOCATION for venue details, HOURS for coverage, or HELP for options. Reply STOP to opt out.";

type LaunchState = {
  status: "PREPARED" | "LIVE";
  preparedAt: string;
  activatedAt?: string;
  introStart: string;
  reminderStart: string;
  eligibleContractors: number;
  skippedContractors: number;
  eligibleAssignments: number;
  suppressedAssignments: number;
};

export function contractorLaunchEligibility(person: {
  active: boolean;
  paused: boolean;
  smsEligible: boolean;
  phone: string | null;
  notes?: string | null;
}) {
  if (!person.active) return { eligible: false, reason: "inactive" };
  if (person.paused) return { eligible: false, reason: "paused" };
  if (!person.smsEligible) return { eligible: false, reason: "SMS ineligible or opted out" };
  if (!person.phone) return { eligible: false, reason: "missing phone" };
  if (person.notes?.includes("[DO_NOT_CONTACT_REMOVED]")) return { eligible: false, reason: "do not contact" };
  const parsedPhone = parsePhoneNumberFromString(person.phone, "US");
  if (!parsedPhone?.isValid()) return { eligible: false, reason: "invalid phone" };
  return { eligible: true, reason: null };
}

export function assignmentIsInsideLaunchExclusion(startsAt: Date, now: Date) {
  return startsAt.getTime() < now.getTime() + 7 * 24 * 60 * 60 * 1000;
}

async function removeQueuedJob(jobQueueId: string | null, idempotencyKey: string) {
  for (const candidate of new Set([
    jobQueueId,
    jobQueueId?.replaceAll(":", "-"),
    idempotencyKey.replaceAll(":", "-"),
  ].filter((value): value is string => Boolean(value)))) {
    const job = await actionsQueue.getJob(candidate);
    if (job) {
      await job.remove();
      return;
    }
  }
}

export async function getProductionLaunchState() {
  const setting = await db.setting.findUnique({ where: { key: launchSettingKey } });
  return setting?.value as LaunchState | undefined;
}

export async function prepareProductionLaunch(actorId: string, now = new Date()) {
  if (!env().TEST_MODE) throw new Error("The launch plan must be prepared while TEST_MODE is still enabled.");
  const existing = await getProductionLaunchState();
  if (existing) return existing;

  const introStart = addMinutes(now, 10);
  const reminderStart = addMinutes(now, 30);
  const people = await db.person.findMany({ orderBy: { displayName: "asc" } });
  const eligiblePeople = people.filter(person => contractorLaunchEligibility(person).eligible);
  for (const [index, person] of eligiblePeople.entries()) {
    await db.plannedAction.upsert({
      where: { idempotencyKey: `production-intro:${person.id}` },
      update: {},
      create: {
        type: "SYSTEM_INTRO",
        personId: person.id,
        channel: "SMS",
        scheduledFor: new Date(introStart.getTime() + index * 5000),
        status: "PLANNED",
        reason: "One-time production reminder-system introduction",
        messagePreview: introText.replace("{{firstName}}", person.firstName),
        idempotencyKey: `production-intro:${person.id}`,
      },
    });
  }

  const assignments = await db.assignment.findMany({
    where: {
      active: true,
      confirmationStatus: { notIn: ["CONFIRMED", "CANCELED"] },
      person: { active: true },
      event: { startsAt: { gt: now }, canceled: false },
    },
    include: { event: true },
    orderBy: { event: { startsAt: "asc" } },
  });
  const suppressed = assignments.filter(assignment => assignmentIsInsideLaunchExclusion(assignment.event.startsAt, now));
  const eligible = assignments.filter(assignment => !assignmentIsInsideLaunchExclusion(assignment.event.startsAt, now));

  for (const assignment of suppressed) {
    const actions = await db.plannedAction.findMany({
      where: { assignmentId: assignment.id, type: { in: ["REMINDER", "ESCALATE"] }, status: { in: ["PLANNED", "QUEUED", "PROCESSING", "FAILED", "WAITING_FOR_APPROVAL"] } },
    });
    for (const action of actions) await removeQueuedJob(action.jobQueueId, action.idempotencyKey);
    await db.plannedAction.updateMany({
      where: { assignmentId: assignment.id, type: { in: ["REMINDER", "ESCALATE"] }, status: { in: ["PLANNED", "QUEUED", "FAILED", "WAITING_FOR_APPROVAL"] } },
      data: { status: "SUPPRESSED", lastError: "Suppressed at production launch: event is less than 7 days away" },
    });
    await db.assignment.update({ where: { id: assignment.id }, data: { nextReminderAt: null } });
  }

  for (const [index, assignment] of eligible.entries()) {
    await planAssignmentReminders(assignment.id, now);
    const action = await db.plannedAction.findFirst({
      where: { assignmentId: assignment.id, type: { in: ["REMINDER", "ESCALATE"] }, status: { in: ["PLANNED", "QUEUED", "FAILED"] } },
      orderBy: { scheduledFor: "asc" },
    });
    if (!action) continue;
    await removeQueuedJob(action.jobQueueId, action.idempotencyKey);
    const earliest = new Date(reminderStart.getTime() + index * 15000);
    await db.plannedAction.update({
      where: { id: action.id },
      data: {
        status: "PLANNED",
        scheduledFor: action.scheduledFor < earliest ? earliest : action.scheduledFor,
        jobQueueId: null,
        lastError: null,
      },
    });
  }

  const state: LaunchState = {
    status: "PREPARED",
    preparedAt: now.toISOString(),
    introStart: introStart.toISOString(),
    reminderStart: reminderStart.toISOString(),
    eligibleContractors: eligiblePeople.length,
    skippedContractors: people.length - eligiblePeople.length,
    eligibleAssignments: eligible.length,
    suppressedAssignments: suppressed.length,
  };
  await db.setting.create({ data: { key: launchSettingKey, value: state } });
  await db.auditLog.create({
    data: {
      actorType: "ADMIN",
      actorId,
      action: "PRODUCTION_LAUNCH_PREPARED",
      entityType: "Setting",
      entityId: launchSettingKey,
      after: state,
    },
  });
  return state;
}

export async function activatePreparedProductionLaunch(now = new Date()) {
  const config = env();
  if (config.TEST_MODE) return null;
  const state = await getProductionLaunchState();
  if (!state) throw new Error("Production communication is blocked because no launch plan was prepared.");
  if (state.status === "LIVE") return state;
  const liveState: LaunchState = { ...state, status: "LIVE", activatedAt: now.toISOString() };
  await db.setting.update({ where: { key: launchSettingKey }, data: { value: liveState } });
  await db.auditLog.create({
    data: {
      actorType: "SYSTEM",
      action: "PRODUCTION_LAUNCH_ACTIVATED",
      entityType: "Setting",
      entityId: launchSettingKey,
      before: state,
      after: liveState,
    },
  });
  await notifySystemDeveloper({
    key: `production-launch:${state.preparedAt}`,
    subject: "AMM Robot is live",
    body: `Production communication is active.

Contractor introductions planned: ${state.eligibleContractors}
Contractors skipped: ${state.skippedContractors}
Assignments continuing reminders: ${state.eligibleAssignments}
Assignments suppressed inside 7 days: ${state.suppressedAssignments}
Introduction start: ${state.introStart}
Reminder start: ${state.reminderStart}`,
  });
  return liveState;
}
