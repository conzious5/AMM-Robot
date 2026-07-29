# Authentic Moments Booking and Reminder Agent

A production-oriented scheduling operations system for Authentic Moments Media. It synchronizes weddings from VSCO Workspace, keeps confirmations and communication history in PostgreSQL, plans durable reminders through BullMQ/Redis, sends through Resend and Quo, handles replies, and gives an administrator a daily-operations dashboard.

Test mode is on by default. Real contractors are never contacted until `TEST_MODE=false` is explicitly configured.

## Architecture

```mermaid
flowchart LR
  VSCO[VSCO Workspace V2] --> Cron[15-minute sync service]
  Cron --> DB[(PostgreSQL)]
  Cron --> Redis[(Redis / BullMQ)]
  Redis --> Worker[Worker service]
  Worker --> Resend[Resend email]
  Worker --> Quo[Quo SMS]
  Resend --> Web[Next.js web + webhooks]
  Quo --> Web
  Web --> Redis
  Web --> DB
  Worker --> OpenAI[OpenAI Responses API]
  Admin[Administrator] --> Web
  Contractor[Photo / video team] --> Web
```

The external provider abstraction normalizes VSCO data without allowing VSCO to overwrite confirmation state, local pauses, notes, or administrator decisions. Raw provider payloads and every synchronization run are retained.

## Local development

Requirements: Node 22+, PostgreSQL, and Redis.

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Run the worker separately with `npm run worker`. Run one reconciliation cycle with `npm run sync`. Set `DEMO_SEED=true npm run db:seed` for demonstration records. The fallback development login is `admin@example.com` / `change-me-before-production`; never use it in production.

Generate a production admin hash:

```bash
node -e "require('bcryptjs').hash(process.argv[1],12).then(console.log)" 'a-long-unique-password'
```

Set `AUTH_SECRET` to at least 32 random characters, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH` before deployment.

## Environment variables

See [.env.example](.env.example). Provider credentials are server-only. Important safety settings:

- `TEST_MODE=true` redirects mail and text to `TEST_EMAIL_RECIPIENT` and `TEST_SMS_RECIPIENT`, visibly marking the original destination.
- `GLOBAL_COMMUNICATIONS_PAUSED=true` suppresses all automated sending.
- `EMAIL_REPLY_DOMAIN` should be a dedicated receiving subdomain.
- `QUO_PHONE_NUMBER` and `QUO_PHONE_NUMBER_ID` select the existing sender; no number is hardcoded.

## VSCO Workspace

Create a dedicated **Read Only** key under Workspace Settings → API Integrations. The confirmed current API base is `https://workspace.vsco.co/api/v2/`.

VSCO publicly states that not all Workspace data is available in its first public API release. The public documentation does not expose a stable, unauthenticated list of event/team-assignment paths. Therefore this application does not invent one: set `VSCO_EVENTS_PATH` to the precise events endpoint shown by the authenticated API documentation for the account. The normalizer expects the documented event representation to be mapped at the provider boundary. If an API response omits `assignments`, the sync is marked with a warning, the dashboard does not claim completeness, and administrators can retain manual assignments.

The sync supports cursor pagination, exponential retry for 429/5xx responses, historical/future windows, raw payload storage, event cancellation, assignment addition/removal, stale-reminder cancellation, and idempotent upserts.

## Resend setup

1. Verify the sending domain and set `EMAIL_FROM`.
2. Create a dedicated receiving subdomain, add its MX records, and set `EMAIL_REPLY_DOMAIN`.
3. Register `https://YOUR_DOMAIN/api/webhooks/resend` for `email.received`, delivery, bounce, failure, and complaint events.
4. Set `RESEND_API_KEY` and the `whsec_...` value as `RESEND_WEBHOOK_SECRET`.

The handler verifies the unmodified body with Resend/Svix headers and stores provider event IDs idempotently before queuing work. Resend receiving webhooks contain metadata; the worker should retrieve full received-email content through Resend’s Receiving API.

## Quo setup

Create an API key and webhook signing key in Quo (formerly OpenPhone). Configure inbound message and delivery events at `https://YOUR_DOMAIN/api/webhooks/quo`, then set `QUO_API_KEY`, `QUO_PHONE_NUMBER`, `QUO_PHONE_NUMBER_ID`, and `QUO_WEBHOOK_SIGNING_KEY`. Signature verification uses the unmodified request body. Confirm the signature header and encoding against the version of Quo’s webhook documentation enabled for the account before production activation.

STOP, START, HELP, CONFIRM, and DECLINE are processed deterministically before any model call. E.164 identities are never merged by similar name.

## OpenAI

Set `OPENAI_API_KEY` and `OPENAI_MODEL`. The scheduling agent uses the Responses API with function tools and `store: false`. Database tools restrict schedule access to the identified sender; coworker information is only eligible for a shared event. Model inputs, outputs, and tool calls are recorded with secret redaction.

## Railway deployment

Create one Railway project with PostgreSQL and Redis, then three services from this repository:

| Service | Start command | Purpose |
|---|---|---|
| `amm-web` | `npm run db:migrate && npm run start` | Next.js UI, confirmation flow, API, webhooks, health |
| `amm-worker` | `npm run worker` | BullMQ delivery and inbound processing |
| `amm-sync` | `npm run sync` | Scheduled reconciliation; exits after one run |

Set the sync service cron to `*/15 * * * *`. Add Railway’s `DATABASE_URL` and `REDIS_URL` references to all three services. Use `/api/health` for the web health check. Run `npm run db:seed` once as a Railway command after the first migration.

The Dockerfile supports all three process commands. Do not run more than one migration process during a schema rollout.

## Production activation checklist

1. Configure PostgreSQL backups and test a restore into a separate database.
2. Populate every environment variable; keep `TEST_MODE=true`.
3. Run migrations and seed policies/admin.
4. Confirm VSCO’s authenticated endpoint and inspect a sync warning/details record.
5. Configure Resend receiving MX and webhook DNS.
6. Configure Quo sender and signed webhook.
7. Send redirected test email/SMS and complete a link confirmation.
8. Verify webhook delivery, opt-out, ambiguity, and bounce behavior.
9. Change `TEST_MODE=false` only after administrator review.

Emergency stop: set `GLOBAL_COMMUNICATIONS_PAUSED=true` on worker/web/sync and redeploy. Existing queued work remains auditable and will be suppressed when processed.

## Testing and operations

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

The Logs screen stores sync runs, webhook events, agent runs, and audit history independently of Railway logs. BullMQ retries use exponential backoff; exhausted jobs remain visible as failed jobs in Redis and related action errors are retained in PostgreSQL.

For backup, use Railway PostgreSQL backups or `pg_dump "$DATABASE_URL" > backup.dump`. Restore only to a verified empty target with `pg_restore`. Redis is queue state, not the authoritative history; PostgreSQL must be backed up.

## Data ownership and known limitations

- VSCO: events, times, venues, external assignments when the API exposes them.
- PostgreSQL: confirmations, reminders, messages, planned/completed actions, overrides, notes, settings, and audit history.
- A missing VSCO assignment collection is explicitly reported; it is never interpreted as a complete empty assignment list.
- Provider credentials, DNS, an account-specific authenticated VSCO endpoint, and live webhook signature samples cannot be completed without the owner’s accounts.
