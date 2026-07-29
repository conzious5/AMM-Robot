import { ConfirmationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { reconcileEventReadiness } from "@/services/readiness";

const confirmWords = /^(confirm|confirmed|yes|yep|i(?:'|’)ll be there)[.! ]*$/i;
const declineWords = /^(decline|cannot work|can't work|no)[.! ]*$/i;
const financialWords = /\b(pay|paid|payment|rate|rates|compensation|invoice|billing|price|pricing|cost|fee|fees|money|financial|contract amount|1099|tax)\b/i;
const standardPayWords = /\b(pay|paid|rate|rates|compensation|additional hours?|extra hours?|mileage|miles?|travel reimbursement)\b/i;

export const helpMenu = "Authentic Moments contractor help:\nCONFIRM — confirm your next assignment\nSCHEDULE — upcoming ceremony dates\nDETAILS — role, date, venue, and times\nLOCATION — venue and address\nHOURS — available start/end times\nPAY — standard rates and mileage policy\nHELP — show this menu\nYou can also ask a question in your own words. Reply STOP to opt out.";
export const isFinancialQuestion = (text: string) => financialWords.test(text);
export const isStandardPayQuestion = (text: string) => standardPayWords.test(text);
export const standardPayReply = (text = "") => {
  const mileage = text.match(/\b(\d+(?:\.\d+)?)\s*(?:total\s*)?miles?\b/i);
  const calculation = mileage
    ? `\nFor ${Number(mileage[1]).toLocaleString("en-US")} total trip miles: (miles - 120) × $0.68 = $${(Math.max(0, Number(mileage[1]) - 120) * 0.68).toFixed(2)}.`
    : "";
  return `Authentic Moments standard contractor rates:\n8 hours — $950\n6 hours — $750\n3 hours — $450\n1 hour — $350\nAdditional hours — $125/hour\nTravel: $0.68/mile for total trip mileage over 120 miles; reimbursement is (total trip miles - 120) × $0.68.${calculation}\nThis number cannot access individual payouts, invoices, client pricing, or contract amounts.`;
};
export type Intent = "CONFIRM" | "DECLINE" | "STOP" | "START" | "HELP" | "SCHEDULE" | "DETAILS" | "LOCATION" | "HOURS" | "PAY" | "FINANCIAL" | "NATURAL_LANGUAGE";
export const deterministicIntent = (text: string): Intent => {
  const value = text.trim();
  if (/^stop$/i.test(value)) return "STOP";
  if (/^start$/i.test(value)) return "START";
  if (/^pay$/i.test(value) || isStandardPayQuestion(value)) return "PAY";
  if (isFinancialQuestion(value)) return "FINANCIAL";
  if (/^(help|menu|options)$/i.test(value)) return "HELP";
  if (/\b(detail|details|assignment info|event info|ceremony info)\b/i.test(value)) return "DETAILS";
  if (/\b(schedule|upcoming|next (wedding|event|ceremony)|what (weddings|events|ceremonies))\b/i.test(value)) return "SCHEDULE";
  if (/\b(location|venue|address|where)\b/i.test(value)) return "LOCATION";
  if (/\b(hours|start time|end time|what time|call time|when (does|is))\b/i.test(value)) return "HOURS";
  if (confirmWords.test(value)) return "CONFIRM";
  if (declineWords.test(value)) return "DECLINE";
  return "NATURAL_LANGUAGE";
};
export async function handleDeterministic(personId: string, text: string, channel: "EMAIL" | "SMS") {
  const intent = deterministicIntent(text);
  if (intent === "STOP") { await db.person.update({ where: { id: personId }, data: { smsEligible: false } }); return "You have been opted out of Authentic Moments text messages. Reply START to opt back in."; }
  if (intent === "START") { await db.person.update({ where: { id: personId }, data: { smsEligible: true } }); return "You are opted back in to Authentic Moments scheduling messages."; }
  if (intent === "HELP") return helpMenu;
  if (intent === "PAY") return standardPayReply(text);
  if (intent === "FINANCIAL") return "For privacy and security, this number can only share Authentic Moments' published standard contractor rates and mileage policy. It cannot access individual payouts, invoices, client pricing, billing, taxes, or contract amounts. Reply PAY for the standard rate card.";
  if (["SCHEDULE", "DETAILS", "LOCATION", "HOURS"].includes(intent)) {
    const assignments = await db.assignment.findMany({
      where: { personId, active: true, event: { startsAt: { gt: new Date() }, canceled: false } },
      include: { event: true },
      orderBy: { event: { startsAt: "asc" } },
      take: intent === "SCHEDULE" ? 5 : 1,
    });
    if (!assignments.length) return "I could not find an upcoming active ceremony assignment for you.";
    if (intent === "SCHEDULE") {
      return assignments.map(assignment =>
        `${assignment.event.name}: ${formatDateTime(assignment.event.startsAt, assignment.event.timezone)} (${assignment.role.toLowerCase()})`
      ).join("\n");
    }
    const assignment = assignments[0]!;
    if (intent === "DETAILS") {
      const location = [assignment.event.venueName, assignment.event.address].filter(Boolean).join(", ") || "location not available in VSCO";
      const end = assignment.event.endsAt ? formatDateTime(assignment.event.endsAt, assignment.event.timezone) : "end time not available in VSCO";
      return `${assignment.event.name}\nRole: ${assignment.role.toLowerCase()}\nStart: ${formatDateTime(assignment.event.startsAt, assignment.event.timezone)}\nEnd: ${end}\nLocation: ${location}\nConfirmation: ${assignment.confirmationStatus.toLowerCase().replaceAll("_", " ")}`;
    }
    if (intent === "LOCATION") {
      const location = [assignment.event.venueName, assignment.event.address].filter(Boolean).join(", ");
      return location
        ? `${assignment.event.name} on ${formatDate(assignment.event.startsAt, assignment.event.timezone)}: ${location}`
        : `Location details for ${assignment.event.name} are not available in VSCO yet.`;
    }
    const start = formatDateTime(assignment.event.startsAt, assignment.event.timezone);
    const end = assignment.event.endsAt ? formatDateTime(assignment.event.endsAt, assignment.event.timezone) : "not available in VSCO";
    return `${assignment.event.name}: start ${start}; end ${end}.`;
  }
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
  await reconcileEventReadiness(assignment.eventId);
  return intent === "CONFIRM" ? `Confirmed — you are set for ${assignment.event.name} on ${assignment.event.startsAt.toLocaleDateString("en-US", { dateStyle: "long", timeZone: assignment.event.timezone })}.` : "Your decline was recorded and an administrator has been alerted.";
}

function formatDate(value: Date, timezone: string) {
  return value.toLocaleDateString("en-US", { dateStyle: "long", timeZone: timezone });
}

function formatDateTime(value: Date, timezone: string) {
  return value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone });
}
