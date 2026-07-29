import { addMinutes, isBefore } from "date-fns";
import { db } from "./db";
import { nextAllowedTime } from "./quiet-hours";

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

export async function planAssignmentReminders(assignmentId: string, now = new Date()) {
  const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { event: true, person: true } });
  if (
    !assignment.active ||
    assignment.confirmationStatus === "CONFIRMED" ||
    assignment.confirmationStatus === "CANCELED" ||
    assignment.event.canceled ||
    assignment.person.paused ||
    assignment.paused ||
    assignment.event.paused
  ) return [];
  const policies = await db.reminderPolicy.findMany({ where: { active: true, OR: [{ roleFilter: null }, { roleFilter: assignment.role }] }, orderBy: { attemptNumber: "asc" } });
  const created = [];
  for (const policy of policies) {
    let when = addMinutes(assignment.event.startsAt, -policy.offsetMinutes);
    if (isBefore(when, now) && policy.attemptNumber === 1 && isBefore(now, assignment.event.startsAt)) when = addMinutes(now, 5);
    if (isBefore(when, now) || isBefore(assignment.event.startsAt, now)) continue;
    if (policy.honorQuietHours) when = nextAllowedTime(when, assignment.person.timezone);
    const key = `reminder:${assignment.id}:${policy.id}`;
    const preview = renderTemplate(policy.messageTemplate, assignment);
    const subject = policy.subjectTemplate ? renderTemplate(policy.subjectTemplate, assignment) : null;
    const action = await db.plannedAction.upsert({
      where: { idempotencyKey: key },
      update: { scheduledFor: when, messagePreview: preview, subjectPreview: subject },
      create: { type: policy.escalate ? "ESCALATE" : "REMINDER", eventId: assignment.eventId, assignmentId: assignment.id, personId: assignment.personId, channel: policy.channel, scheduledFor: when, reason: policy.name, messagePreview: preview, subjectPreview: subject, idempotencyKey: key },
    });
    created.push(action);
  }
  return created;
}
