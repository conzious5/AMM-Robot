import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { reconcileEventReadiness } from "@/services/readiness";
import { isVscoTaskWebhookAuthorized } from "@/lib/vsco-task-webhook";
import { readLimitedText, RequestBodyTooLargeError } from "@/lib/http-security";

const Payload = z.object({
  providerEventId: z.string().min(1).max(200),
  eventType: z.enum(["task.completed", "job.stage_changed", "milestone.reached"]),
  jobId: z.string().min(1).max(200),
  jobName: z.string().max(500).optional(),
  taskId: z.string().max(200).optional(),
  taskName: z.string().max(500).optional(),
  eventDate: z.string().max(100).optional(),
  stage: z.string().max(200).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
});

export async function POST(request: Request) {
  const url = new URL(request.url);
  const secret = request.headers.get("x-vsco-task-secret") ?? url.searchParams.get("secret");
  if (!isVscoTaskWebhookAuthorized(secret, env().VSCO_TASK_WEBHOOK_SECRET)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  let payload: z.infer<typeof Payload>;
  try {
    const raw = await readLimitedText(request, 64 * 1024);
    payload = Payload.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return new NextResponse("Payload too large", { status: 413 });
    return new NextResponse("Invalid task event", { status: 400 });
  }
  const webhook = await db.webhookEvent.upsert({
    where: { provider_providerEventId: { provider: "VSCO_TASK", providerEventId: payload.providerEventId } },
    update: {},
    create: { provider: "VSCO_TASK", providerEventId: payload.providerEventId, type: payload.eventType, payload: payload as Prisma.InputJsonObject },
  });
  if (webhook.status === "COMPLETED") return NextResponse.json({ received: true, duplicate: true });

  const event = await db.event.findFirst({
    where: { vscoJobId: payload.jobId, canceled: false },
    orderBy: { startsAt: "asc" },
  });
  const taskName = payload.taskName ?? (payload.stage ? `Job stage: ${payload.stage}` : payload.eventType);
  const externalTaskId = payload.taskId ?? `automation:${payload.jobId}:${taskName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const completedAt = payload.completedAt ? new Date(payload.completedAt) : new Date();
  const task = await db.operationalTask.upsert({
    where: { provider_externalTaskId: { provider: "VSCO", externalTaskId } },
    update: {
      eventId: event?.id,
      vscoJobId: payload.jobId,
      name: taskName,
      workflowStage: payload.stage,
      completedAt,
      status: "COMPLETED",
      rawProviderPayload: payload as Prisma.InputJsonObject,
      lastSyncedAt: new Date(),
    },
    create: {
      provider: "VSCO",
      source: "VSCO_AUTOMATION_WEBHOOK",
      externalTaskId,
      eventId: event?.id,
      vscoJobId: payload.jobId,
      name: taskName,
      workflowStage: payload.stage,
      completedAt,
      status: "COMPLETED",
      rawProviderPayload: payload as Prisma.InputJsonObject,
      lastSyncedAt: new Date(),
    },
  });
  await db.webhookEvent.update({ where: { id: webhook.id }, data: { status: "COMPLETED", processedAt: new Date() } });
  await db.auditLog.create({
    data: {
      actorType: "VSCO_AUTOMATION",
      action: "OPERATIONAL_TASK_UPDATED",
      entityType: "OperationalTask",
      entityId: task.id,
      after: { status: task.status, jobId: payload.jobId, eventType: payload.eventType },
    },
  });
  if (event) await reconcileEventReadiness(event.id);
  return NextResponse.json({ received: true, taskId: task.id }, { status: 202 });
}
