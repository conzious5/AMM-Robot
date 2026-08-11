import { describe, expect, it } from "vitest";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
import type { ReadinessInput } from "@/services/readiness";
import { evaluateReadiness, isMaterialPostConfirmationChange } from "@/services/readiness";
import { deriveTaskStatus } from "@/services/tasks";
import { groupEventsForBrief, projectManagerNotificationKey } from "@/services/project-manager";
import { assertCanEditProjectManagerProfile, canAccessAdministrativeArea, canEditProjectManagerProfile, hasPermission } from "@/lib/permissions";
import { classifyProjectManagerQuestion, projectManagerToolNames } from "@/lib/project-manager-agent";
import { isVscoTaskWebhookAuthorized } from "@/lib/vsco-task-webhook";
import { assignmentIsInsideLaunchExclusion, contractorLaunchEligibility } from "@/services/go-live";
import { administratorInviteIsUsable, administratorInviteKey } from "@/lib/admin-invite";
import { isDismissibleOperationErrorKey, operationErrorDismissalSettingKey, webhookFailureHasRecovered } from "@/services/operation-status";
import { resolveCommunicationServiceStatus } from "@/services/service-control";
import { localDateKey, nextUnoccupiedLocalDay } from "@/lib/quiet-hours";
import { communicationChannelLabel } from "@/lib/channels";
import { isLaunchCutoffExcluded } from "@/lib/launch-cutoff";
import { authenticationAttemptCountsAreLimited, sessionPayloadMatchesAdministrator } from "@/lib/auth";
import { confirmationTokenIsUsable } from "@/lib/confirmation";
import { ADMINISTRATOR_EMAIL, isAuthorizedHumanAccount, PORTAL_USER_EMAIL } from "@/lib/authorized-users";
import { contractorContactAuditValues } from "@/services/operations";

const base = (overrides: Partial<ReadinessInput> = {}): ReadinessInput => ({
  canceled: false,
  venueName: "The Manor",
  address: "1 Main St",
  daysUntilEvent: 20,
  requiredRoles: [{ role: "PHOTOGRAPHER", requiredCount: 1 }, { role: "VIDEOGRAPHER", requiredCount: 1 }],
  assignments: [
    { id: "a1", role: "PHOTOGRAPHER", confirmationStatus: "CONFIRMED", personName: "Photo Person", hasEmail: true, hasPhone: true },
    { id: "a2", role: "VIDEOGRAPHER", confirmationStatus: "CONFIRMED", personName: "Video Person", hasEmail: true, hasPhone: true },
  ],
  materialChangeAfterConfirmation: false,
  criticalOverdueTasks: [],
  externalBlockingReasons: [],
  completedReminderCount: 0,
  ...overrides,
});

describe("project-manager acceptance", () => {
  it("marks a fully staffed and confirmed event ready", () => {
    expect(evaluateReadiness(base())).toEqual({ status: "READY", reasons: [] });
  });

  it("returns a confirmed event to incomplete when a required shooter is removed", () => {
    const input = base({ assignments: base().assignments.filter(item => item.role !== "VIDEOGRAPHER") });
    const result = evaluateReadiness(input);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons.join(" ")).toMatch(/videographer.*unfilled/i);
  });

  it("flags venue or time changes after confirmation", () => {
    expect(evaluateReadiness(base({ materialChangeAfterConfirmation: true })).status).toBe("CHANGED_SINCE_CONFIRMATION");
  });

  it("replans calendar timing quietly without treating it as a reconfirmation incident", () => {
    expect(isMaterialPostConfirmationChange("startsAt")).toBe(false);
    expect(isMaterialPostConfirmationChange("endsAt")).toBe(false);
    expect(isMaterialPostConfirmationChange("venueName")).toBe(true);
    expect(isMaterialPostConfirmationChange("assignment")).toBe(true);
  });

  it("groups daily-brief events by operational state", () => {
    const groups = groupEventsForBrief([{ readinessStatus: "READY" }, { readinessStatus: "WAITING_FOR_CONFIRMATION" }, { readinessStatus: "AT_RISK" }, { readinessStatus: "INCOMPLETE" }]);
    expect(groups.ready).toHaveLength(1);
    expect(groups.waiting).toHaveLength(1);
    expect(groups.atRisk).toHaveLength(2);
  });

  it("produces a stable notification deduplication key", () => {
    expect(projectManagerNotificationKey("ready:e1:t1", "cylina", "EMAIL")).toBe(projectManagerNotificationKey("ready:e1:t1", "cylina", "EMAIL"));
  });

  it("routes Cylina attention questions to the attention tool", () => {
    expect(classifyProjectManagerQuestion("Which weddings need my attention?")).toBe("list_events_needing_attention");
  });

  it("prevents project managers from changing security or production controls", () => {
    expect(hasPermission("PROJECT_MANAGER", "settings:security")).toBe(false);
    expect(hasPermission("PROJECT_MANAGER", "production:enable")).toBe(false);
  });

  it("denies unauthenticated project-manager profile updates", () => {
    const target = { id: "pm-1", email: PORTAL_USER_EMAIL, role: "PROJECT_MANAGER" } as const;
    expect(canEditProjectManagerProfile(null, target)).toBe(false);
    expect(() => assertCanEditProjectManagerProfile(null, target)).toThrow(/permission/i);
  });

  it("allows a project manager to update only their own permitted profile", () => {
    const actor = { id: "pm-1", role: "PROJECT_MANAGER" } as const;
    expect(canEditProjectManagerProfile(actor, { id: "pm-1", email: PORTAL_USER_EMAIL, role: "PROJECT_MANAGER" })).toBe(true);
    expect(canEditProjectManagerProfile(actor, { id: "pm-2", email: "other@authentic-moments.com", role: "PROJECT_MANAGER" })).toBe(false);
  });

  it("prevents a project manager from targeting owner or administrator records", () => {
    const actor = { id: "pm-1", role: "PROJECT_MANAGER" } as const;
    expect(canEditProjectManagerProfile(actor, { id: "owner", email: "admin@example.com", role: "OWNER" })).toBe(false);
    expect(canEditProjectManagerProfile(actor, { id: "admin", email: ADMINISTRATOR_EMAIL, role: "ADMIN" })).toBe(false);
  });

  it("gives only the administrator intended access to Cylina's profile", () => {
    const target = { id: "pm-1", email: PORTAL_USER_EMAIL, role: "PROJECT_MANAGER" } as const;
    expect(canEditProjectManagerProfile({ id: "admin", role: "ADMIN" }, target)).toBe(true);
    expect(canEditProjectManagerProfile({ id: "owner", role: "OWNER" }, target)).toBe(false);
  });

  it("restricts logs and administrative areas to ADMIN", () => {
    expect(canAccessAdministrativeArea("ADMIN")).toBe(true);
    expect(canAccessAdministrativeArea("PROJECT_MANAGER")).toBe(false);
    expect(canAccessAdministrativeArea("OWNER")).toBe(false);
  });

  it("allows exactly the intended two human identities and roles", () => {
    expect(isAuthorizedHumanAccount({ email: ADMINISTRATOR_EMAIL, role: "ADMIN", active: true })).toBe(true);
    expect(isAuthorizedHumanAccount({ email: PORTAL_USER_EMAIL, role: "PROJECT_MANAGER", active: true })).toBe(true);
    expect(isAuthorizedHumanAccount({ email: ADMINISTRATOR_EMAIL, role: "OWNER", active: true })).toBe(false);
    expect(isAuthorizedHumanAccount({ email: "admin@example.com", role: "OWNER", active: true })).toBe(false);
    expect(isAuthorizedHumanAccount({ email: "other@authentic-moments.com", role: "ADMIN", active: true })).toBe(false);
    expect(isAuthorizedHumanAccount({ email: PORTAL_USER_EMAIL, role: "PROJECT_MANAGER", active: false })).toBe(false);
  });

  it("records contractor contact changes with previous and new values", () => {
    expect(contractorContactAuditValues(
      { email: "old@example.com", phone: "+13035550100" },
      { email: "new@example.com", phone: "+13035550101" },
    )).toEqual({
      before: { email: "old@example.com", phone: "+13035550100" },
      after: { email: "new@example.com", phone: "+13035550101" },
    });
  });

  it("gives ADMIN full system control and gives legacy OWNER no permissions", () => {
    expect(hasPermission("ADMIN", "production:enable")).toBe(true);
    expect(hasPermission("ADMIN", "settings:security")).toBe(true);
    expect(hasPermission("OWNER", "production:enable")).toBe(false);
    expect(hasPermission("OWNER", "settings:security")).toBe(false);
  });

  it("enforces login throttling at the documented email and IP thresholds", () => {
    expect(authenticationAttemptCountsAreLimited(9, 49)).toBe(false);
    expect(authenticationAttemptCountsAreLimited(10, 0)).toBe(true);
    expect(authenticationAttemptCountsAreLimited(0, 50)).toBe(true);
  });

  it("accepts only a current active administrator session version", () => {
    const admin = { id: "admin-1", email: ADMINISTRATOR_EMAIL, role: "ADMIN", active: true, sessionVersion: 0 };
    expect(sessionPayloadMatchesAdministrator({ sub: "admin-1", ver: 0 }, admin)).toBe(true);
    expect(sessionPayloadMatchesAdministrator({ sub: "admin-1" }, admin)).toBe(false);
    expect(sessionPayloadMatchesAdministrator({ sub: "other", ver: 0 }, admin)).toBe(false);
    expect(sessionPayloadMatchesAdministrator({ sub: "admin-1", ver: 1 }, admin)).toBe(false);
    expect(sessionPayloadMatchesAdministrator({ sub: "admin-1", ver: 0 }, { ...admin, active: false })).toBe(false);
    expect(sessionPayloadMatchesAdministrator({ sub: "admin-1", ver: 0 }, { ...admin, email: "other@authentic-moments.com" })).toBe(false);
  });

  it("rejects expired, used, and revoked confirmation bearer tokens", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const active = { usedAt: null, revokedAt: null, expiresAt: new Date("2026-08-11T12:00:00.000Z") };
    expect(confirmationTokenIsUsable(active, now)).toBe(true);
    expect(confirmationTokenIsUsable({ ...active, expiresAt: now }, now)).toBe(false);
    expect(confirmationTokenIsUsable({ ...active, usedAt: now }, now)).toBe(false);
    expect(confirmationTokenIsUsable({ ...active, revokedAt: now }, now)).toBe(false);
    expect(confirmationTokenIsUsable(null, now)).toBe(false);
  });

  it("uses only the explicit owner service switch after it is created", () => {
    expect(resolveCommunicationServiceStatus(undefined, { status: "LIVE" })).toBe("ACTIVE");
    expect(resolveCommunicationServiceStatus(undefined, { status: "PREPARED" })).toBe("SUSPENDED");
    expect(resolveCommunicationServiceStatus({ status: "ACTIVE" }, { status: "PREPARED" })).toBe("ACTIVE");
    expect(resolveCommunicationServiceStatus({ status: "SUSPENDED" }, { status: "LIVE" })).toBe("SUSPENDED");
  });

  it("limits a contractor to one reminder per local calendar day", () => {
    const timezone = "America/Denver";
    const desired = new Date("2026-07-30T14:00:00.000Z");
    const occupied = new Set([localDateKey(desired, timezone)]);
    const next = nextUnoccupiedLocalDay(desired, timezone, occupied);
    expect(localDateKey(next, timezone)).toBe("2026-07-31");
    expect(next.getUTCHours()).toBe(14);
  });

  it("labels contractor communication in plain language", () => {
    expect(communicationChannelLabel("EMAIL")).toBe("Email");
    expect(communicationChannelLabel("SMS")).toBe("Text message");
  });

  it("keeps only the marked launch-cutoff weddings excluded", () => {
    expect(isLaunchCutoffExcluded(null)).toBe(false);
    expect(isLaunchCutoffExcluded("ordinary note")).toBe(false);
    expect(isLaunchCutoffExcluded("[LAUNCH_CUTOFF_EXCLUDED] owner decision")).toBe(true);
  });

  it("stores administrator setup tokens only as stable hashes", () => {
    expect(administratorInviteKey("one-time-secret")).toMatch(/^administrator-invite:[a-f0-9]{64}$/);
    expect(administratorInviteKey("one-time-secret")).toBe(administratorInviteKey("one-time-secret"));
    expect(administratorInviteKey("different-secret")).not.toBe(administratorInviteKey("one-time-secret"));
  });

  it("expires one-time administrator setup links", () => {
    const value = {
      administratorId: "cylina",
      createdAt: "2026-07-29T18:00:00.000Z",
      expiresAt: "2026-07-31T18:00:00.000Z",
    };
    expect(administratorInviteIsUsable(value, new Date("2026-07-30T18:00:00.000Z"))).toBe(true);
    expect(administratorInviteIsUsable(value, new Date("2026-08-01T18:00:00.000Z"))).toBe(false);
  });

  it("allows current-error dismissals only for supported logged error sources", () => {
    expect(isDismissibleOperationErrorKey("sync:run-1")).toBe(true);
    expect(isDismissibleOperationErrorKey("webhook:event-1")).toBe(true);
    expect(isDismissibleOperationErrorKey("alert:alert-1")).toBe(false);
    expect(isDismissibleOperationErrorKey("anything:unsafe")).toBe(false);
    expect(operationErrorDismissalSettingKey("sync:run-1")).toBe("operation-error-dismissal:sync:run-1");
  });

  it("keeps recovered provider failures in history without showing a current outage", () => {
    const failed = { provider: "QUO", type: "message.received", receivedAt: new Date("2026-08-07T22:18:46Z") };
    expect(webhookFailureHasRecovered(failed, [{ ...failed, receivedAt: new Date("2026-08-09T23:54:44Z") }])).toBe(true);
    expect(webhookFailureHasRecovered(failed, [{ provider: "QUO", type: "message.delivered", receivedAt: new Date("2026-08-09T23:54:44Z") }])).toBe(false);
  });

  it("allows project managers to resend and send communications", () => {
    expect(hasPermission("PROJECT_MANAGER", "communications:send")).toBe(true);
  });

  it("does not infer a task API endpoint from task timing", () => {
    expect(deriveTaskStatus({ active: true })).toBe("OPEN");
  });

  it("accepts the configured VSCO webhook secret", () => {
    expect(isVscoTaskWebhookAuthorized("a-very-long-webhook-secret", "a-very-long-webhook-secret")).toBe(true);
  });

  it("rejects an unauthenticated VSCO webhook", () => {
    expect(isVscoTaskWebhookAuthorized(null, "a-very-long-webhook-secret")).toBe(false);
    expect(isVscoTaskWebhookAuthorized("wrong", "a-very-long-webhook-secret")).toBe(false);
  });

  it("lets an overdue critical task block readiness", () => {
    const result = evaluateReadiness(base({ criticalOverdueTasks: ["Final details reviewed"] }));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("Critical preparation task is overdue: Final details reviewed");
  });

  it("does not let a noncritical overdue task block readiness", () => {
    expect(evaluateReadiness(base({ criticalOverdueTasks: [] })).status).toBe("READY");
  });

  it("prevents project managers from deleting records or audit history", () => {
    expect(hasPermission("PROJECT_MANAGER", "records:delete")).toBe(false);
    expect(hasPermission("PROJECT_MANAGER", "audit:delete")).toBe(false);
  });

  it("exposes every requested project-manager tool", () => {
    expect(projectManagerToolNames).toContain("resend_assignment_reminder");
    expect(projectManagerToolNames).toContain("send_manual_message");
    expect(projectManagerToolNames).toContain("resolve_operational_alert");
    expect(projectManagerToolNames).toContain("get_tasks_assigned_to_user");
  });

  it("makes an unready event within three days at risk", () => {
    const assignments = base().assignments.map((item, index) => index ? item : { ...item, confirmationStatus: "PENDING" });
    const result = evaluateReadiness(base({ daysUntilEvent: 2, assignments }));
    expect(result.status).toBe("AT_RISK");
    expect(result.reasons.join(" ")).toMatch(/within 3 days/i);
  });

  it("excludes only assignments less than seven days away at launch", () => {
    const now = new Date("2026-07-30T09:00:00-06:00");
    expect(assignmentIsInsideLaunchExclusion(new Date("2026-08-05T09:00:00-06:00"), now)).toBe(true);
    expect(assignmentIsInsideLaunchExclusion(new Date("2026-08-06T09:00:00-06:00"), now)).toBe(false);
  });

  it("uses only active SMS-eligible contractor profile numbers for launch", () => {
    expect(contractorLaunchEligibility({ active: true, paused: false, smsEligible: true, phone: "+17035550123" }).eligible).toBe(true);
    expect(contractorLaunchEligibility({ active: true, paused: false, smsEligible: false, phone: "+17035550123" }).eligible).toBe(false);
    expect(contractorLaunchEligibility({ active: false, paused: false, smsEligible: true, phone: "+17035550123" }).eligible).toBe(false);
    expect(contractorLaunchEligibility({ active: true, paused: false, smsEligible: true, phone: null }).eligible).toBe(false);
    expect(contractorLaunchEligibility({ active: true, paused: false, smsEligible: true, phone: "123" })).toEqual({ eligible: false, reason: "invalid phone" });
  });
});
