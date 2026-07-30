import OpenAI from "openai";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  isFinancialQuestion,
  isStandardPayQuestion,
  requestedEventDate,
  selectRequestedAssignment,
  standardPayReply,
} from "@/services/inbound";
import { launchIncludedEventWhere } from "@/lib/launch-cutoff";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SAFE_SCHEDULE_FALLBACK = "I couldn't safely match that question to an active assignment. Reply with the wedding date and DETAILS, TIMELINE, LOCATION, or HOURS.";

type ScheduleToolArgs = { start: string; end: string };
type GroundedAssignment = {
  id: string;
  role: string;
  confirmationStatus: string;
  event: {
    name: string;
    startsAt: Date;
    endsAt: Date | null;
    timezone: string;
    venueName: string | null;
    address: string | null;
  };
};

export function safeScheduleRange(args: ScheduleToolArgs, now = new Date()) {
  const requestedStart = new Date(args.start);
  const requestedEnd = new Date(args.end);
  if (
    !Number.isFinite(requestedStart.getTime())
    || !Number.isFinite(requestedEnd.getTime())
    || requestedStart > requestedEnd
  ) return null;

  const latestAllowed = new Date(now.getTime() + 366 * DAY_MS);
  const start = requestedStart < now ? now : requestedStart;
  const end = requestedEnd > latestAllowed ? latestAllowed : requestedEnd;
  if (start > end) return null;
  return { start, end };
}

export function renderGroundedScheduleReply(assignments: GroundedAssignment[]) {
  if (!assignments.length) return "I could not find an active upcoming assignment matching that question. Reply with the wedding date if you want me to check a specific event.";

  const lines = assignments.map((assignment, index) => {
    const { event } = assignment;
    const when = formatInTimeZone(event.startsAt, event.timezone, "MMM d, yyyy 'at' h:mm a zzz");
    const location = [event.venueName, event.address].filter(Boolean).join(", ") || "location not recorded";
    const prefix = assignments.length > 1 ? `${index + 1}. ` : "";
    return `${prefix}${event.name} — ${when}; ${assignment.role.toLowerCase()}; ${assignment.confirmationStatus.toLowerCase().replaceAll("_", " ")}; ${location}.`;
  });
  return lines.join("\n");
}

export async function getPersonSchedule(personId: string, start: Date, end: Date, limit: number | null = 5) {
  return db.assignment.findMany({
    where: {
      personId,
      active: true,
      event: {
        startsAt: { gte: start, lte: end },
        canceled: false,
        ...launchIncludedEventWhere,
      },
    },
    select: {
      id: true,
      role: true,
      confirmationStatus: true,
      event: {
        select: {
          name: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
          venueName: true,
          address: true,
        },
      },
    },
    orderBy: { event: { startsAt: "asc" } },
    ...(limit === null ? {} : { take: limit }),
  });
}

export async function answerScheduleQuestion(personId: string, text: string) {
  const config = env();
  if (isStandardPayQuestion(text)) return standardPayReply(text);
  if (isFinancialQuestion(text)) {
    return "For privacy and security, this number can only share Authentic Moments' published standard contractor rates and mileage policy. It cannot access individual payouts, invoices, client pricing, billing, taxes, or contract amounts. Reply PAY for the standard rate card.";
  }
  const exactDate = requestedEventDate(text);
  if (exactDate) {
    const now = new Date();
    const candidates = await getPersonSchedule(personId, now, new Date(now.getTime() + 366 * DAY_MS), null);
    const assignment = selectRequestedAssignment(candidates, text);
    const reply = renderGroundedScheduleReply(assignment ? [assignment] : []);
    await db.agentRun.create({
      data: {
        model: "deterministic-exact-date",
        redactedInput: { personId, text },
        redactedOutput: { reply },
        toolCalls: [{ name: "select_exact_assignment_date", args: exactDate, result: assignment }],
        status: "COMPLETED",
      },
    });
    return reply;
  }
  if (!config.OPENAI_API_KEY) return "I could not interpret that automatically. An administrator will review your question.";

  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const tools: OpenAI.Responses.Tool[] = [{
    type: "function",
    name: "get_person_schedule",
    description: "Choose the date range needed to answer this sender's scheduling question. Always call this tool exactly once.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Inclusive ISO-8601 start timestamp." },
        end: { type: "string", description: "Inclusive ISO-8601 end timestamp." },
      },
      required: ["start", "end"],
      additionalProperties: false,
    },
    strict: true,
  }];
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const first = await client.responses.create({
    model: config.OPENAI_MODEL,
    store: false,
    instructions: `You are only a date-range parser for a private contractor schedule lookup.
Today is ${new Date().toISOString()}. The sender's timezone is ${person.timezone}.
Always call get_person_schedule exactly once. Convert relative dates in the question into an ISO-8601 range. Do not answer the question, select an event, or state any event fact.`,
    input: text,
    tools,
    tool_choice: "required",
  });

  const calls: Array<{ name: string; args: ScheduleToolArgs; result: GroundedAssignment[] }> = [];
  let reply = SAFE_SCHEDULE_FALLBACK;
  const toolCall = first.output.find(item => item.type === "function_call" && item.name === "get_person_schedule");
  if (toolCall?.type === "function_call") {
    try {
      const args = JSON.parse(toolCall.arguments) as ScheduleToolArgs;
      const range = safeScheduleRange(args);
      if (range) {
        const result = await getPersonSchedule(personId, range.start, range.end);
        calls.push({ name: toolCall.name, args, result });
        reply = renderGroundedScheduleReply(result);
      }
    } catch {
      // A malformed model tool call must fail closed instead of producing an ungrounded answer.
    }
  }

  await db.agentRun.create({
    data: {
      model: config.OPENAI_MODEL,
      redactedInput: { personId, text },
      redactedOutput: { reply, parserOutput: first.output as object },
      toolCalls: calls,
      status: "COMPLETED",
    },
  });
  return reply;
}
