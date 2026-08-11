export const OPERATIONS_AGENT_RESULT_TTL_MS = 15 * 60 * 1000;

export type OperationsAgentResult = {
  question?: string;
  answer: string;
  at: string;
};

export function recentOperationsAgentResult(value: unknown, now = new Date()): OperationsAgentResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.answer !== "string" || typeof result.at !== "string") return null;

  const generatedAt = new Date(result.at);
  const age = now.getTime() - generatedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > OPERATIONS_AGENT_RESULT_TTL_MS) return null;

  return {
    question: typeof result.question === "string" ? result.question : undefined,
    answer: result.answer,
    at: result.at,
  };
}
