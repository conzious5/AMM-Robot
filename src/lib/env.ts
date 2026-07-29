import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Prisma validates DATABASE_URL when migrations and runtime queries execute.
  // Keep it optional here because Railway does not expose runtime secrets while
  // Docker is compiling the Next.js image.
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(32).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  ADMIN_PASSWORD_B64: z.string().min(16).optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  PROJECT_MANAGER_NAME: z.string().default("Cylina"),
  PROJECT_MANAGER_EMAIL: z.string().email().optional(),
  PROJECT_MANAGER_PHONE: z.string().optional(),
  PROJECT_MANAGER_PASSWORD: z.string().min(12).optional(),
  PROJECT_MANAGER_PASSWORD_B64: z.string().min(16).optional(),
  PROJECT_MANAGER_DAILY_BRIEF_ENABLED: z.string().default("true").transform(v => v === "true"),
  PROJECT_MANAGER_DAILY_BRIEF_TIME: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  VSCO_API_BASE_URL: z.string().url().default("https://workspace.vsco.co/api/v2"),
  VSCO_API_KEY: z.string().optional(),
  VSCO_EVENTS_PATH: z.string().optional(),
  VSCO_TASKS_PATH: z.string().optional(),
  VSCO_TASK_WEBHOOK_SECRET: z.string().min(24).optional(),
  VSCO_SYNC_FUTURE_DAYS: z.coerce.number().int().positive().default(365),
  VSCO_SYNC_HISTORY_DAYS: z.coerce.number().int().nonnegative().default(30),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().default("Authentic Moments Scheduling <scheduling@authentic-moments.com>"),
  EMAIL_REPLY_DOMAIN: z.string().optional(),
  TEST_EMAIL_RECIPIENT: z.string().email().optional(),
  QUO_API_KEY: z.string().optional(),
  QUO_API_BASE_URL: z.string().url().default("https://api.openphone.com/v1"),
  QUO_PHONE_NUMBER_ID: z.string().optional(),
  QUO_PHONE_NUMBER: z.string().optional(),
  QUO_WEBHOOK_SIGNING_KEY: z.string().optional(),
  TEST_SMS_RECIPIENT: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  DEFAULT_TIMEZONE: z.string().default("America/Denver"),
  TEST_MODE: z.string().default("true").transform(v => v === "true"),
  GLOBAL_COMMUNICATIONS_PAUSED: z.string().default("false").transform(v => v === "true"),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
