import { ConfirmationStatus } from "@prisma/client";
import { db } from "@/lib/db";

const confirmWords = /^(confirm|confirmed|yes|yep|i(?:'|’)ll be there)[.! ]*$/i;
const declineWords = /^(decline|cannot work|can't work|no)[.! ]*$/i;
export type Intent = "CONFIRM" | "DECLINE" | "STOP" | "START" | "HELP" | "NATURAL_LANGUAGE";
export const deterministicIntent = (text: string): Intent => {
  const value = text.trim();
  if (/^stop$/i.test(value)) return "STOP";
  if (/^start$/i.test(value)) return "START";
  if (/^help$/i.test(value)) return "HELP";
  if (confirmWords.test(value)) return "CONFIRM";
  if (declineWords.test(value)) return "DECLINE";
  return "NATURAL_LANGUAGE";
};
export async function handleDeterministic(personId: string, text: string, channel: "EMAIL" | "SMS") {
  const intent = deterministicIntent(text);
  if (intent === "STOP") { await db.person.update({ where: { id: personId }, data: { smsEligible: false } }); return "You have been opted out of Authentic Moments text messages. Reply START to opt back in."; }
  if (intent === "START") { await db.person.update({ where: { id: personId }, data: { smsEligible: true } }); return "You are opted back in to Authentic Moments scheduling messages."; }
  if (intent === "HELP") return "Authentic Moments scheduling: reply CONFIRM for an assignment, or ask us about your schedule. Reply STOP to opt out.";
  if (!["CONFIRM", "DECLINE"].includes(intent)) return null;
  const pending = await db.assignment.findMany({ where: { personId, active: true, confirmationStatus: { in: [ConfirmationStatus.PENDING, ConfirmationStatus.NEEDS_ATTENTION] }, event: { startsAt: { gt: new Date() }, canceled: false } }, include: { event: true }, orderBy: { event: { startsAt: "asc" } } });
  if (pending.length !== 1) return pending.length ? "Which assignment do you mean? Please reply with the wedding date." : "I could not find an active assignment awaiting your response. An administrator will review this.";
  const assignment = pending[0]!;
  const now = new Date();
  await db.$transaction([
    db.assignment.update({ where: { id: assignment.id }, data: intent === "CONFIRM" ? { confirmationStatus: "CONFIRMED", confirmedAt: now, confirmationChannel: channel } : { confirmationStatus: "DECLINED", declinedAt: now, needsAttention: true, confirmationChannel: channel } }),
    db.plannedAction.updateMany({ where: { assignmentId: assignment.id, status: { in: ["PLANNED", "QUEUED"] } }, data: { status: "CANCELED", canceledAt: now } }),
    db.auditLog.create({ data: { actorType: "CONTRACTOR", actorId: personId, action: intent === "CONFIRM" ? "ASSIGNMENT_CONFIRMED" : "ASSIGNMENT_DECLINED", entityType: "Assignment", entityId: assignment.id, metadata: { channel } } }),
  ]);
  return intent === "CONFIRM" ? `Confirmed — you are set for ${assignment.event.name} on ${assignment.event.startsAt.toLocaleDateString("en-US", { dateStyle: "long", timeZone: assignment.event.timezone })}.` : "Your decline was recorded and an administrator has been alerted.";
}
