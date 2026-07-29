import { Worker } from "bullmq";
import { connection } from "@/lib/queue";
import { sendPlannedAction } from "@/services/messaging";
import { log } from "@/lib/log";
import { db } from "@/lib/db";
import { handleDeterministic, deterministicIntent } from "@/services/inbound";
import { answerScheduleQuestion } from "@/services/agent";
import { parsePhoneNumber } from "libphonenumber-js";
import { notifyProjectManagers } from "@/services/project-manager";

const worker = new Worker("planned-actions", async job => sendPlannedAction(job.data.actionId as string), { connection, concurrency: 10 });
const webhookWorker = new Worker("webhooks", async job => {
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: job.data.webhookEventId as string } });
  if (event.status === "COMPLETED") return;
  const payload = event.payload as Record<string, any>;
  try {
    if (event.provider === "QUO" && /message\.received|message\.incoming|incoming/i.test(event.type)) {
      const data = payload.data?.object ?? payload.data ?? payload;
      const senderRaw = data.from ?? data.sender?.phoneNumber ?? data.phoneNumber;
      const text = data.text ?? data.content ?? data.body;
      if (!senderRaw || !text) throw new Error("Quo inbound payload lacks sender or content");
      const phone = parsePhoneNumber(String(senderRaw), "US").number;
      const person = await db.person.findUnique({ where: { phone } });
      if (!person) {
        await db.webhookEvent.update({
          where: { id: event.id },
          data: { status: "COMPLETED", processedAt: new Date(), error: "Ignored: no contractor matches inbound phone number" },
        });
        return;
      }
      const conversation = await db.conversation.upsert({ where: { personId_channel: { personId: person.id, channel: "SMS" } }, update: { lastMessageAt: new Date() }, create: { personId: person.id, channel: "SMS" } });
      await db.message.upsert({ where: { providerMessageId: String(data.id) }, update: {}, create: { conversationId: conversation.id, personId: person.id, direction: "INBOUND", channel: "SMS", provider: "QUO", providerMessageId: String(data.id), sender: phone, recipient: String(data.to ?? ""), textContent: String(text), deliveryStatus: "RECEIVED", authorType: "CONTRACTOR", receivedAt: new Date(), rawProviderPayload: data } });
      const deterministic = await handleDeterministic(person.id, String(text), "SMS");
      if (/\b(conflict|double.booked|cannot work|can't work|unavailable)\b/i.test(String(text))) {
        const key = `scheduling-conflict:${event.providerEventId}`;
        const conflictAlert = await db.operationalAlert.upsert({
          where: { deduplicationKey: key },
          update: { lastSeenAt: new Date(), status: "OPEN", resolvedAt: null },
          create: {
            personId: person.id,
            type: "SCHEDULING_CONFLICT",
            severity: "CRITICAL",
            reason: `${person.displayName} reported a scheduling conflict by text`,
            recommendedAction: "Review the contractor's upcoming assignments and contact a replacement if needed.",
            deduplicationKey: key,
            metadata: { providerEventId: event.providerEventId },
          },
        });
        await notifyProjectManagers({
          type: "SCHEDULING_CONFLICT",
          subject: `Urgent: ${person.displayName} reported a scheduling conflict`,
          body: `${person.displayName} reported a scheduling conflict by text.\n\nReview the contractor's upcoming assignments and contact a replacement if needed.`,
          deduplicationKey: `alert:${conflictAlert.id}:${conflictAlert.firstSeenAt.toISOString()}`,
        });
      }
      const reply = deterministic ?? await answerScheduleQuestion(person.id, String(text));
      const action = await db.plannedAction.create({ data: { type: "AGENT_REPLY", personId: person.id, channel: "SMS", scheduledFor: new Date(), status: "PLANNED", reason: deterministicIntent(String(text)) === "NATURAL_LANGUAGE" ? "Scheduling agent reply" : "Deterministic compliance/confirmation reply", messagePreview: reply, idempotencyKey: `reply:quo:${event.providerEventId}` } });
      await sendPlannedAction(action.id);
    }
    await db.webhookEvent.update({ where: { id: event.id }, data: { status: "COMPLETED", processedAt: new Date() } });
  } catch (error) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", error: error instanceof Error ? error.message : "Unknown error" } });
    throw error;
  }
}, { connection, concurrency: 5 });
worker.on("failed", (job, error) => log.error({ jobId: job?.id, error: error.message }, "job failed"));
webhookWorker.on("failed", (job, error) => log.error({ jobId: job?.id, error: error.message }, "webhook job failed"));
process.on("SIGTERM", async () => { await Promise.all([worker.close(), webhookWorker.close()]); await connection.quit(); process.exit(0); });
log.info("Authentic Moments worker started");
