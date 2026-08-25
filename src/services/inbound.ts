import { ConfirmationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { reconcileEventReadiness } from "@/services/readiness";
import { VscoWorkspaceProvider } from "@/providers/vsco";
import { launchIncludedEventWhere } from "@/lib/launch-cutoff";
import { formatInTimeZone } from "date-fns-tz";

const confirmWords = /^(confirm|confirmed|yes|yep|i(?:'|’)ll be there)[.! ]*$/i;
const declineWords = /^(decline|cannot work|can't work|no)[.! ]*$/i;
const financialWords = /\b(pay|paid|payment|rate|rates|compensation|invoice|billing|price|pricing|cost|fee|fees|money|financial|contract amount|1099|tax)\b/i;
const standardPayWords = /\b(pay|paid|rate|rates|compensation|additional hours?|extra hours?|mileage|miles?|travel reimbursement)\b/i;
const monthNumbers: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

type RequestedEventDate = {
  month: number;
  day: number;
  year?: number;
};

type AssignmentWithEventDate = {
  event: {
    startsAt: Date;
    timezone: string;
  };
};

export function requestedEventDate(text: string): RequestedEventDate | null {
  const named = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
  );
  if (named) {
    const month = monthNumbers[named[1]!.toLowerCase()];
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : undefined;
    if (month && day >= 1 && day <= 31) return { month, day, year };
  }
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!numeric) return null;
  const month = Number(numeric[1]);
  const day = Number(numeric[2]);
  const rawYear = numeric[3] ? Number(numeric[3]) : undefined;
  const year = rawYear && rawYear < 100 ? 2000 + rawYear : rawYear;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day, year };
}

export function selectRequestedAssignment<T extends AssignmentWithEventDate>(
  assignments: T[],
  text: string,
) {
  const requested = requestedEventDate(text);
  if (!requested) return assignments[0] ?? null;
  return assignments.find(assignment => {
    const month = Number(formatInTimeZone(assignment.event.startsAt, assignment.event.timezone, "M"));
    const day = Number(formatInTimeZone(assignment.event.startsAt, assignment.event.timezone, "d"));
    const year = Number(formatInTimeZone(assignment.event.startsAt, assignment.event.timezone, "yyyy"));
    return month === requested.month &&
      day === requested.day &&
      (requested.year === undefined || year === requested.year);
  }) ?? null;
}

export const helpMenu = "Authentic Moments contractor help:\nCONFIRM — confirm your next assignment\nSCHEDULE — upcoming ceremony dates\nDETAILS — role, date, venue, times, and timeline link\nTIMELINE — latest timeline or day sheet\nLOCATION — venue and address\nHOURS — available start/end times\nPAY — standard rates and mileage policy\nHELP — show this menu\nFor a free-form scheduling question, begin the message with ROBOT:. Other messages are left for a person to answer. Reply STOP to opt out.";
export const isFinancialQuestion = (text: string) => financialWords.test(text);
export const isStandardPayQuestion = (text: string) => standardPayWords.test(text);
export const standardPayReply = (text = "") => {
  const mileage = text.match(/\b(\d+(?:\.\d+)?)\s*(?:total\s*)?miles?\b/i);
  const calculation = mileage
    ? `\nFor ${Number(mileage[1]).toLocaleString("en-US")} total trip miles: (miles - 120) × $0.68 = $${(Math.max(0, Number(mileage[1]) - 120) * 0.68).toFixed(2)}.`
    : "";
  return `Authentic Moments standard contractor rates:\n8 hours — $950\n6 hours — $750\n3 hours — $450\n1 hour — $350\nAdditional hours — $125/hour\nTravel: $0.68/mile for total trip mileage over 120 miles; reimbursement is (total trip miles - 120) × $0.68.${calculation}\nThis number cannot access individual payouts, invoices, client pricing, or contract amounts.`;
};
export type Intent = "CONFIRM" | "DECLINE" | "STOP" | "START" | "HELP" | "SCHEDULE" | "DETAILS" | "TIMELINE" | "LOCATION" | "HOURS" | "PAY" | "FINANCIAL" | "NATURAL_LANGUAGE";
export const deterministicIntent = (text: string): Intent => {
  const value = text.trim();
  if (/^stop$/i.test(value)) return "STOP";
  if (/^start$/i.test(value)) return "START";
  if (/^pay$/i.test(value) || isStandardPayQuestion(value)) return "PAY";
  if (isFinancialQuestion(value)) return "FINANCIAL";
  if (/^(help|menu|options)$/i.test(value)) return "HELP";
  if (/\b(timeline|day[\s_-]*sheet)\b/i.test(value)) return "TIMELINE";
  if (/\b(detail|details|assignment info|event info|ceremony info)\b/i.test(value)) return "DETAILS";
  if (/\b(schedule|upcoming|next (wedding|event|ceremony)|what (weddings|events|ceremonies))\b/i.test(value)) return "SCHEDULE";
  if (/\b(location|venue|address|where)\b/i.test(value)) return "LOCATION";
  if (/\b(hours|start time|end time|what time|call time|when (does|is))\b/i.test(value)) return "HOURS";
  if (confirmWords.test(value)) return "CONFIRM";
  if (declineWords.test(value)) return "DECLINE";
  return "NATURAL_LANGUAGE";
};

const robotCommand = /^(STOP|START|CONFIRM|DECLINE|HELP|MENU|OPTIONS|SCHEDULE|DETAILS|TIMELINE|LOCATION|HOURS|PAY)\b(.*)$/i;
const robotInvocation = /^(?:(?:AMM|AUTHENTIC MOMENTS)\s+)?ROBOT\b[\s:,-]*(.*)$/i;

export function explicitlyInvokesRobot(text: string) {
  return robotInvocation.test(text.trim());
}

/**
 * The Quo number is also a normal company phone line. Only published commands
 * (optionally followed by an event date) or an explicit ROBOT: invocation are
 * automation requests. Everything else must remain a human conversation.
 */
export function inboundAutomationText(text: string) {
  const value = text.trim();
  const invoked = value.match(robotInvocation);
  if (invoked) return invoked[1]?.trim() || "HELP";

  const command = value.match(robotCommand);
  if (!command) return null;
  const tail = command[2]?.replace(/^[\s:,-]+/, "").replace(/[?!.]+$/, "").trim() ?? "";
  if (!tail) return command[1]!.toUpperCase();

  // A date is the only unprefixed context accepted after a command. This
  // supports messages such as "DETAILS 8/29" without treating ordinary texts
  // that happen to begin with a command-like word as robot requests.
  const dateAwareCommands = new Set(["DETAILS", "TIMELINE", "LOCATION", "HOURS"]);
  return dateAwareCommands.has(command[1]!.toUpperCase()) && requestedEventDate(tail) ? value : null;
}
export async function handleDeterministic(personId: string, text: string, channel: "EMAIL" | "SMS") {
  const intent = deterministicIntent(text);
  if (intent === "STOP") { await db.person.update({ where: { id: personId }, data: { smsEligible: false } }); return "You have been opted out of Authentic Moments text messages. Reply START to opt back in."; }
  if (intent === "START") { await db.person.update({ where: { id: personId }, data: { smsEligible: true } }); return "You are opted back in to Authentic Moments scheduling messages."; }
  if (intent === "HELP") return helpMenu;
  if (intent === "PAY") return standardPayReply(text);
  if (intent === "FINANCIAL") return "For privacy and security, this number can only share Authentic Moments' published standard contractor rates and mileage policy. It cannot access individual payouts, invoices, client pricing, billing, taxes, or contract amounts. Reply PAY for the standard rate card.";
  if (["SCHEDULE", "DETAILS", "TIMELINE", "LOCATION", "HOURS"].includes(intent)) {
    const assignments = await db.assignment.findMany({
      where: {
        personId,
        active: true,
        event: {
          startsAt: { gt: new Date() },
          canceled: false,
          ...launchIncludedEventWhere,
        },
      },
      include: { event: true },
      orderBy: { event: { startsAt: "asc" } },
      take: intent === "SCHEDULE" ? 5 : 10,
    });
    if (!assignments.length) return "I could not find an upcoming active ceremony assignment for you.";
    if (intent === "SCHEDULE") {
      return assignments.map(assignment =>
        `${assignment.event.name}: ${formatDateTime(assignment.event.startsAt, assignment.event.timezone)} (${assignment.role.toLowerCase()})`
      ).join("\n");
    }
    const assignment = selectRequestedAssignment(assignments, text);
    if (!assignment) {
      const requested = requestedEventDate(text);
      const label = requested
        ? `${new Date(2000, requested.month - 1, requested.day).toLocaleDateString("en-US", { month: "long", day: "numeric" })}${requested.year ? `, ${requested.year}` : ""}`
        : "that date";
      return `I could not find an upcoming active ceremony assignment for ${label}.`;
    }
    if (intent === "TIMELINE") {
      const timeline = await timelineReply(assignment.event.vscoJobId, assignment.event.name);
      if (timeline.unavailable) return "Timeline lookup is temporarily unavailable. Please try again later.";
      return timeline.reply ?? `No timeline or day sheet is available in VSCO yet for ${assignment.event.name}.`;
    }
    if (intent === "DETAILS") {
      const location = [assignment.event.venueName, assignment.event.address].filter(Boolean).join(", ") || "location not available in VSCO";
      const end = assignment.event.endsAt ? formatDateTime(assignment.event.endsAt, assignment.event.timezone) : "end time not available in VSCO";
      const timeline = await timelineReply(assignment.event.vscoJobId, assignment.event.name);
      return `${assignment.event.name}\nRole: ${assignment.role.toLowerCase()}\nStart: ${formatDateTime(assignment.event.startsAt, assignment.event.timezone)}\nEnd: ${end}\nLocation: ${location}\nConfirmation: ${assignment.confirmationStatus.toLowerCase().replaceAll("_", " ")}${timeline.reply ? `\n${timeline.reply}` : ""}`;
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
  const pending = await db.assignment.findMany({ where: { personId, active: true, confirmationStatus: { in: [ConfirmationStatus.PENDING, ConfirmationStatus.NEEDS_ATTENTION] }, event: { startsAt: { gt: new Date() }, canceled: false, ...launchIncludedEventWhere } }, include: { event: true }, orderBy: { event: { startsAt: "asc" } } });
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

async function timelineReply(vscoJobId: string | null, eventName: string) {
  if (!vscoJobId) return { reply: null, unavailable: false };
  try {
    const files = await new VscoWorkspaceProvider().timelineFiles(vscoJobId);
    const file = files[0];
    return { reply: file ? `Timeline for ${eventName}: ${file.url}` : null, unavailable: false };
  } catch (error) {
    log.warn({ error, vscoJobId }, "Timeline lookup failed");
    return { reply: null, unavailable: true };
  }
}

function formatDate(value: Date, timezone: string) {
  return value.toLocaleDateString("en-US", { dateStyle: "long", timeZone: timezone });
}

function formatDateTime(value: Date, timezone: string) {
  return value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone });
}
