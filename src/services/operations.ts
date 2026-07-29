import type { Channel } from "@prisma/client";
import type { AssignmentRole } from "@prisma/client";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { db } from "@/lib/db";
import { actionsQueue } from "@/lib/queue";
import { assertPermission } from "@/lib/permissions";
import { planAssignmentReminders } from "@/lib/reminders";
import { skipReminderAction } from "@/lib/reminders";
import { reconcileEventReadiness } from "@/services/readiness";
import { classifyProjectManagerQuestion, projectManagerToolNames } from "@/lib/project-manager-agent";

async function administrator(adminId: string) {
  return db.administrator.findUniqueOrThrow({ where: { id: adminId } });
}

async function claimAction(idempotencyKey: string, adminId: string) {
  try {
    await db.setting.create({
      data: { key: `operation:${idempotencyKey}`, value: { adminId, claimedAt: new Date().toISOString() } },
    });
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return false;
    throw error;
  }
}

async function audit(adminId: string, action: string, entityType: string, entityId: string | undefined, before: unknown, after: unknown, idempotencyKey: string) {
  await db.auditLog.create({
    data: {
      actorType: "ADMIN",
      actorId: adminId,
      action,
      entityType,
      entityId,
      before: before as object | undefined,
      after: after as object | undefined,
      metadata: { idempotencyKey },
    },
  });
}

async function removeQueuedActionJob(jobQueueId: string | null, fallbackIdempotencyKey: string) {
  for (const candidate of new Set([
    jobQueueId,
    jobQueueId?.replaceAll(":", "-"),
    fallbackIdempotencyKey.replaceAll(":", "-"),
  ].filter((value): value is string => Boolean(value)))) {
    const job = await actionsQueue.getJob(candidate);
    if (job) {
      await job.remove();
      return;
    }
  }
}

export async function getEventReadiness(eventId: string) {
  return db.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startsAt: true, readinessStatus: true, readinessReasons: true, readinessCalculatedAt: true },
  });
}

export async function listReadyEvents(from = new Date(), to = new Date(Date.now() + 30 * 86400000)) {
  return db.event.findMany({ where: { startsAt: { gte: from, lte: to }, readinessStatus: "READY", canceled: false }, orderBy: { startsAt: "asc" } });
}

export async function listEventsNeedingAttention(from = new Date(), to = new Date(Date.now() + 30 * 86400000)) {
  return db.event.findMany({
    where: { startsAt: { gte: from, lte: to }, canceled: false, readinessStatus: { not: "READY" } },
    include: { operationalAlerts: { where: { status: "OPEN" } } },
    orderBy: { startsAt: "asc" },
  });
}

export async function listUnconfirmedAssignments(from = new Date(), to = new Date(Date.now() + 90 * 86400000)) {
  return db.assignment.findMany({
    where: { active: true, confirmationStatus: { not: "CONFIRMED" }, event: { startsAt: { gte: from, lte: to }, canceled: false } },
    include: { event: true, person: true },
    orderBy: { event: { startsAt: "asc" } },
  });
}

export async function listUnfilledRoles() {
  return db.operationalAlert.findMany({ where: { status: "OPEN", type: "REQUIRED_ROLE_UNFILLED" }, include: { event: true } });
}

export async function listRecentDeclines(since = new Date(Date.now() - 7 * 86400000)) {
  return db.assignment.findMany({ where: { declinedAt: { gte: since } }, include: { event: true, person: true }, orderBy: { declinedAt: "desc" } });
}

export async function listDeliveryFailures(since = new Date(Date.now() - 7 * 86400000)) {
  return db.message.findMany({ where: { createdAt: { gte: since }, deliveryStatus: { in: ["FAILED", "BOUNCED"] } }, include: { event: true, person: true } });
}

export async function listUpcomingPlannedActions(from = new Date(), to = new Date(Date.now() + 7 * 86400000)) {
  return db.plannedAction.findMany({ where: { scheduledFor: { gte: from, lte: to }, status: { in: ["PLANNED", "QUEUED"] } }, include: { event: true, person: true }, orderBy: { scheduledFor: "asc" } });
}

export async function getPersonConfirmationStatus(personId: string) {
  return db.assignment.findMany({ where: { personId, active: true, event: { startsAt: { gte: new Date() }, canceled: false } }, include: { event: true }, orderBy: { event: { startsAt: "asc" } } });
}

export async function getEventStaffing(eventId: string) {
  return db.event.findUnique({ where: { id: eventId }, include: { assignments: { where: { active: true }, include: { person: true } } } });
}

export async function getOpenTasksForEvent(eventId: string) {
  return db.operationalTask.findMany({ where: { eventId, status: { in: ["OPEN", "DUE_SOON", "OVERDUE", "UNKNOWN"] } }, orderBy: { dueAt: "asc" } });
}

export async function getOverdueTasks() {
  return db.operationalTask.findMany({ where: { status: "OVERDUE" }, include: { event: true, assignedLocalAdministrator: true }, orderBy: { dueAt: "asc" } });
}

export async function getTasksAssignedToUser(administratorId: string) {
  return db.operationalTask.findMany({ where: { assignedLocalAdministratorId: administratorId, status: { notIn: ["COMPLETED", "DELETED"] } }, include: { event: true }, orderBy: { dueAt: "asc" } });
}

export async function sendManualMessage(input: {
  adminId: string;
  personId: string;
  eventId?: string;
  assignmentId?: string;
  channel: Exclude<Channel, "SYSTEM">;
  text: string;
  idempotencyKey: string;
  approved: boolean;
}) {
  const admin = await administrator(input.adminId);
  assertPermission(admin, "communications:send");
  const person = await db.person.findUniqueOrThrow({ where: { id: input.personId } });
  const action = await db.plannedAction.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: {
      type: "MANUAL_MESSAGE",
      eventId: input.eventId,
      assignmentId: input.assignmentId,
      personId: input.personId,
      channel: input.channel,
      scheduledFor: new Date(),
      status: input.approved ? "PLANNED" : "WAITING_FOR_APPROVAL",
      reason: `Manual message from ${admin.name}`,
      messagePreview: input.text,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (input.approved && action.status === "PLANNED") {
    await actionsQueue.add("send", { actionId: action.id }, { jobId: input.idempotencyKey.replaceAll(":", "-") });
    await db.plannedAction.update({ where: { id: action.id }, data: { status: "QUEUED", jobQueueId: input.idempotencyKey } });
  }
  await audit(input.adminId, "MANUAL_MESSAGE_CREATED", "PlannedAction", action.id, undefined, { personId: person.id, channel: input.channel, approved: input.approved }, input.idempotencyKey);
  return action;
}

export async function sendPlannedCommunicationNow(adminId: string, actionId: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "communications:send");
  if (!await claimAction(idempotencyKey, adminId)) return db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  const before = await db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  const action = await db.plannedAction.update({
    where: { id: actionId },
    data: { status: "QUEUED", scheduledFor: new Date(), lastError: null, jobQueueId: idempotencyKey },
  });
  await actionsQueue.add("send", { actionId }, { jobId: idempotencyKey.replaceAll(":", "-") });
  await audit(adminId, "PLANNED_COMMUNICATION_SEND_NOW", "PlannedAction", actionId, { status: before.status, scheduledFor: before.scheduledFor }, { status: action.status, scheduledFor: action.scheduledFor }, idempotencyKey);
  return action;
}

export async function cancelPlannedCommunication(adminId: string, actionId: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "communications:reschedule");
  if (!await claimAction(idempotencyKey, adminId)) return db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  const before = await db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  if (before.status === "PROCESSING") throw new Error("A communication already being processed cannot be canceled.");
  await removeQueuedActionJob(before.jobQueueId, before.idempotencyKey);
  const action = await db.plannedAction.update({
    where: { id: actionId },
    data: { status: "CANCELED", canceledAt: new Date(), lastError: `Canceled by ${admin.name}` },
  });
  await audit(adminId, "PLANNED_COMMUNICATION_CANCELED", "PlannedAction", actionId, { status: before.status, scheduledFor: before.scheduledFor }, { status: action.status }, idempotencyKey);
  return action;
}

export async function reschedulePlannedCommunication(adminId: string, actionId: string, scheduledFor: Date, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "communications:reschedule");
  if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor <= new Date()) throw new Error("Choose a valid future time.");
  if (!await claimAction(idempotencyKey, adminId)) return db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  const before = await db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  if (before.status === "PROCESSING") throw new Error("A communication already being processed cannot be rescheduled.");
  await removeQueuedActionJob(before.jobQueueId, before.idempotencyKey);
  const action = await db.plannedAction.update({
    where: { id: actionId },
    data: { status: "PLANNED", scheduledFor, canceledAt: null, lastError: null, jobQueueId: null },
  });
  await audit(adminId, "PLANNED_COMMUNICATION_RESCHEDULED", "PlannedAction", actionId, { status: before.status, scheduledFor: before.scheduledFor }, { status: action.status, scheduledFor }, idempotencyKey);
  return action;
}

export async function skipPlannedReminder(adminId: string, actionId: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "communications:reschedule");
  if (!await claimAction(idempotencyKey, adminId)) return db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  const before = await db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  await removeQueuedActionJob(before.jobQueueId, before.idempotencyKey);
  await skipReminderAction(actionId);
  const action = await db.plannedAction.findUniqueOrThrow({ where: { id: actionId } });
  await audit(adminId, "PLANNED_REMINDER_SKIPPED", "PlannedAction", actionId, { status: before.status, scheduledFor: before.scheduledFor }, { status: action.status }, idempotencyKey);
  return action;
}

export async function resendAssignmentReminder(adminId: string, assignmentId: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "communications:send");
  const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { person: true, event: true } });
  const latest = await db.plannedAction.findFirst({ where: { assignmentId, type: { in: ["REMINDER", "ESCALATE"] } }, orderBy: { createdAt: "desc" } });
  const channel = latest?.channel ?? (assignment.person.email ? "EMAIL" : "SMS");
  const text = latest?.messagePreview ?? `Authentic Moments reminder: please confirm your ${assignment.role.toLowerCase()} assignment for ${assignment.event.name} on ${assignment.event.startsAt.toLocaleDateString()}. [secure confirmation link]`;
  const action = await db.plannedAction.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      type: "REMINDER",
      eventId: assignment.eventId,
      assignmentId,
      personId: assignment.personId,
      channel: channel as "EMAIL" | "SMS",
      scheduledFor: new Date(),
      status: "PLANNED",
      reason: `Manual reminder resend by ${admin.name}`,
      messagePreview: text,
      idempotencyKey,
    },
  });
  if (action.status === "PLANNED") {
    await actionsQueue.add("send", { actionId: action.id }, { jobId: idempotencyKey.replaceAll(":", "-") });
    await db.plannedAction.update({ where: { id: action.id }, data: { status: "QUEUED", jobQueueId: idempotencyKey } });
  }
  await audit(adminId, "ASSIGNMENT_REMINDER_RESENT", "Assignment", assignmentId, undefined, { channel }, idempotencyKey);
  return action;
}

export async function markAssignmentStatus(adminId: string, assignmentId: string, status: "CONFIRMED" | "DECLINED", idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "assignments:status");
  if (!await claimAction(idempotencyKey, adminId)) return db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
  const before = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
  const now = new Date();
  const assignment = await db.assignment.update({
    where: { id: assignmentId },
    data: status === "CONFIRMED"
      ? { confirmationStatus: "CONFIRMED", confirmedAt: now, declinedAt: null, needsAttention: false, confirmationChannel: "SYSTEM" }
      : { confirmationStatus: "DECLINED", declinedAt: now, confirmedAt: null, needsAttention: true, confirmationChannel: "SYSTEM" },
  });
  await db.plannedAction.updateMany({ where: { assignmentId, status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] } }, data: { status: "CANCELED", canceledAt: now } });
  await audit(adminId, `ASSIGNMENT_${status}_BY_PROJECT_MANAGER`, "Assignment", assignmentId, { confirmationStatus: before.confirmationStatus }, { confirmationStatus: status }, idempotencyKey);
  await reconcileEventReadiness(assignment.eventId);
  return assignment;
}

export async function resolveOperationalAlert(adminId: string, alertId: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "alerts:resolve");
  if (!await claimAction(idempotencyKey, adminId)) return db.operationalAlert.findUniqueOrThrow({ where: { id: alertId } });
  const before = await db.operationalAlert.findUniqueOrThrow({ where: { id: alertId } });
  const alert = await db.operationalAlert.update({ where: { id: alertId }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: adminId } });
  await audit(adminId, "OPERATIONAL_ALERT_RESOLVED", "OperationalAlert", alertId, { status: before.status }, { status: alert.status }, idempotencyKey);
  return alert;
}

export async function updatePersonContact(adminId: string, personId: string, input: { email?: string; phone?: string }, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "contacts:edit");
  if (!await claimAction(idempotencyKey, adminId)) return db.person.findUniqueOrThrow({ where: { id: personId } });
  const before = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const email = input.email?.trim().toLowerCase() || null;
  const phoneInput = input.phone?.trim();
  const parsedPhone = phoneInput ? parsePhoneNumberFromString(phoneInput, "US") : undefined;
  if (phoneInput && (!parsedPhone || !parsedPhone.isValid())) throw new Error("Enter a valid phone number.");
  const phone = parsedPhone?.number ?? null;
  const person = await db.person.update({ where: { id: personId }, data: { email, normalizedEmail: email, phone, emailEligible: Boolean(email), smsEligible: Boolean(phone) } });
  await audit(adminId, "PERSON_CONTACT_UPDATED", "Person", personId, { email: before.email, phone: before.phone }, { email, phone }, idempotencyKey);
  return person;
}

export async function replaceAssignment(adminId: string, assignmentId: string, replacementPersonId: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "assignments:edit");
  if (!await claimAction(idempotencyKey, adminId)) return;
  const original = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
  await db.assignment.update({ where: { id: assignmentId }, data: { active: false, paused: true, confirmationStatus: "CANCELED", needsAttention: true } });
  await db.plannedAction.updateMany({
    where: { assignmentId, status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] } },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
  const replacement = await db.assignment.upsert({
    where: { eventId_personId_role: { eventId: original.eventId, personId: replacementPersonId, role: original.role } },
    update: { active: true, paused: false, source: "OVERRIDE", confirmationStatus: "PENDING" },
    create: { eventId: original.eventId, personId: replacementPersonId, role: original.role, source: "OVERRIDE", confirmationStatus: "PENDING" },
  });
  await planAssignmentReminders(replacement.id);
  await audit(adminId, "ASSIGNMENT_REPLACED", "Assignment", replacement.id, { originalAssignmentId: assignmentId, personId: original.personId }, { replacementPersonId }, idempotencyKey);
  await reconcileEventReadiness(original.eventId);
  return replacement;
}

export async function createManualAssignment(
  adminId: string,
  eventId: string,
  personId: string,
  role: AssignmentRole,
  idempotencyKey: string,
) {
  const admin = await administrator(adminId);
  assertPermission(admin, "assignments:edit");
  if (!await claimAction(idempotencyKey, adminId)) {
    return db.assignment.findUnique({ where: { eventId_personId_role: { eventId, personId, role } } });
  }
  const assignment = await db.assignment.upsert({
    where: { eventId_personId_role: { eventId, personId, role } },
    update: { active: true, paused: false, source: "OVERRIDE", confirmationStatus: "PENDING", needsAttention: false },
    create: { eventId, personId, role, source: "OVERRIDE", confirmationStatus: "PENDING" },
  });
  await planAssignmentReminders(assignment.id);
  await audit(adminId, "MANUAL_ASSIGNMENT_CREATED", "Assignment", assignment.id, undefined, { eventId, personId, role }, idempotencyKey);
  await reconcileEventReadiness(eventId);
  return assignment;
}

export async function addOperationalNote(adminId: string, target: "event" | "assignment" | "person", targetId: string, note: string, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "notes:edit");
  if (!await claimAction(idempotencyKey, adminId)) return;
  if (target === "event") await db.event.update({ where: { id: targetId }, data: { internalNotes: note } });
  if (target === "assignment") await db.assignment.update({ where: { id: targetId }, data: { internalNotes: note } });
  if (target === "person") await db.person.update({ where: { id: targetId }, data: { notes: note } });
  await audit(adminId, "INTERNAL_NOTE_UPDATED", target, targetId, undefined, { note }, idempotencyKey);
}

export async function pauseCommunications(adminId: string, target: "event" | "assignment" | "person", targetId: string, paused: boolean, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "communications:pause");
  if (!await claimAction(idempotencyKey, adminId)) return;
  if (target === "event") await db.event.update({ where: { id: targetId }, data: { paused } });
  if (target === "assignment") await db.assignment.update({ where: { id: targetId }, data: { paused } });
  if (target === "person") await db.person.update({ where: { id: targetId }, data: { paused } });
  if (paused) {
    await db.plannedAction.updateMany({
      where: { [target === "event" ? "eventId" : target === "assignment" ? "assignmentId" : "personId"]: targetId, status: { in: ["PLANNED", "QUEUED"] } },
      data: { status: "SUPPRESSED", lastError: `Communications paused by ${admin.name}` },
    });
  }
  await audit(adminId, paused ? "COMMUNICATIONS_PAUSED" : "COMMUNICATIONS_RESUMED", target, targetId, undefined, { paused }, idempotencyKey);
}

export async function upsertManualMilestone(input: {
  adminId: string;
  eventId: string;
  name: string;
  dueAt?: Date;
  critical: boolean;
  completed: boolean;
  idempotencyKey: string;
}) {
  const admin = await administrator(input.adminId);
  assertPermission(admin, "assignments:edit");
  if (!await claimAction(input.idempotencyKey, input.adminId)) return;
  const event = await db.event.findUniqueOrThrow({ where: { id: input.eventId } });
  const task = await db.operationalTask.create({
    data: {
      provider: "AMM_ROBOT",
      source: "MANUAL_PROJECT_MANAGER",
      eventId: event.id,
      vscoJobId: event.vscoJobId,
      name: input.name,
      dueAt: input.dueAt,
      completedAt: input.completed ? new Date() : null,
      status: input.completed ? "COMPLETED" : input.dueAt && input.dueAt < new Date() ? "OVERDUE" : "OPEN",
      criticalForReadiness: input.critical,
      assignedLocalAdministratorId: input.adminId,
    },
  });
  await audit(input.adminId, "MANUAL_MILESTONE_CREATED", "OperationalTask", task.id, undefined, { name: task.name, critical: task.criticalForReadiness }, input.idempotencyKey);
  await reconcileEventReadiness(event.id);
  return task;
}

export async function setOperationalTaskCompleted(adminId: string, taskId: string, completed: boolean, idempotencyKey: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "assignments:edit");
  if (!await claimAction(idempotencyKey, adminId)) return db.operationalTask.findUniqueOrThrow({ where: { id: taskId } });
  const before = await db.operationalTask.findUniqueOrThrow({ where: { id: taskId } });
  const task = await db.operationalTask.update({
    where: { id: taskId },
    data: { status: completed ? "COMPLETED" : "OPEN", completedAt: completed ? new Date() : null },
  });
  await audit(adminId, completed ? "OPERATIONAL_TASK_COMPLETED" : "OPERATIONAL_TASK_REOPENED", "OperationalTask", taskId, { status: before.status }, { status: task.status }, idempotencyKey);
  if (task.eventId) await reconcileEventReadiness(task.eventId);
  return task;
}

export { projectManagerToolNames };

export async function answerProjectManagerQuestion(adminId: string, question: string) {
  const admin = await administrator(adminId);
  assertPermission(admin, "agent:use");
  let answer: string;
  const tool = classifyProjectManagerQuestion(question);
  if (tool === "list_events_needing_attention") {
    const events = await listEventsNeedingAttention();
    answer = events.length ? events.slice(0, 15).map(event => `${event.name} — ${event.startsAt.toLocaleDateString()} — ${event.readinessStatus.replaceAll("_", " ").toLowerCase()}: ${(event.readinessReasons as string[] | null)?.join("; ") ?? "Review required"}`).join("\n") : "No upcoming events currently need project-manager attention.";
  } else if (tool === "list_ready_events") {
    const now = new Date();
    let from = now;
    let to = new Date(Date.now() + 30 * 86400000);
    if (/weekend/i.test(question)) {
      const day = now.getDay();
      const daysToSaturday = (6 - day + 7) % 7;
      from = new Date(now);
      from.setDate(now.getDate() + daysToSaturday);
      from.setHours(0, 0, 0, 0);
      to = new Date(from);
      to.setDate(from.getDate() + 1);
      to.setHours(23, 59, 59, 999);
    }
    const events = await listReadyEvents(from, to);
    answer = events.length ? events.map(event => `${event.name} — ${event.startsAt.toLocaleDateString()}`).join("\n") : "No matching ready events were found.";
  } else if (tool === "get_event_readiness") {
    const events = await db.event.findMany({
      where: { startsAt: { gte: new Date() }, canceled: false },
      orderBy: { startsAt: "asc" },
      take: 100,
    });
    const ignored = new Set(["is", "the", "wedding", "event", "fully", "staffed", "ready", "readiness", "of"]);
    const terms = question.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(term => term.length > 2 && !ignored.has(term));
    const matches = events.filter(event => terms.some(term => event.name.toLowerCase().includes(term)));
    if (matches.length === 1) {
      const event = matches[0];
      const eventReasons = Array.isArray(event.readinessReasons) ? event.readinessReasons.map(String) : [];
      answer = `${event.name} — ${event.readinessStatus.replaceAll("_", " ").toLowerCase()}${eventReasons.length ? `\n${eventReasons.map(reason => `- ${reason}`).join("\n")}` : "\nNo readiness blockers."}`;
    } else if (matches.length > 1) {
      answer = `I found multiple matching events. Please use the full event name:\n${matches.slice(0, 10).map(event => `- ${event.name} — ${event.startsAt.toLocaleDateString()}`).join("\n")}`;
    } else answer = "I could not find an upcoming event matching that name.";
  } else if (tool === "list_unconfirmed_assignments") {
    const assignments = await listUnconfirmedAssignments();
    answer = assignments.length ? assignments.slice(0, 25).map(item => `${item.person.displayName} — ${item.event.name} — ${item.event.startsAt.toLocaleDateString()} — ${item.confirmationStatus.toLowerCase()}`).join("\n") : "All matching assignments are confirmed.";
  } else if (tool === "list_unfilled_roles") {
    const alerts = await listUnfilledRoles();
    answer = alerts.length ? alerts.map(item => `${item.event?.name ?? "Event"}: ${item.reason}`).join("\n") : "No required roles are currently unfilled.";
  } else if (tool === "get_overdue_tasks") {
    const tasks = await getOverdueTasks();
    answer = tasks.length ? tasks.map(item => `${item.event?.name ?? "Unlinked"}: ${item.name}`).join("\n") : "No operational tasks are overdue.";
  } else if (tool === "list_upcoming_planned_actions") {
    const start = new Date(); const end = new Date(Date.now() + 2 * 86400000);
    const actions = await listUpcomingPlannedActions(start, end);
    answer = actions.length ? actions.map(item => `${item.scheduledFor.toLocaleString()} — ${item.person?.displayName ?? "System"} — ${item.event?.name ?? item.reason}`).join("\n") : "No reminders are scheduled in the requested window.";
  } else if (tool === "list_recent_declines") {
    const assignments = await listRecentDeclines();
    answer = assignments.length ? assignments.map(item => `${item.person.displayName} — ${item.event.name}`).join("\n") : "No recent declines were found.";
  } else if (tool === "list_delivery_failures") {
    const failures = await listDeliveryFailures();
    answer = failures.length ? failures.map(item => `${item.person.displayName} — ${item.channel} — ${item.failureReason ?? item.deliveryStatus}`).join("\n") : "No recent delivery failures were found.";
  } else if (tool === "list_recent_changes") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const changes = await db.eventChange.findMany({
      where: { createdAt: { gte: start } },
      include: { event: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    answer = changes.length
      ? changes.map(change => `${change.event.name} — ${change.field}: ${String(change.oldValue ?? "—")} → ${String(change.newValue ?? "—")}`).join("\n")
      : "No VSCO event or assignment changes were recorded today.";
  } else {
    answer = "I can answer operational questions about readiness, unconfirmed assignments, missing roles, recent declines, delivery failures, upcoming reminders, and overdue tasks. Consequential changes must be confirmed with the controls on the Operations page.";
  }
  await db.agentRun.create({ data: { model: "deterministic-project-manager-tools", redactedInput: { adminId, question }, redactedOutput: { answer }, toolCalls: [{ name: tool === "help" ? "none" : tool }], status: "COMPLETED" } });
  return answer;
}
