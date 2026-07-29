import { addMinutes, isBefore } from "date-fns";
import { db } from "./db";
import { nextAllowedTime } from "./quiet-hours";

export async function planAssignmentReminders(assignmentId: string, now = new Date()) {
  const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { event: true, person: true } });
  if (!assignment.active || assignment.event.canceled || assignment.person.paused || assignment.paused || assignment.event.paused) return [];
  const policies = await db.reminderPolicy.findMany({ where: { active: true, OR: [{ roleFilter: null }, { roleFilter: assignment.role }] }, orderBy: { attemptNumber: "asc" } });
  const created = [];
  for (const policy of policies) {
    let when = addMinutes(assignment.event.startsAt, -policy.offsetMinutes);
    if (isBefore(when, now) && policy.attemptNumber === 1 && isBefore(now, assignment.event.startsAt)) when = addMinutes(now, 5);
    if (isBefore(when, now) || isBefore(assignment.event.startsAt, now)) continue;
    if (policy.honorQuietHours) when = nextAllowedTime(when, assignment.person.timezone);
    const key = `reminder:${assignment.id}:${policy.id}`;
    const preview = policy.messageTemplate
      .replaceAll("{{firstName}}", assignment.person.firstName).replaceAll("{{role}}", assignment.role.toLowerCase())
      .replaceAll("{{eventName}}", assignment.event.name).replaceAll("{{eventDate}}", assignment.event.startsAt.toLocaleDateString("en-US", { timeZone: assignment.event.timezone, dateStyle: "long" }))
      .replaceAll("{{venueName}}", assignment.event.venueName ?? "venue details pending").replaceAll("{{confirmationUrl}}", "[secure confirmation link]");
    const action = await db.plannedAction.upsert({
      where: { idempotencyKey: key }, update: { scheduledFor: when, messagePreview: preview, status: "PLANNED" },
      create: { type: policy.escalate ? "ESCALATE" : "REMINDER", eventId: assignment.eventId, assignmentId: assignment.id, personId: assignment.personId, channel: policy.channel, scheduledFor: when, reason: policy.name, messagePreview: preview, subjectPreview: policy.subjectTemplate, idempotencyKey: key },
    });
    created.push(action);
  }
  return created;
}
