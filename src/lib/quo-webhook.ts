type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;

const nonemptyString = (...values: unknown[]) => {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
};

export type ParsedQuoInboundMessage = {
  id: string;
  sender: string;
  recipient: string;
  text: string;
  raw: UnknownRecord;
};

export function parseQuoInboundMessage(payload: unknown): ParsedQuoInboundMessage | null {
  const root = record(payload);
  if (!root) return null;
  const data = record(root.data);
  const candidate = record(data?.object) ?? record(data?.message) ?? record(root.message) ?? data ?? root;
  const nestedSender = record(candidate.sender);
  const nestedFrom = record(candidate.from);
  const sender = nonemptyString(candidate.from, nestedFrom?.phoneNumber, nestedFrom?.phone, nestedSender?.phoneNumber, nestedSender?.phone, candidate.phoneNumber);
  const text = nonemptyString(candidate.text, candidate.body, candidate.content);
  const id = nonemptyString(candidate.id, root.id);
  if (!sender || !text || !id) return null;
  const to = Array.isArray(candidate.to) ? candidate.to[0] : candidate.to;
  return { id, sender, recipient: nonemptyString(to) ?? "", text, raw: candidate };
}
