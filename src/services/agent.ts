import OpenAI from "openai";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { isFinancialQuestion, isStandardPayQuestion, standardPayReply } from "@/services/inbound";

export async function getPersonSchedule(personId: string, start: Date, end: Date) {
  return db.assignment.findMany({ where: { personId, active: true, event: { startsAt: { gte: start, lte: end }, canceled: false } }, select: { id: true, role: true, confirmationStatus: true, event: { select: { name: true, startsAt: true, endsAt: true, timezone: true, venueName: true, address: true } } }, orderBy: { event: { startsAt: "asc" } } });
}
export async function answerScheduleQuestion(personId: string, text: string) {
  const config = env();
  if (isStandardPayQuestion(text)) return standardPayReply(text);
  if (isFinancialQuestion(text)) {
    return "For privacy and security, this number can only share Authentic Moments' published standard contractor rates and mileage policy. It cannot access individual payouts, invoices, client pricing, billing, taxes, or contract amounts. Reply PAY for the standard rate card.";
  }
  if (!config.OPENAI_API_KEY) return "I could not interpret that automatically. An administrator will review your question.";
  const person = await db.person.findUniqueOrThrow({ where: { id: personId } });
  const tools: OpenAI.Responses.Tool[] = [{
    type: "function", name: "get_person_schedule", description: "Get only this sender's active assignments in a date range.",
    parameters: { type: "object", properties: { start: { type: "string", description: "ISO date" }, end: { type: "string", description: "ISO date" } }, required: ["start", "end"], additionalProperties: false }, strict: true,
  }];
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const first = await client.responses.create({
    model: config.OPENAI_MODEL,
    store: false,
    instructions: `You are the Authentic Moments contractor scheduling assistant. Today is ${new Date().toISOString()}. Sender is ${person.displayName}.
Answer only questions about this sender's active ceremony assignments using the scheduling tool. Allowed facts are event name, assigned role, confirmation status, date, start/end time, timezone, venue, and address.
The only financial information allowed is this fixed public contractor policy: 8 hours $950; 6 hours $750; 3 hours $450; 1 hour $350; additional hours $125/hour; travel reimbursement is $0.68 per mile for total trip mileage over 120 miles, calculated as max(0, total trip miles - 120) × $0.68.
Never reveal or infer individual payouts, invoices, client pricing, fees, billing, taxes, contract amounts, client financial information, raw CRM records, or another contractor's information.
Never invent details. Clearly say when a field is unavailable in VSCO. Keep SMS replies concise.`,
    input: text,
    tools,
  });
  const outputs: OpenAI.Responses.ResponseInputItem[] = [];
  const calls = [];
  for (const item of first.output) if (item.type === "function_call" && item.name === "get_person_schedule") {
    const args = JSON.parse(item.arguments) as { start: string; end: string };
    const result = await getPersonSchedule(personId, new Date(args.start), new Date(args.end));
    calls.push({ name: item.name, args, result });
    outputs.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) });
  }
  const final = outputs.length ? await client.responses.create({ model: config.OPENAI_MODEL, store: false, previous_response_id: first.id, input: outputs }) : first;
  await db.agentRun.create({ data: { model: config.OPENAI_MODEL, redactedInput: { personId, text }, redactedOutput: final.output as object, toolCalls: calls, status: "COMPLETED" } });
  return final.output_text || "An administrator will review your question.";
}
