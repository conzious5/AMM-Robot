import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveCommunicationServiceStatus } from "@/services/service-control";

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
  href: string;
  dismissible: boolean;
};

const dismissalPrefix = "operation-error-dismissal:";
const dismissiblePrefixes = ["developer-alert:", "sync:", "action:", "webhook:", "message:", "agent:"] as const;

export function operationErrorDismissalSettingKey(errorKey: string) {
  return `${dismissalPrefix}${errorKey}`;
}

export function isDismissibleOperationErrorKey(errorKey: string) {
  return dismissiblePrefixes.some(prefix => errorKey.startsWith(prefix));
}

export async function dismissOperationError(administratorId: string, errorKey: string) {
  if (!isDismissibleOperationErrorKey(errorKey)) throw new Error("This error type cannot be dismissed here.");
  const [prefix, id] = errorKey.split(":", 2);
  let sourceExists = false;
  if (prefix === "developer-alert") {
    sourceExists = Boolean(await db.setting.findUnique({ where: { key: errorKey } }));
  } else if (prefix === "sync") {
    const run = await db.syncRun.findUnique({ where: { id } });
    if (run) {
      const recovered = await db.syncRun.findFirst({
        where: { startedAt: { gt: run.startedAt }, status: "SUCCEEDED", itemsFailed: 0 },
      });
      if (!recovered) throw new Error("This VSCO failure is still current and cannot be dismissed yet.");
      sourceExists = true;
    }
  } else if (prefix === "action") {
    sourceExists = Boolean(await db.plannedAction.findUnique({ where: { id } }));
  } else if (prefix === "webhook") {
    sourceExists = Boolean(await db.webhookEvent.findUnique({ where: { id } }));
  } else if (prefix === "message") {
    sourceExists = Boolean(await db.message.findUnique({ where: { id } }));
  } else if (prefix === "agent") {
    sourceExists = Boolean(await db.agentRun.findUnique({ where: { id } }));
  }
  if (!sourceExists) throw new Error("The error record no longer exists.");
  const dismissedAt = new Date();
  await db.setting.upsert({
    where: { key: operationErrorDismissalSettingKey(errorKey) },
    update: { value: { administratorId, dismissedAt: dismissedAt.toISOString() } },
    create: { key: operationErrorDismissalSettingKey(errorKey), value: { administratorId, dismissedAt: dismissedAt.toISOString() } },
  });
  await db.auditLog.create({
    data: {
      actorType: "ADMIN",
      actorId: administratorId,
      action: "OPERATION_ERROR_DISMISSED",
      entityType: "OperationError",
      entityId: errorKey,
      after: { dismissedAt: dismissedAt.toISOString() },
    },
  });
}

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
    serviceSetting,
    latestSync,
    failedActions,
    failedWebhooks,
    failedMessages,
    failedAgentRuns,
    failedSyncRuns,
    openUrgentAlerts,
    developerAlertSettings,
    dismissalSettings,
  ] = await Promise.all([
    db.setting.findUnique({ where: { key: "production-launch" } }),
    db.setting.findUnique({ where: { key: "communication-service" } }),
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
      include: { event: true },
      orderBy: { firstSeenAt: "desc" },
      take: 25,
    }),
    db.setting.findMany({
      where: { key: { startsWith: "developer-alert:" } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    db.setting.findMany({
      where: { key: { startsWith: dismissalPrefix } },
      select: { key: true },
    }),
  ]);

  const dismissedKeys = new Set(dismissalSettings.map(setting => setting.key.slice(dismissalPrefix.length)));
  const failedDeveloperAlerts = developerAlertSettings.filter(setting => valueRecord(setting.value).status === "FAILED");
  const relevantOpenUrgentAlerts = openUrgentAlerts.filter(alert => !alert.event?.internalNotes?.includes("[LAUNCH_CUTOFF_EXCLUDED]"));
  const launch = valueRecord(launchSetting?.value);
  const launchStatus = typeof launch.status === "string" ? launch.status : "NOT_PREPARED";
  const serviceStatus = resolveCommunicationServiceStatus(serviceSetting?.value, launchSetting?.value);
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
        href: "/logs#errors",
        dismissible: true,
      };
    }),
    ...relevantOpenUrgentAlerts.map(alert => ({
      key: `alert:${alert.id}`,
      when: alert.firstSeenAt,
      area: "Operations",
      summary: alert.reason,
      detail: alert.recommendedAction ?? "Open Operations and review this item.",
      href: alert.eventId ? `/operations#event-${alert.eventId}` : "/operations",
      dismissible: true,
    })),
    ...failedSyncRuns.map(run => ({
      key: `sync:${run.id}`,
      when: run.startedAt,
      area: "VSCO sync",
      summary: run.status === "PARTIAL" ? "A VSCO sync finished with missing items" : "A VSCO sync did not finish",
      detail: latestSync?.status === "SUCCEEDED" && latestSync.itemsFailed === 0 && latestSync.startedAt > run.startedAt
        ? `${run.errorSummary ?? `${run.itemsFailed} item${run.itemsFailed === 1 ? "" : "s"} failed during this run.`} Recovered: a later VSCO sync completed successfully.`
        : run.errorSummary ?? `${run.itemsFailed} item${run.itemsFailed === 1 ? "" : "s"} failed during this run.`,
      href: `/logs#sync-${run.id}`,
      dismissible: Boolean(latestSync?.status === "SUCCEEDED" && latestSync.itemsFailed === 0 && latestSync.startedAt > run.startedAt),
    })),
    ...failedActions.map(action => ({
      key: `action:${action.id}`,
      when: action.updatedAt,
      area: "Robot action",
      summary: `${action.reason}${action.person ? ` for ${action.person.displayName}` : ""}`,
      detail: action.lastError ?? "The action failed and needs review.",
      href: "/actions",
      dismissible: true,
    })),
    ...failedWebhooks.map(webhook => ({
      key: `webhook:${webhook.id}`,
      when: webhook.receivedAt,
      area: `${webhook.provider} update`,
      summary: `Could not process ${webhook.type}`,
      detail: webhook.error ?? "The provider update failed.",
      href: `/logs#webhook-${webhook.id}`,
      dismissible: true,
    })),
    ...failedMessages.map(message => ({
      key: `message:${message.id}`,
      when: message.createdAt,
      area: `${message.channel === "SMS" ? "Text" : "Email"} delivery`,
      summary: `Message to ${message.person.displayName} was not delivered`,
      detail: message.failureReason ?? `Provider reported ${message.deliveryStatus.toLowerCase()}.`,
      href: "/conversations",
      dismissible: true,
    })),
    ...failedAgentRuns.map(run => ({
      key: `agent:${run.id}`,
      when: run.createdAt,
      area: "Scheduling assistant",
      summary: "The scheduling assistant could not finish a request",
      detail: run.error ?? "The assistant run failed.",
      href: `/logs#agent-${run.id}`,
      dismissible: true,
    })),
  ].filter(error => !dismissedKeys.has(error.key)).sort((a, b) => b.when.getTime() - a.when.getTime());

  const visibleCount = (prefix: string) => errors.filter(error => error.key.startsWith(prefix)).length;
  const failedDeveloperAlertCount = visibleCount("developer-alert:");
  const failedSyncRunCount = visibleCount("sync:");
  const failedActionCount = visibleCount("action:");
  const failedWebhookCount = visibleCount("webhook:");
  const failedMessageCount = visibleCount("message:");
  const failedAgentRunCount = visibleCount("agent:");
  const openUrgentAlertCount = visibleCount("alert:");

  const summaries: OperationSummary[] = [
    failedDeveloperAlertCount > 0
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
            label: "Communication service",
            tone: serviceStatus === "ACTIVE" ? "good" : "warning",
            icon: serviceStatus === "ACTIVE" ? "✓" : "!",
            summary: serviceStatus === "ACTIVE" ? "Production messaging is active." : "Messaging is suspended by the owner.",
            detail: serviceStatus === "ACTIVE"
              ? "Individual provider errors are logged without stopping the service."
              : "Use the top-right Activate switch when you want automated sends to resume.",
          },
    latestSync?.status === "SUCCEEDED" && latestSync.itemsFailed === 0
      ? {
          key: "vsco",
          label: "VSCO schedule",
          tone: failedSyncRunCount ? "warning" : "good",
          icon: failedSyncRunCount ? "!" : "✓",
          summary: "The latest VSCO sync worked.",
          detail: failedSyncRunCount
            ? `${failedSyncRunCount} earlier run${failedSyncRunCount === 1 ? "" : "s"} had errors in the last 7 days.`
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
      tone: failedMessageCount ? "error" : "good",
      icon: failedMessageCount ? "×" : "✓",
      summary: failedMessageCount
        ? `${failedMessageCount} message${failedMessageCount === 1 ? "" : "s"} failed in the last 7 days.`
        : "No failed contractor deliveries in the last 7 days.",
      detail: failedMessageCount ? "Review the red delivery errors below." : "Provider delivery tracking is working.",
    },
    {
      key: "incoming",
      label: "Incoming replies",
      tone: failedWebhookCount ? "error" : "good",
      icon: failedWebhookCount ? "×" : "✓",
      summary: failedWebhookCount
        ? `${failedWebhookCount} provider update${failedWebhookCount === 1 ? "" : "s"} could not be processed.`
        : "Incoming replies are processing normally.",
      detail: failedWebhookCount ? "Review the webhook errors below." : "STOP, START, confirmations, and questions can be handled.",
    },
    {
      key: "robot",
      label: "Robot actions",
      tone: failedActionCount || failedAgentRunCount ? "error" : "good",
      icon: failedActionCount || failedAgentRunCount ? "×" : "✓",
      summary: failedActionCount || failedAgentRunCount
        ? `${failedActionCount + failedAgentRunCount} robot task${failedActionCount + failedAgentRunCount === 1 ? "" : "s"} need attention.`
        : "The worker has no failed tasks.",
      detail: "This covers reminders, replies, and scheduling-assistant runs.",
    },
    {
      key: "attention",
      label: "Operations attention",
      tone: openUrgentAlertCount ? "error" : "good",
      icon: openUrgentAlertCount ? "×" : "✓",
      summary: openUrgentAlertCount
        ? `${openUrgentAlertCount} urgent item${openUrgentAlertCount === 1 ? "" : "s"} need review.`
        : "No urgent staffing or readiness alerts are open.",
      detail: openUrgentAlertCount ? "Open Operations to see the event and recommended next step." : "Upcoming events have no high-priority alerts.",
    },
  ];

  return {
    checkedAt: new Date(),
    errorCount: errors.length,
    errors,
    summaries,
  };
}
