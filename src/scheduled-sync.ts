import { db } from "@/lib/db";
import { actionsQueue } from "@/lib/queue";
import { runVscoSync } from "@/services/sync";

async function main() {
  await runVscoSync();
  const actions = await db.plannedAction.findMany({ where: { status: "PLANNED", scheduledFor: { lte: new Date(Date.now() + 15 * 60000) } } });
  for (const action of actions) {
    const delay = Math.max(0, action.scheduledFor.getTime() - Date.now());
    await actionsQueue.add("send", { actionId: action.id }, { jobId: action.idempotencyKey.replaceAll(":", "-"), delay });
    await db.plannedAction.update({ where: { id: action.id }, data: { status: "QUEUED", jobQueueId: action.idempotencyKey } });
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
