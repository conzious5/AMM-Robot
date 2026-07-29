import { Worker } from "bullmq";
import { connection } from "@/lib/queue";
import { sendPlannedAction } from "@/services/messaging";
import { log } from "@/lib/log";
import { db } from "@/lib/db";
import { handleDeterministic, deterministicIntent } from "@/services/inbound";
import { answerScheduleQuestion } from "@/services/agent";
import { parsePhoneNumber } from "libphonenumber-js";
import { notifyProjectManagers } from "@/services/project-manager";
import { notifySystemDeveloper } from "@/services/developer-alerts";

const worker = new Worker("planned-actions", async job => sendPlannedAction(job.data.actionId as string), { connection, concurrency: 10 });
const webhookWorker = new Worker("webhooks", async job => {
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: job.data.webhookEventId as string } });
  if (event.status === "COMPLETED") return;
  const payload = event.payload as Record<string, any>;
  try {
    if (event.provider === "RESEND") {
      const data = payload.data as Record<string, any> | undefined;
      const providerMessageId = data?.email_id ? String(data.email_id) : null;
      const deliveryStatus = /delivered/i.test(event.type)
        ? "DELIVERED" as const
        : /bounced/i.test(event.type)
          ? "BOUNCED" as const
          : /complained/i.test(event.type)
            ? "COMPLAINED" as const
            : /failed/i.test(event.type)
              ? "FAILED" as const
              : /sent/i.test(event.type)
                ? "SENT" as const
                : null;
      if (providerMessageId && deliveryStatus) {
        const message = await db.message.findUnique({ where: { providerMessageId } });
        if (message) {
          await db.message.update({
            where: { id: message.id },
            data: {
              deliveryStatus,
              deliveredAt: deliveryStatus === "DELIVERED" ? new Date() : undefined,
              failureReason: ["FAILED", "BOUNCED", "COMPLAINED"].includes(deliveryStatus) ? event.type : undefined,
              rawProviderPayload: payload,
            },
          });
          if (["FAILED", "BOUNCED", "COMPLAINED"].includes(deliveryStatus)) {
            await notifySystemDeveloper({
              key: `delivery:${event.provider}:${event.providerEventId}`,
              subject: `AMM Robot issue: email ${deliveryStatus.toLowerCase()}`,
              body: `An outbound email reported ${deliveryStatus.toLowerCase()}.\n\nMessage: ${message.id}\nProvider event: ${event.providerEventId}`,
            });
          }
        }
      }
    } else if (event.provider === "QUO" && /message\.received|message\.incoming|incoming/i.test(event.type)) {
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
    } else if (event.provider === "QUO") {
      const data = payload.data?.object ?? payload.data ?? payload;
      const providerMessageId = data.id ? String(data.id) : null;
      const rawStatus = String(data.status ?? event.type);
      const deliveryStatus = /delivered/i.test(rawStatus)
        ? "DELIVERED" as const
        : /failed|undeliverable/i.test(rawStatus)
          ? "FAILED" as const
          : /sent/i.test(rawStatus)
            ? "SENT" as const
            : null;
      if (providerMessageId && deliveryStatus) {
        const message = await db.message.findUnique({ where: { providerMessageId } });
        if (message) {
          await db.message.update({
            where: { id: message.id },
            data: {
              deliveryStatus,
              deliveredAt: deliveryStatus === "DELIVERED" ? new Date() : undefined,
              failureReason: deliveryStatus === "FAILED" ? rawStatus : undefined,
              rawProviderPayload: payload,
            },
          });
          if (deliveryStatus === "FAILED") {
            await notifySystemDeveloper({
              key: `delivery:${event.provider}:${event.providerEventId}`,
              subject: "AMM Robot issue: text message failed",
              body: `An outbound text reported a delivery failure.\n\nMessage: ${message.id}\nProvider event: ${event.providerEventId}\nStatus: ${rawStatus}`,
            });
          }
        }
      }
    }
    await db.webhookEvent.update({ where: { id: event.id }, data: { status: "COMPLETED", processedAt: new Date() } });
  } catch (error) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", error: error instanceof Error ? error.message : "Unknown error" } });
    throw error;
  }
}, { connection, concurrency: 5 });
worker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "job failed");
  const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
  if (exhausted) void notifySystemDeveloper({
    key: `planned-action-job:${job.id}`,
    subject: "AMM Robot issue: contractor communication failed",
    body: `A planned communication exhausted all retry attempts.\n\nJob: ${job.id}\nError: ${error.message}`,
  });
});
webhookWorker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "webhook job failed");
  const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
  if (exhausted) void notifySystemDeveloper({
    key: `webhook-job:${job.id}`,
    subject: "AMM Robot issue: inbound webhook processing failed",
    body: `An inbound webhook exhausted all retry attempts.\n\nJob: ${job.id}\nError: ${error.message}`,
  });
});
process.on("SIGTERM", async () => { await Promise.all([worker.close(), webhookWorker.close()]); await connection.quit(); process.exit(0); });
log.info("Authentic Moments worker started");
