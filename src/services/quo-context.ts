import { db } from "@/lib/db";
import { env } from "@/lib/env";

const HUMAN_CONTEXT_WINDOW_MS = 72 * 60 * 60 * 1_000;
const humanAuthorTypes = new Set(["HUMAN_OPERATOR", "ADMIN", "PROJECT_MANAGER"]);
const robotAuthorTypes = new Set(["SCHEDULING_AGENT", "REMINDER_SYSTEM"]);

type QuoConversationMessage = {
  id?: string;
  direction?: string;
  createdAt?: string;
  text?: string;
};

export function humanConversationOwnsReply(input: {
  automationText: string | null;
  explicitlyInvokedRobot: boolean;
  lastOutboundWasHuman: boolean;
}) {
  if (!input.automationText) return true;
  if (/^(STOP|START)$/i.test(input.automationText)) return false;
  if (input.explicitlyInvokedRobot) return false;
  return input.lastOutboundWasHuman;
}

function isHumanAuthorType(authorType: string) {
  return humanAuthorTypes.has(authorType);
}

export function quoOutboundWasHuman(trackedAuthorType: string | null, text = "") {
  if (trackedAuthorType && isHumanAuthorType(trackedAuthorType)) return true;
  if (trackedAuthorType && robotAuthorTypes.has(trackedAuthorType)) return false;
  if (text.includes("Sent by AMM Robot")) return false;
  return true;
}

async function localLastOutboundWasHuman(personId: string, before: Date) {
  const message = await db.message.findFirst({
    where: {
      personId,
      channel: "SMS",
      direction: "OUTBOUND",
      sentAt: {
        gte: new Date(before.getTime() - HUMAN_CONTEXT_WINDOW_MS),
        lte: before,
      },
    },
    orderBy: { sentAt: "desc" },
    select: { authorType: true },
  });
  if (!message) return null;
  return isHumanAuthorType(message.authorType);
}

/**
 * Quo is the source of truth for texts sent directly from its shared inbox.
 * A tracked AMM message ID identifies robot/reminder traffic; an untracked
 * outgoing Quo message was sent by a person in the shared inbox.
 */
export async function lastQuoOutboundWasHuman(personId: string, participant: string, before = new Date()) {
  const config = env();
  if (!config.QUO_API_KEY || !config.QUO_PHONE_NUMBER_ID) {
    return (await localLastOutboundWasHuman(personId, before)) ?? true;
  }

  try {
    const query = new URLSearchParams({
      phoneNumberId: config.QUO_PHONE_NUMBER_ID,
      participants: participant,
      createdAfter: new Date(before.getTime() - HUMAN_CONTEXT_WINDOW_MS).toISOString(),
      createdBefore: before.toISOString(),
      maxResults: "25",
    });
    const response = await fetch(`${config.QUO_API_BASE_URL}/messages?${query}`, {
      headers: { Authorization: config.QUO_API_KEY },
    });
    if (!response.ok) throw new Error(`Quo context lookup failed (${response.status})`);
    const body = await response.json() as { data?: QuoConversationMessage[] };
    const latestOutbound = (body.data ?? [])
      .filter(message => message.id && /^outgoing$/i.test(message.direction ?? "") && message.createdAt)
      .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())[0];
    if (!latestOutbound?.id) return (await localLastOutboundWasHuman(personId, before)) ?? true;

    const tracked = await db.message.findUnique({
      where: { providerMessageId: latestOutbound.id },
      select: { authorType: true },
    });
    return quoOutboundWasHuman(tracked?.authorType ?? null, latestOutbound.text);
  } catch {
    // If Quo context is unavailable, only a positively identified local robot
    // message may hand the conversation back to automation.
    return (await localLastOutboundWasHuman(personId, before)) ?? true;
  }
}
