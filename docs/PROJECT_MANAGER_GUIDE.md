# AMM Robot project-manager guide

## Purpose

AMM Robot gives the Authentic Moments project manager one place to monitor wedding staffing, contractor confirmations, scheduled reminders, replies, readiness blockers, and operational alerts.

## Daily workflow

1. Sign in at `https://amm-robot-production.up.railway.app/login`.
2. Open **Operations** and review **Needs project-manager attention**.
3. Work from the soonest wedding outward, prioritizing scheduling conflicts, declines, missing roles, bad contact information, and delivery failures.
4. Confirm that every assigned photographer and videographer has responded independently, including second shooters.
5. Review **Conversations** for contractor replies and **Planned Actions** for upcoming reminders.
6. Use the daily brief and the Operations question box for a plain-language summary.

## Available capabilities

- View wedding readiness, staffing, confirmations, replies, alerts, recent VSCO changes, milestones, and upcoming robot actions.
- Mark an assignment confirmed or declined.
- Correct contractor email and phone information.
- Resend an assignment reminder or send a reviewed manual message.
- Replace a contractor or add a manual assignment.
- Add internal notes and local milestones.
- Pause or resume event and assignment communications.
- Resolve operational alerts.
- Ask deterministic operational questions about readiness, unconfirmed assignments, missing roles, declines, delivery failures, changes, reminders, and overdue tasks.
- Choose email, SMS, or both for alerts and configure an 8:00 AM daily email brief.

## Safety boundaries

Project managers cannot view or change application secrets, enable production communication, delete records, or delete audit history. Consequential actions are permission-checked, idempotent where applicable, and recorded in the audit log.

Before sending or changing anything, verify the contractor, wedding, assignment role, communication channel, and message. Use **Pause communications** when the situation is unclear.

## Account management

The initial account setup link is one-time and expires after 48 hours. Passwords must contain at least 12 characters. After activation, use **My Settings** to update the password, contact information, notification channel, daily-brief preference, or brief time.
