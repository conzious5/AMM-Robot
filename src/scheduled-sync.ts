import { db } from "@/lib/db";
import { actionsQueue } from "@/lib/queue";
import { reconcileVscoSyncFailureAlert, runVscoSync } from "@/services/sync";
import { reconcileAllEventReadiness } from "@/services/readiness";
import { inspectVscoTaskCapabilities, refreshCalculatedTaskStatuses } from "@/services/tasks";
import { maybeSendProjectManagerDailyBrief } from "@/services/project-manager";

async function main() {
  await runVscoSync();
  await reconcileVscoSyncFailureAlert();
  await inspectVscoTaskCapabilities();
  await refreshCalculatedTaskStatuses();
  await reconcileAllEventReadiness();
  await maybeSendProjectManagerDailyBrief();
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
