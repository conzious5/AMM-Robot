import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { assertPermission } from "@/lib/permissions";
import { activatePreparedProductionLaunch, getProductionLaunchState } from "@/services/go-live";

export const serviceControlSettingKey = "communication-service";

export type CommunicationServiceStatus = "ACTIVE" | "SUSPENDED";

export type CommunicationServiceState = {
  status: CommunicationServiceStatus;
  changedAt: string | null;
  changedById: string | null;
  explicit: boolean;
};

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function resolveCommunicationServiceStatus(serviceValue: unknown, launchValue: unknown): CommunicationServiceStatus {
  const serviceStatus = objectValue(serviceValue).status;
  if (serviceStatus === "ACTIVE" || serviceStatus === "SUSPENDED") return serviceStatus;
  return objectValue(launchValue).status === "LIVE" ? "ACTIVE" : "SUSPENDED";
}

export async function getCommunicationServiceState(): Promise<CommunicationServiceState> {
  const [serviceSetting, launchSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: serviceControlSettingKey } }),
    db.setting.findUnique({ where: { key: "production-launch" } }),
  ]);
  const service = objectValue(serviceSetting?.value);
  return {
    status: resolveCommunicationServiceStatus(serviceSetting?.value, launchSetting?.value),
    changedAt: typeof service.changedAt === "string" ? service.changedAt : null,
    changedById: typeof service.changedById === "string" ? service.changedById : null,
    explicit: Boolean(serviceSetting),
  };
}

export async function communicationServiceIsActive() {
  return (await getCommunicationServiceState()).status === "ACTIVE";
}

export async function setCommunicationServiceStatus(administratorId: string, status: CommunicationServiceStatus) {
  const administrator = await db.administrator.findUniqueOrThrow({ where: { id: administratorId } });
  assertPermission(administrator, "production:enable");
  const before = await getCommunicationServiceState();
  if (before.status === status && before.explicit) return before;

  if (status === "ACTIVE") {
    if (env().TEST_MODE) throw new Error("Production service cannot be activated while this web service is in test mode.");
    if (!await getProductionLaunchState()) throw new Error("Prepare the one-time production launch before activating the service.");
    await activatePreparedProductionLaunch();
  }

  const now = new Date();
  const state = {
    status,
    changedAt: now.toISOString(),
    changedById: administratorId,
  };
  await db.$transaction([
    db.setting.upsert({
      where: { key: serviceControlSettingKey },
      update: { value: state },
      create: { key: serviceControlSettingKey, value: state },
    }),
    db.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: administratorId,
        action: status === "ACTIVE" ? "COMMUNICATION_SERVICE_ACTIVATED" : "COMMUNICATION_SERVICE_SUSPENDED",
        entityType: "Setting",
        entityId: serviceControlSettingKey,
        before,
        after: state,
      },
    }),
  ]);
  return { ...state, explicit: true };
}
