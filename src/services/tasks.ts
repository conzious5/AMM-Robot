import { db } from "@/lib/db";
import { env } from "@/lib/env";

const unsupportedEvidence = "The current authenticated VSCO Workspace V2 configuration and published API documentation do not expose a documented task-list endpoint. No endpoint is guessed.";
const webhookEvidence = "VSCO Workspace officially documents Task › Completed as an automation observable and Web Request as an automation action.";

export async function inspectVscoTaskCapabilities() {
  const configuredPath = env().VSCO_TASKS_PATH;
  const taskReadAdapterAvailable = false;
  const capabilities = [
    ["tasks.listSupported", taskReadAdapterAvailable, configuredPath ? "A path is configured, but direct task reading remains disabled until its authenticated response contract is verified and implemented." : unsupportedEvidence],
    ["tasks.readSupported", taskReadAdapterAvailable, configuredPath ? "The configured path is not treated as supported without a verified task response contract." : unsupportedEvidence],
    ["tasks.assignmentSupported", false, unsupportedEvidence],
    ["tasks.completionSupported", false, "The public documentation confirms task completion automations, but no direct API completion endpoint has been configured."],
    ["tasks.webhookSupported", true, webhookEvidence],
    ["jobWorksheetContainsTasks", false, "The current /job-contact worksheet response provides roles and contacts, not a complete task list."],
  ] as const;
  for (const [capability, supported, evidence] of capabilities) {
    await db.providerCapability.upsert({
      where: { provider_capability: { provider: "VSCO", capability } },
      update: { supported, evidence, checkedAt: new Date() },
      create: { provider: "VSCO", capability, supported, evidence },
    });
  }
  return capabilities;
}

export function deriveTaskStatus(input: {
  completedAt?: Date | null;
  deleted?: boolean;
  active?: boolean;
  dueAt?: Date | null;
}, now = new Date()) {
  if (input.deleted) return "DELETED" as const;
  if (input.completedAt) return "COMPLETED" as const;
  if (input.active === false) return "NOT_ACTIVE" as const;
  if (!input.dueAt) return "OPEN" as const;
  if (input.dueAt < now) return "OVERDUE" as const;
  if (input.dueAt.getTime() - now.getTime() <= 3 * 24 * 60 * 60 * 1000) return "DUE_SOON" as const;
  return "OPEN" as const;
}

export async function refreshCalculatedTaskStatuses(now = new Date()) {
  const tasks = await db.operationalTask.findMany({
    where: { status: { in: ["OPEN", "DUE_SOON", "OVERDUE", "UNKNOWN"] } },
  });
  for (const task of tasks) {
    const status = deriveTaskStatus({
      completedAt: task.completedAt,
      active: task.status !== "NOT_ACTIVE",
      dueAt: task.dueAt,
    }, now);
    if (status !== task.status) await db.operationalTask.update({ where: { id: task.id }, data: { status } });
  }
}
