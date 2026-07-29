import { addMinutes, isBefore } from "date-fns";
import { db } from "./db";
import { localDateKey, nextAllowedTime, nextUnoccupiedLocalDay } from "./quiet-hours";

const activeActionStatuses = ["PLANNED", "QUEUED", "PROCESSING", "FAILED", "WAITING_FOR_APPROVAL"] as const;
const administratorSkipReason = "Skipped by administrator";
const waitingReason = "Waiting for previous reminder outcome";

export function reminderDailySlotKey(personId: string, date: Date, timezone: string) {
  return `reminder-daily-slot:${personId}:${localDateKey(date, timezone)}`;
}

function renderTemplate(template: string, assignment: {
  role: string;
  event: { name: string; startsAt: Date; timezone: string; venueName: string | null; address: string | null };
  person: { firstName: string };
}) {
  const location = [assignment.event.venueName, assignment.event.address].filter(Boolean).join(", ") || "location details pending";
  return template
    .replaceAll("{{firstName}}", assignment.person.firstName)
    .replaceAll("{{role}}", assignment.role.toLowerCase())
    .replaceAll("{{eventName}}", assignment.event.name)
    .replaceAll("{{eventDate}}", assignment.event.startsAt.toLocaleDateString("en-US", {
      timeZone: assignment.event.timezone,
      dateStyle: "long",
    }))
    .replaceAll("{{venueName}}", assignment.event.venueName ?? "venue details pending")
    .replaceAll("{{eventLocation}}", location)
    .replaceAll("{{confirmationUrl}}", "[secure confirmation link]");
}

export function reminderStepIsSatisfied(action: { status: string; lastError: string | null } | undefined) {
  return action?.status === "COMPLETED" ||
    (action?.status === "CANCELED" && action.lastError === administratorSkipReason);
}

export async function planAssignmentReminders(assignmentId: string, now = new Date()) {
  const assignment = await db.assignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { event: true, person: true },
  });
  const eligible =
    assignment.active &&
    !["CONFIRMED", "CANCELED"].includes(assignment.confirmationStatus) &&
    !assignment.event.canceled &&
    !assignment.person.paused &&
    !assignment.paused &&
    !assignment.event.paused &&
    isBefore(now, assignment.event.startsAt);

  if (!eligible) {
    await db.plannedAction.updateMany({
      where: { assignmentId, type: { in: ["REMINDER", "ESCALATE"] }, status: { in: [...activeActionStatuses] } },
      data: { status: "CANCELED", canceledAt: now, lastError: "Assignment is no longer eligible for reminders" },
    });
    await db.assignment.update({ where: { id: assignmentId }, data: { nextReminderAt: null } });
    return [];
  }

  const policies = await db.reminderPolicy.findMany({
    where: { active: true, OR: [{ roleFilter: null }, { roleFilter: assignment.role }] },
    orderBy: { attemptNumber: "asc" },
  });
  const actions = await db.plannedAction.findMany({
    where: { assignmentId, type: { in: ["REMINDER", "ESCALATE"] } },
  });
  const actionByPolicy = new Map(actions.map(action => [action.idempotencyKey, action]));
  const nextPolicy = policies.find(policy =>
    !reminderStepIsSatisfied(actionByPolicy.get(`reminder:${assignment.id}:${policy.id}`))
  );

  if (!nextPolicy) {
    await db.plannedAction.updateMany({
      where: { assignmentId, type: { in: ["REMINDER", "ESCALATE"] }, status: { in: [...activeActionStatuses] } },
      data: { status: "CANCELED", canceledAt: now, lastError: "Reminder sequence completed" },
    });
    await db.assignment.update({
      where: { id: assignmentId },
      data: {
        nextReminderAt: null,
        reminderCount: actions.filter(action => action.status === "COMPLETED").length,
      },
    });
    return [];
  }

  const nextKey = `reminder:${assignment.id}:${nextPolicy.id}`;
  await db.plannedAction.updateMany({
    where: {
      assignmentId,
      type: { in: ["REMINDER", "ESCALATE"] },
      idempotencyKey: { not: nextKey },
      status: { in: [...activeActionStatuses] },
    },
    data: { status: "CANCELED", canceledAt: now, lastError: waitingReason },
  });

  let when = addMinutes(assignment.event.startsAt, -nextPolicy.offsetMinutes);
  if (isBefore(when, now)) when = addMinutes(now, 5);
  if (nextPolicy.honorQuietHours) when = nextAllowedTime(when, assignment.person.timezone);
  const otherReminderActions = await db.plannedAction.findMany({
    where: {
      personId: assignment.personId,
      type: { in: ["REMINDER", "ESCALATE"] },
      idempotencyKey: { not: nextKey },
      status: { in: ["PLANNED", "QUEUED", "PROCESSING", "COMPLETED"] },
    },
    select: { status: true, scheduledFor: true, completedAt: true },
  });
  const occupiedDateKeys = new Set(otherReminderActions.map(action =>
    localDateKey(action.status === "COMPLETED" && action.completedAt ? action.completedAt : action.scheduledFor, assignment.person.timezone)
  ));
  when = nextUnoccupiedLocalDay(when, assignment.person.timezone, occupiedDateKeys);

  const preview = renderTemplate(nextPolicy.messageTemplate, assignment);
  const subject = nextPolicy.subjectTemplate
    ? renderTemplate(nextPolicy.subjectTemplate, assignment)
    : null;
  const existing = actionByPolicy.get(nextKey);
  const action = await db.plannedAction.upsert({
    where: { idempotencyKey: nextKey },
    update: {
      scheduledFor: when,
      messagePreview: preview,
      subjectPreview: subject,
      reason: nextPolicy.name,
      channel: nextPolicy.channel,
      ...(existing?.status === "CANCELED"
        ? { status: "PLANNED" as const, canceledAt: null, lastError: null }
        : {}),
    },
    create: {
      type: nextPolicy.escalate ? "ESCALATE" : "REMINDER",
      eventId: assignment.eventId,
      assignmentId: assignment.id,
      personId: assignment.personId,
      channel: nextPolicy.channel,
      scheduledFor: when,
      reason: nextPolicy.name,
      messagePreview: preview,
      subjectPreview: subject,
      idempotencyKey: nextKey,
    },
  });
  await db.assignment.update({
    where: { id: assignmentId },
    data: {
      nextReminderAt: when,
      reminderCount: actions.filter(candidate => candidate.status === "COMPLETED").length,
    },
  });
  return [action];
}

export async function skipReminderAction(actionId: string) {
  const action = await db.plannedAction.update({
    where: { id: actionId },
    data: { status: "CANCELED", canceledAt: new Date(), lastError: administratorSkipReason },
  });
  if (action.assignmentId) await planAssignmentReminders(action.assignmentId);
  return action;
}
