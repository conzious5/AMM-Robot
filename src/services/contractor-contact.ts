import { db } from "@/lib/db";
import { planAssignmentReminders } from "@/lib/reminders";
import { notifyProjectManagers } from "@/services/project-manager";

export async function reconcileContractorSmsOptOut(personId: string, notify = false) {
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const key = `contractor-sms-opt-out:${personId}`;
  if (person.smsEligible) {
    await db.operationalAlert.updateMany({ where: { deduplicationKey: key, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    return;
  }
  const reason = `${person.displayName} has stopped SMS reminders. Personal follow-up is required; assignments remain booked.`;
  const previous = await db.operationalAlert.findUnique({ where: { deduplicationKey: key }, select: { status: true } });
  const alert = await db.operationalAlert.upsert({
    where: { deduplicationKey: key },
    update: { status: "OPEN", resolvedAt: null, lastSeenAt: new Date(), reason, ...(previous && previous.status !== "OPEN" ? { firstSeenAt: new Date() } : {}) },
    create: { personId, type: "CONTRACTOR_SMS_OPT_OUT", severity: "CRITICAL", reason, recommendedAction: "Contact the contractor personally to resolve reminder communications. Email reminders continue when available; do not treat STOP as an assignment cancellation.", deduplicationKey: key },
  });
  const assignments = await db.assignment.findMany({ where: { personId, active: true, event: { canceled: false, startsAt: { gt: new Date() } } }, select: { id: true } });
  for (const assignment of assignments) await planAssignmentReminders(assignment.id);
  if (notify) await notifyProjectManagers({ includeAdministrators: true, type: "CONTRACTOR_SMS_OPT_OUT", subject: `Urgent: ${person.displayName} stopped SMS reminders`, body: `${reason}\n\nPlease contact them personally. This has not canceled or confirmed any assignment. Email reminders remain enabled where available.`, deduplicationKey: `${key}:${alert.firstSeenAt.toISOString()}` });
}
