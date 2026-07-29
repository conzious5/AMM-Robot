import { Resend } from "resend";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

type DeveloperAlertInput = {
  key: string;
  subject: string;
  body: string;
};

export async function notifySystemDeveloper(input: DeveloperAlertInput) {
  const settingKey = `developer-alert:${input.key}`;
  const existing = await db.setting.findUnique({ where: { key: settingKey } });
  const existingValue = existing?.value as { status?: string; providerMessageId?: string } | undefined;
  if (existingValue?.status === "SENT") return existingValue.providerMessageId ?? settingKey;

  if (existing) {
    await db.setting.update({
      where: { key: settingKey },
      data: { value: { status: "PLANNED", subject: input.subject, retriedAt: new Date().toISOString() } },
    });
  } else {
    await db.setting.create({
      data: { key: settingKey, value: { status: "PLANNED", subject: input.subject, createdAt: new Date().toISOString() } },
    });
  }

  const config = env();
  const recipient = config.TEST_MODE ? config.TEST_EMAIL_RECIPIENT : config.SYSTEM_DEV_EMAIL;
  try {
    if (!recipient || !config.RESEND_API_KEY) throw new Error("System-developer email delivery is not configured");
    const subject = config.TEST_MODE ? `[TEST for ${config.SYSTEM_DEV_EMAIL ?? "system developer"}] ${input.subject}` : input.subject;
    const result = await new Resend(config.RESEND_API_KEY).emails.send({
      from: config.TEST_MODE ? "Authentic Moments System <onboarding@resend.dev>" : config.EMAIL_FROM,
      to: recipient,
      subject,
      text: `${input.body}\n\nAMM Robot: ${config.APP_URL}/logs`,
      headers: { "Idempotency-Key": settingKey },
    });
    if (result.error || !result.data) throw new Error(result.error?.message ?? "Resend rejected system alert");
    await db.setting.update({
      where: { key: settingKey },
      data: { value: { status: "SENT", subject: input.subject, providerMessageId: result.data.id, sentAt: new Date().toISOString() } },
    });
    await db.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "SYSTEM_DEVELOPER_ALERT_SENT",
        entityType: "Setting",
        entityId: settingKey,
        after: { subject: input.subject, recipient: config.SYSTEM_DEV_EMAIL },
      },
    });
    return result.data.id;
  } catch (error) {
    await db.setting.update({
      where: { key: settingKey },
      data: { value: { status: "FAILED", subject: input.subject, failure: error instanceof Error ? error.message : "Unknown failure", failedAt: new Date().toISOString() } },
    });
    await db.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "SYSTEM_DEVELOPER_ALERT_FAILED",
        entityType: "Setting",
        entityId: settingKey,
        after: { subject: input.subject, failure: error instanceof Error ? error.message : "Unknown failure" },
      },
    });
    return null;
  }
}
