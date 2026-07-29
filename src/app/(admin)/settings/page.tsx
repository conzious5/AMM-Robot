import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sendReminderPreview } from "@/services/messaging";
import { reconcileVscoSyncFailureAlert, runVscoSync } from "@/services/sync";
import bcrypt from "bcryptjs";
import { requireAdmin } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { inspectVscoTaskCapabilities, refreshCalculatedTaskStatuses } from "@/services/tasks";
import { reconcileAllEventReadiness } from "@/services/readiness";
import { getProductionLaunchState, prepareProductionLaunch } from "@/services/go-live";

async function update(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  assertPermission(admin, "settings:security");
  const id = String(data.get("id"));
  await db.reminderPolicy.update({ where: { id }, data: { active: data.get("enabled") === "on" } });
  revalidatePath("/settings");
}

async function saveProjectManager(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  assertPermission(admin, "settings:notifications");
  const id = String(data.get("id") || "");
  if (admin.role === "PROJECT_MANAGER" && id !== admin.id) throw new Error("Project managers may edit only their own notification profile.");
  const email = String(data.get("email")).trim().toLowerCase();
  const password = String(data.get("password") || "");
  if (password && password.length < 12) throw new Error("Passwords must be at least 12 characters.");
  const values = {
    name: String(data.get("name")).trim(),
    email,
    phone: String(data.get("phone") || "").trim() || null,
    dailyBriefEnabled: data.get("dailyBriefEnabled") === "on",
    dailyBriefTime: String(data.get("dailyBriefTime") || "08:00"),
    notificationChannel: (["EMAIL", "SMS", "BOTH"].includes(String(data.get("notificationChannel"))) ? String(data.get("notificationChannel")) : "EMAIL") as "EMAIL" | "SMS" | "BOTH",
  };
  if (id) {
    await db.administrator.update({
      where: { id },
      data: { ...values, ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) },
    });
    await db.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "PROJECT_MANAGER_PROFILE_UPDATED", entityType: "Administrator", entityId: id, after: { ...values, passwordChanged: Boolean(password) } } });
  } else {
    if (admin.role === "PROJECT_MANAGER") throw new Error("Only an administrator can invite another project manager.");
    if (password.length < 12) throw new Error("A new project manager requires a password of at least 12 characters.");
    const manager = await db.administrator.create({ data: { ...values, passwordHash: await bcrypt.hash(password, 12), role: "PROJECT_MANAGER" } });
    await db.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "PROJECT_MANAGER_INVITED", entityType: "Administrator", entityId: manager.id, after: { name: manager.name, email: manager.email } } });
  }
  revalidatePath("/settings");
}

async function saveRequiredRole(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  assertPermission(admin, "assignments:edit");
  const jobType = String(data.get("jobType")).trim();
  const role = String(data.get("role")) as "PHOTOGRAPHER" | "VIDEOGRAPHER" | "ASSISTANT";
  const requiredCount = Math.max(0, Number(data.get("requiredCount")));
  await db.requiredRoleRule.upsert({
    where: { jobType_role: { jobType, role } },
    update: { requiredCount, active: data.get("active") === "on" },
    create: { jobType, role, requiredCount, active: data.get("active") === "on" },
  });
  await db.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "REQUIRED_ROLE_RULE_UPDATED", entityType: "RequiredRoleRule", after: { jobType, role, requiredCount } } });
  revalidatePath("/settings");
}

async function inspectTasks() {
  "use server";
  await requireAdmin();
  await inspectVscoTaskCapabilities();
  revalidatePath("/settings");
}

async function sync() {
  "use server";
  await runVscoSync();
  await reconcileVscoSyncFailureAlert();
  await inspectVscoTaskCapabilities();
  await refreshCalculatedTaskStatuses();
  await reconcileAllEventReadiness();
  revalidatePath("/settings");
}

async function prepareLaunch() {
  "use server";
  const admin = await requireAdmin();
  assertPermission(admin, "production:enable");
  await prepareProductionLaunch(admin.id);
  revalidatePath("/settings");
}

async function sendTest(data: FormData) {
  "use server";
  const channel = String(data.get("channel")) === "EMAIL" ? "EMAIL" : "SMS";
  let result = `${channel.toLowerCase()}-sent`;
  try {
    await sendReminderPreview(channel);
  } catch (error) {
    result = error instanceof Error ? error.message : "Test send failed";
  }
  redirect(`/settings?test=${encodeURIComponent(result)}`);
}

export default async function Page({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const { test } = await searchParams;
  const config = env();
  const [policies, syncRun, managers, roleRules, capabilities, launchState] = await Promise.all([
    db.reminderPolicy.findMany({ orderBy: { attemptNumber: "asc" } }),
    db.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.administrator.findMany({ where: { role: "PROJECT_MANAGER" }, orderBy: { name: "asc" } }),
    db.requiredRoleRule.findMany({ orderBy: [{ jobType: "asc" }, { role: "asc" }] }),
    db.providerCapability.findMany({ where: { provider: "VSCO" }, orderBy: { capability: "asc" } }),
    getProductionLaunchState(),
  ]);
  const admin = await requireAdmin();
  const testReady = Boolean(
    config.TEST_MODE &&
    config.RESEND_API_KEY &&
    config.TEST_EMAIL_RECIPIENT &&
    config.QUO_API_KEY &&
    config.QUO_PHONE_NUMBER &&
    config.TEST_SMS_RECIPIENT
  );

  return (
    <>
      <h1>Settings</h1>
      <section className="grid">
        <div className="card">
          <h3>Safety</h3>
          <p>Test mode: <b>{String(config.TEST_MODE)}</b></p>
          <p>Global environment pause: <b>{String(config.GLOBAL_COMMUNICATIONS_PAUSED)}</b></p>
          <p className="muted">Production mode requires changing Railway variables and redeploying.</p>
        </div>
        <div className="card">
          <h3>VSCO</h3>
          <p>Last sync: {syncRun?.startedAt.toLocaleString() ?? "Never"}</p>
          <p>Status: {syncRun?.status ?? "Not configured"}</p>
          <form action={sync}><button>Run sync now</button></form>
        </div>
        <div className="card">
          <h3>Reminder test</h3>
          <p>Email and SMS test configuration: <b>{testReady ? "Ready" : "Incomplete"}</b></p>
          {test === "email-sent" && <p>Test email accepted by Resend.</p>}
          {test === "sms-sent" && <p>Test text accepted by Quo.</p>}
          {test && !["email-sent", "sms-sent"].includes(test) && <p className="danger">{test}</p>}
          <form action={sendTest}>
            <button name="channel" value="EMAIL" disabled={!testReady}>Send test email</button>{" "}
            <button name="channel" value="SMS" disabled={!testReady}>Send test text</button>
          </form>
        </div>
      </section>
      <h2>Production launch</h2>
      <div className="card">
        <p>Status: <b>{launchState?.status ?? "Not prepared"}</b></p>
        {launchState && <>
          <p>Contractor introductions: {launchState.eligibleContractors} eligible · {launchState.skippedContractors} skipped</p>
          <p>Reminder assignments: {launchState.eligibleAssignments} continuing · {launchState.suppressedAssignments} suppressed inside 7 days</p>
          <p>Introduction start: {new Date(launchState.introStart).toLocaleString()}</p>
          <p>Reminder start: {new Date(launchState.reminderStart).toLocaleString()}</p>
        </>}
        {!launchState && admin.role === "OWNER" && config.TEST_MODE && (
          <form action={prepareLaunch}>
            <button>Prepare one-time production launch</button>
          </form>
        )}
        <p className="muted">Preparation is idempotent and does not send while test mode is enabled. Production delivery remains blocked until the prepared plan is activated after Railway test mode is disabled.</p>
      </div>
      <h2>Project manager</h2>
      {managers.map(manager => (
        <form action={saveProjectManager} className="card settings-form" key={manager.id}>
          <input type="hidden" name="id" value={manager.id} />
          <label>Name<input name="name" defaultValue={manager.name} required /></label>
          <label>Notification email<input name="email" type="email" defaultValue={manager.email} required /></label>
          <label>Notification phone<input name="phone" defaultValue={manager.phone ?? ""} /></label>
          <label>Notification channel<select name="notificationChannel" defaultValue={manager.notificationChannel}><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="BOTH">Email and SMS</option></select></label>
          <label>Daily brief time<input name="dailyBriefTime" type="time" defaultValue={manager.dailyBriefTime} /></label>
          <label><input className="inline-input" type="checkbox" name="dailyBriefEnabled" defaultChecked={manager.dailyBriefEnabled} /> Daily brief enabled</label>
          <label>New password (optional)<input name="password" type="password" minLength={12} autoComplete="new-password" /></label>
          <button>Save project manager</button>
        </form>
      ))}
      {admin.role !== "PROJECT_MANAGER" && (
        <form action={saveProjectManager} className="card settings-form">
          <h3>Invite project manager</h3>
          <label>Name<input name="name" defaultValue={config.PROJECT_MANAGER_NAME} required /></label>
          <label>Email<input name="email" type="email" defaultValue={config.PROJECT_MANAGER_EMAIL ?? ""} required /></label>
          <label>Phone<input name="phone" defaultValue={config.PROJECT_MANAGER_PHONE ?? ""} /></label>
          <label>Notification channel<select name="notificationChannel" defaultValue="EMAIL"><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="BOTH">Email and SMS</option></select></label>
          <label>Daily brief time<input name="dailyBriefTime" type="time" defaultValue={config.PROJECT_MANAGER_DAILY_BRIEF_TIME} /></label>
          <label><input className="inline-input" type="checkbox" name="dailyBriefEnabled" defaultChecked={config.PROJECT_MANAGER_DAILY_BRIEF_ENABLED} /> Daily brief enabled</label>
          <label>Temporary password<input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
          <button>Create project-manager login</button>
        </form>
      )}
      <h2>Required roles by job type</h2>
      <p className="muted">Readiness uses these rules; events without a matching rule are evaluated from their assigned production team without assuming every wedding has identical staffing.</p>
      {roleRules.map(rule => <div className="card" key={rule.id}>{rule.jobType} · {rule.role.toLowerCase()} · {rule.requiredCount} required · {rule.active ? "active" : "disabled"}</div>)}
      <form action={saveRequiredRole} className="card settings-form">
        <label>Job type<input name="jobType" placeholder="Wedding Photo + Video" required /></label>
        <label>Role<select name="role"><option value="PHOTOGRAPHER">Photographer</option><option value="VIDEOGRAPHER">Videographer</option><option value="ASSISTANT">Assistant / second shooter</option></select></label>
        <label>Required count<input name="requiredCount" type="number" min="0" defaultValue="1" required /></label>
        <label><input className="inline-input" type="checkbox" name="active" defaultChecked /> Active</label>
        <button>Save staffing rule</button>
      </form>
      <h2>VSCO task capability inspection</h2>
      <div className="card">
        <p><b>Limitation:</b> A task-completion webhook confirms that a specific task was completed. It does not automatically provide the full list of all open or overdue VSCO tasks.</p>
        <p>Task webhook endpoint: <code>{config.APP_URL}/api/webhooks/vsco/task-event</code> · secret configured: <b>{String(Boolean(config.VSCO_TASK_WEBHOOK_SECRET))}</b></p>
        <form action={inspectTasks}><button>Refresh capability inspection</button></form>
      </div>
      <table><thead><tr><th>Capability</th><th>Supported</th><th>Evidence</th></tr></thead><tbody>
        {capabilities.map(item => <tr key={item.id}><td>{item.capability}</td><td>{item.supported ? "Yes" : "No"}</td><td>{item.evidence}</td></tr>)}
      </tbody></table>
      <h2>Reminder policies</h2>
      {policies.map(policy => (
        <form action={update} className="card" key={policy.id}>
          <input type="hidden" name="id" value={policy.id} />
          <b>{policy.name}</b>
          <p>{policy.offsetMinutes / 1440} days before · {policy.channel} · attempt {policy.attemptNumber}</p>
          <label>
            <input style={{ width: "auto" }} type="checkbox" name="enabled" defaultChecked={policy.active} /> Enabled
          </label>{" "}
          <button>Save</button>
        </form>
      ))}
    </>
  );
}
