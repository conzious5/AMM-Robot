import { db } from "@/lib/db";
import { actionsQueue } from "@/lib/queue";
import { reconcileVscoSyncFailureAlert, runVscoSync } from "@/services/sync";
import { reconcileAllEventReadiness } from "@/services/readiness";
import { inspectVscoTaskCapabilities, refreshCalculatedTaskStatuses } from "@/services/tasks";
import { maybeSendProjectManagerDailyBrief } from "@/services/project-manager";
import { communicationServiceIsActive } from "@/services/service-control";
import { env } from "@/lib/env";

const dailyLockVoidFailure = "Failed to deserialize column of type 'void'";

async function recoverDailyLockVoidFailures(now = new Date()) {
  const failedActions = await db.plannedAction.findMany({
    where: {
      status: "FAILED",
      type: { in: ["REMINDER", "ESCALATE"] },
      lastError: { contains: dailyLockVoidFailure },
    },
  });

  for (const action of failedActions) {
    const sentMessage = await db.message.findUnique({
      where: { idempotencyKey: action.idempotencyKey },
      select: { id: true },
    });
    if (sentMessage) continue;

    const jobId = action.idempotencyKey.replaceAll(":", "-");
    const failedJob = await actionsQueue.getJob(jobId);
    if (failedJob) await failedJob.remove();

    const recovered = await db.plannedAction.updateMany({
      where: {
        id: action.id,
        status: "FAILED",
        lastError: { contains: dailyLockVoidFailure },
      },
      data: {
        status: "PLANNED",
        scheduledFor: now,
        jobQueueId: null,
        lastError: "Retrying after the reminder daily-lock compatibility fix",
      },
    });
    if (recovered.count === 0) continue;

    await db.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "FAILED_REMINDER_REQUEUED_AFTER_LOCK_FIX",
        entityType: "PlannedAction",
        entityId: action.id,
        before: {
          status: action.status,
          scheduledFor: action.scheduledFor.toISOString(),
          lastError: action.lastError,
        },
        after: {
          status: "PLANNED",
          scheduledFor: now.toISOString(),
        },
      },
    });
  }
}

async function main() {
  await runVscoSync();
  await reconcileVscoSyncFailureAlert();
  await inspectVscoTaskCapabilities();
  await refreshCalculatedTaskStatuses();
  await reconcileAllEventReadiness();
  await maybeSendProjectManagerDailyBrief();
  const queueCommunications = env().TEST_MODE || await communicationServiceIsActive();
  if (!queueCommunications) return;
  await recoverDailyLockVoidFailures();
  const actions = await db.plannedAction.findMany({ where: { status: "PLANNED", scheduledFor: { lte: new Date(Date.now() + 15 * 60000) } } });
  for (const action of actions) {
    const delay = Math.max(0, action.scheduledFor.getTime() - Date.now());
    await actionsQueue.add("send", { actionId: action.id }, { jobId: action.idempotencyKey.replaceAll(":", "-"), delay });
    await db.plannedAction.update({ where: { id: action.id }, data: { status: "QUEUED", jobQueueId: action.idempotencyKey } });
  }
}
main().then(() => process.exit(0)).catch(async error => {
  console.error(error);
  try {
    await reconcileVscoSyncFailureAlert();
  } catch (monitorError) {
    console.error(monitorError);
  }
  process.exit(1);
});
