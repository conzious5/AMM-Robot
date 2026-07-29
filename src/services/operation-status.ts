import { db } from "@/lib/db";
import { env } from "@/lib/env";

export type OperationTone = "good" | "warning" | "error" | "neutral";

export type OperationSummary = {
  key: string;
  label: string;
  tone: OperationTone;
  icon: string;
  summary: string;
  detail: string;
};

export type OperationError = {
  key: string;
  when: Date;
  area: string;
  summary: string;
  detail: string;
};

const statusMap: Record<string, { tone: OperationTone; icon: string; label: string }> = {
  SUCCEEDED: { tone: "good", icon: "✓", label: "Worked" },
  COMPLETED: { tone: "good", icon: "✓", label: "Worked" },
  DELIVERED: { tone: "good", icon: "✓", label: "Delivered" },
  SENT: { tone: "good", icon: "✓", label: "Sent" },
  RECEIVED: { tone: "good", icon: "✓", label: "Received" },
  LIVE: { tone: "good", icon: "✓", label: "Live" },
  RUNNING: { tone: "warning", icon: "…", label: "Running" },
  PROCESSING: { tone: "warning", icon: "…", label: "Working" },
  QUEUED: { tone: "warning", icon: "•", label: "Waiting" },
  PLANNED: { tone: "neutral", icon: "•", label: "Planned" },
  PREPARED: { tone: "warning", icon: "!", label: "Prepared" },
  PARTIAL: { tone: "error", icon: "×", label: "Needs attention" },
  FAILED: { tone: "error", icon: "×", label: "Error" },
  BOUNCED: { tone: "error", icon: "×", label: "Bounced" },
  COMPLAINED: { tone: "error", icon: "×", label: "Complaint" },
  CANCELED: { tone: "neutral", icon: "–", label: "Stopped" },
  SUPPRESSED: { tone: "neutral", icon: "–", label: "Safely skipped" },
};

export function plainStatus(status: string) {
  return statusMap[status.toUpperCase()] ?? {
    tone: "neutral" as const,
    icon: "•",
    label: status.replaceAll("_", " ").toLowerCase(),
  };
}

function valueRecord(value: unknown) {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function valueDate(value: unknown, fallback: Date) {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export async function getOperationOverview() {
  const since = new Date(Date.now() - 7 * 86400000);
  const [
    launchSetting,
    latestSync,
    failedActions,
    failedWebhooks,
    failedMessages,
    failedAgentRuns,
    failedSyncRuns,
    openUrgentAlerts,
    developerAlertSettings,
  ] = await Promise.all([
    db.setting.findUnique({ where: { key: "production-launch" } }),
    db.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.plannedAction.findMany({
      where: { status: "FAILED" },
      include: { event: true, person: true },
      orderBy: { updatedAt: "desc" },
      take: 25,
    }),
    db.webhookEvent.findMany({
      where: { status: "FAILED" },
      orderBy: { receivedAt: "desc" },
      take: 25,
    }),
    db.message.findMany({
      where: {
        deliveryStatus: { in: ["FAILED", "BOUNCED", "COMPLAINED"] },
        createdAt: { gte: since },
      },
      include: { person: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.agentRun.findMany({
      where: { status: "FAILED", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.syncRun.findMany({
      where: {
        startedAt: { gte: since },
        OR: [{ status: { in: ["FAILED", "PARTIAL"] } }, { itemsFailed: { gt: 0 } }],
      },
      orderBy: { startedAt: "desc" },
      take: 25,
    }),
    db.operationalAlert.findMany({
      where: { status: "OPEN", severity: { in: ["CRITICAL", "HIGH"] } },
      orderBy: { firstSeenAt: "desc" },
      take: 25,
    }),
    db.setting.findMany({
      where: { key: { startsWith: "developer-alert:" } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);

  const failedDeveloperAlerts = developerAlertSettings.filter(setting => valueRecord(setting.value).status === "FAILED");
  const launch = valueRecord(launchSetting?.value);
  const launchStatus = typeof launch.status === "string" ? launch.status : "NOT_PREPARED";
  const config = env();

  const errors: OperationError[] = [
    ...failedDeveloperAlerts.map(setting => {
      const value = valueRecord(setting.value);
      return {
        key: setting.key,
        when: valueDate(value.failedAt, setting.updatedAt),
        area: "System email alert",
        summary: typeof value.subject === "string" ? value.subject : "A system alert could not be sent",
        detail: typeof value.failure === "string" ? value.failure : "Email provider rejected the alert.",
      };
    }),
    ...openUrgentAlerts.map(alert => ({
      key: `alert:${alert.id}`,
      when: alert.firstSeenAt,
      area: "Operations",
      summary: alert.reason,
      detail: alert.recommendedAction ?? "Open Operations and review this item.",
    })),
    ...failedSyncRuns.map(run => ({
      key: `sync:${run.id}`,
      when: run.startedAt,
      area: "VSCO sync",
      summary: run.status === "PARTIAL" ? "A VSCO sync finished with missing items" : "A VSCO sync did not finish",
      detail: run.errorSummary ?? `${run.itemsFailed} item${run.itemsFailed === 1 ? "" : "s"} failed during this run.`,
    })),
    ...failedActions.map(action => ({
      key: `action:${action.id}`,
      when: action.updatedAt,
      area: "Robot action",
      summary: `${action.reason}${action.person ? ` for ${action.person.displayName}` : ""}`,
      detail: action.lastError ?? "The action failed and needs review.",
    })),
    ...failedWebhooks.map(webhook => ({
      key: `webhook:${webhook.id}`,
      when: webhook.receivedAt,
      area: `${webhook.provider} update`,
      summary: `Could not process ${webhook.type}`,
      detail: webhook.error ?? "The provider update failed.",
    })),
    ...failedMessages.map(message => ({
      key: `message:${message.id}`,
      when: message.createdAt,
      area: `${message.channel === "SMS" ? "Text" : "Email"} delivery`,
      summary: `Message to ${message.person.displayName} was not delivered`,
      detail: message.failureReason ?? `Provider reported ${message.deliveryStatus.toLowerCase()}.`,
    })),
    ...failedAgentRuns.map(run => ({
      key: `agent:${run.id}`,
      when: run.createdAt,
      area: "Scheduling assistant",
      summary: "The scheduling assistant could not finish a request",
      detail: run.error ?? "The assistant run failed.",
    })),
  ].sort((a, b) => b.when.getTime() - a.when.getTime());

  const summaries: OperationSummary[] = [
    failedDeveloperAlerts.length > 0
      ? {
          key: "launch",
          label: "Production launch",
          tone: "error",
          icon: "×",
          summary: "Launch is safely paused because production email is not ready.",
          detail: "Verify the sending domain in Resend before trying again.",
        }
      : config.TEST_MODE
        ? {
            key: "launch",
            label: "Production launch",
            tone: "warning",
            icon: "!",
            summary: launchStatus === "PREPARED" ? "Launch is prepared, but test mode is still on." : "Test mode is on.",
            detail: "Real contractor messages are not being sent.",
          }
        : {
            key: "launch",
            label: "Production launch",
            tone: launchStatus === "LIVE" ? "good" : "error",
            icon: launchStatus === "LIVE" ? "✓" : "×",
            summary: launchStatus === "LIVE" ? "Production messaging is live." : "Production mode is on, but launch is not active.",
            detail: launchStatus === "LIVE" ? "The prepared communication plan is active." : "Real sends remain blocked by the launch safety guard.",
          },
    latestSync?.status === "SUCCEEDED" && latestSync.itemsFailed === 0
      ? {
          key: "vsco",
          label: "VSCO schedule",
          tone: failedSyncRuns.length ? "warning" : "good",
          icon: failedSyncRuns.length ? "!" : "✓",
          summary: "The latest VSCO sync worked.",
          detail: failedSyncRuns.length
            ? `${failedSyncRuns.length} earlier run${failedSyncRuns.length === 1 ? "" : "s"} had errors in the last 7 days.`
            : "Events and assignments are up to date.",
        }
      : {
          key: "vsco",
          label: "VSCO schedule",
          tone: "error",
          icon: "×",
          summary: latestSync ? "The latest VSCO sync needs attention." : "VSCO has not synced yet.",
          detail: latestSync?.errorSummary ?? "Review the sync run below.",
        },
    {
      key: "delivery",
      label: "Email and text delivery",
      tone: failedMessages.length ? "error" : "good",
      icon: failedMessages.length ? "×" : "✓",
      summary: failedMessages.length
        ? `${failedMessages.length} message${failedMessages.length === 1 ? "" : "s"} failed in the last 7 days.`
        : "No failed contractor deliveries in the last 7 days.",
      detail: failedMessages.length ? "Review the red delivery errors below." : "Provider delivery tracking is working.",
    },
    {
      key: "incoming",
      label: "Incoming replies",
      tone: failedWebhooks.length ? "error" : "good",
      icon: failedWebhooks.length ? "×" : "✓",
      summary: failedWebhooks.length
        ? `${failedWebhooks.length} provider update${failedWebhooks.length === 1 ? "" : "s"} could not be processed.`
        : "Incoming replies are processing normally.",
      detail: failedWebhooks.length ? "Review the webhook errors below." : "STOP, START, confirmations, and questions can be handled.",
    },
    {
      key: "robot",
      label: "Robot actions",
      tone: failedActions.length || failedAgentRuns.length ? "error" : "good",
      icon: failedActions.length || failedAgentRuns.length ? "×" : "✓",
      summary: failedActions.length || failedAgentRuns.length
        ? `${failedActions.length + failedAgentRuns.length} robot task${failedActions.length + failedAgentRuns.length === 1 ? "" : "s"} need attention.`
        : "The worker has no failed tasks.",
      detail: "This covers reminders, replies, and scheduling-assistant runs.",
    },
    {
      key: "attention",
      label: "Operations attention",
      tone: openUrgentAlerts.length ? "error" : "good",
      icon: openUrgentAlerts.length ? "×" : "✓",
      summary: openUrgentAlerts.length
        ? `${openUrgentAlerts.length} urgent item${openUrgentAlerts.length === 1 ? "" : "s"} need review.`
        : "No urgent staffing or readiness alerts are open.",
      detail: openUrgentAlerts.length ? "Open Operations to see the event and recommended next step." : "Upcoming events have no high-priority alerts.",
    },
  ];

  return {
    checkedAt: new Date(),
    errorCount: errors.length,
    errors,
    summaries,
  };
}
