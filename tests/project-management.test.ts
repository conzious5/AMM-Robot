import { describe, expect, it } from "vitest";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
import type { ReadinessInput } from "@/services/readiness";
import { evaluateReadiness } from "@/services/readiness";
import { deriveTaskStatus } from "@/services/tasks";
import { groupEventsForBrief, projectManagerNotificationKey } from "@/services/project-manager";
import { hasPermission } from "@/lib/permissions";
import { classifyProjectManagerQuestion, projectManagerToolNames } from "@/lib/project-manager-agent";
import { isVscoTaskWebhookAuthorized } from "@/lib/vsco-task-webhook";
import { assignmentIsInsideLaunchExclusion, contractorLaunchEligibility } from "@/services/go-live";

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
  });
});
