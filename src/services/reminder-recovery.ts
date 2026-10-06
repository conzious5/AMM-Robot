import { db } from "@/lib/db";
import { planAssignmentReminders } from "@/lib/reminders";
import { eventTitleDateMismatch } from "@/lib/event-date-consistency";

const recoveryKey = "booked-wedding-reminder-recovery-v1";

// Owner-authorized repair of legacy pauses. Only a complete successful VSCO scan
// may repair weddings it actually returned. Later intentional pauses are retained.
export async function recoverBookedWeddingReminders(seenExternalIds: ReadonlySet<string>, now = new Date()) {
  if (await db.setting.findUnique({ where: { key: recoveryKey } })) return;
  const events = await db.event.findMany({
    where: { vscoEventId: { in: [...seenExternalIds] }, canceled: false, startsAt: { gt: now } },
    include: { assignments: { where: { active: true, role: { in: ["PHOTOGRAPHER", "VIDEOGRAPHER"] } }, include: { person: true } } },
  });
  let repaired = 0;
  for (const event of events) {
    if (eventTitleDateMismatch(event.name, event.startsAt, event.timezone)) continue;
    if (event.paused) {
      await db.event.update({ where: { id: event.id }, data: { paused: false } });
      await db.auditLog.create({ data: { actorType: "SYSTEM", action: "BOOKED_WEDDING_REMINDERS_RECOVERED", entityType: "Event", entityId: event.id, before: { paused: true }, after: { paused: false, reason: "Owner requested reminder coverage for booked VSCO weddings" } } });
      repaired++;
    }
    for (const assignment of event.assignments) {
      // Preserve contractor opt-outs, deactivations, declines and confirmations.
      if (!assignment.person.active || assignment.person.paused || ["CONFIRMED", "DECLINED", "CANCELED"].includes(assignment.confirmationStatus)) continue;
      if (assignment.paused) {
        await db.assignment.update({ where: { id: assignment.id }, data: { paused: false } });
        await db.auditLog.create({ data: { actorType: "SYSTEM", action: "BOOKED_ASSIGNMENT_REMINDERS_RECOVERED", entityType: "Assignment", entityId: assignment.id, before: { paused: true }, after: { paused: false } } });
      }
      await planAssignmentReminders(assignment.id, now);
    }
  }
  await db.setting.upsert({ where: { key: recoveryKey }, update: {}, create: { key: recoveryKey, value: { completedAt: now.toISOString(), repairedEvents: repaired } } });
}
