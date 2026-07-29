import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { db } from "@/lib/db";
import { OperationStatusSummary } from "@/components/OperationStatusSummary";
import { requireAdmin } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { dismissOperationError, getOperationOverview, plainStatus, type OperationTone } from "@/services/operation-status";
import { resolveOperationalAlert } from "@/services/operations";

type RunRow = {
  key: string;
  when: Date;
  area: string;
  status: string;
  tone: OperationTone;
  icon: string;
  summary: string;
};

function actionName(type: string) {
  if (type === "SYSTEM_INTRO") return "Introduce the Authentic Moments reminder number";
  if (type === "REMINDER") return "Send an assignment reminder";
  if (type === "ESCALATE") return "Escalate an unconfirmed assignment";
  if (type === "AGENT_REPLY") return "Reply to an incoming message";
  return type.replaceAll("_", " ").toLowerCase();
}

async function dismissError(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  assertPermission(admin, "alerts:resolve");
  const key = String(data.get("errorKey") || "");
  if (key.startsWith("alert:")) {
    await resolveOperationalAlert(admin.id, key.slice("alert:".length), `dismiss:${key}:${randomUUID()}`);
  } else {
    await dismissOperationError(admin.id, key);
  }
  revalidatePath("/");
  revalidatePath("/logs");
  revalidatePath("/operations");
}

export default async function Page() {
  const [sync, audit, webhooks, agents, actions, overview] = await Promise.all([
    db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 25 }),
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 25 }),
    db.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
    db.plannedAction.findMany({
      include: { person: true, event: true },
      orderBy: { updatedAt: "desc" },
      take: 25,
    }),
    getOperationOverview(),
  ]);

  const runs: RunRow[] = [
    ...sync.map(run => {
      const status = plainStatus(run.status);
      return {
        key: `sync:${run.id}`,
        when: run.completedAt ?? run.startedAt,
        area: "VSCO schedule",
        status: status.label,
        tone: status.tone,
        icon: status.icon,
        summary: `Checked VSCO: ${run.itemsFetched} found, ${run.itemsUpdated} updated, ${run.itemsFailed} failed.`,
      };
    }),
    ...agents.map(run => {
      const status = plainStatus(run.status);
      return {
        key: `agent:${run.id}`,
        when: run.createdAt,
        area: "Scheduling assistant",
        status: status.label,
        tone: status.tone,
        icon: status.icon,
        summary: run.error ? `Could not finish: ${run.error}` : `Finished using ${run.model}.`,
      };
    }),
    ...actions.map(action => {
      const status = plainStatus(action.status);
      const target = action.person?.displayName ?? action.event?.name;
      return {
        key: `action:${action.id}`,
        when: action.completedAt ?? action.updatedAt,
        area: "Robot action",
        status: status.label,
        tone: status.tone,
        icon: status.icon,
        summary: `${actionName(action.type)}${target ? ` · ${target}` : ""}${action.lastError ? ` · ${action.lastError}` : ""}`,
      };
    }),
  ].sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, 50);

  return (
    <>
      <h1>Operational Logs</h1>
      <p className="muted">Plain-language health first, detailed technical records below.</p>

      <h2>Current operation summary</h2>
      <OperationStatusSummary items={overview.summaries} />
      <p className="status-checked">Last checked {overview.checkedAt.toLocaleString()}</p>

      <section id="errors">
        <div className="section-heading">
          <div>
            <h2>Errors and urgent items</h2>
            <p className="muted">Open an item for its source. Dismiss removes it from this current summary only; the detailed record and audit history remain.</p>
          </div>
          <Link className="button secondary" href="/operations">Open Operations</Link>
        </div>
        {overview.errors.length === 0 ? (
          <div className="card ready">✓ No current errors or urgent items.</div>
        ) : (
          <table className="error-table">
            <thead><tr><th>Status</th><th>When</th><th>Area</th><th>What happened</th><th>What it means</th><th>Action</th></tr></thead>
            <tbody>
              {overview.errors.map(error => (
                <tr className="error-log-row" key={error.key}>
                  <td><span className="status-badge status-error"><span aria-hidden="true">×</span> Error</span></td>
                  <td>{error.when.toLocaleString()}</td>
                  <td>{error.area}</td>
                  <td><Link href={error.href}><b>{error.summary}</b><br /><u>Open item →</u></Link></td>
                  <td>{error.detail}</td>
                  <td>
                    {error.dismissible ? (
                      <form action={dismissError}>
                        <input type="hidden" name="errorKey" value={error.key} />
                        <button className="secondary">Dismiss</button>
                      </form>
                    ) : <span className="muted">Still active</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <h2>Recent robot runs</h2>
      <p className="muted">A short record of what the robot ran and whether it worked.</p>
      <table>
        <thead><tr><th>Status</th><th>When</th><th>Area</th><th>Plain summary</th></tr></thead>
        <tbody>
          {runs.map(run => (
            <tr className={run.tone === "error" ? "error-log-row" : undefined} key={run.key}>
              <td><span className={`status-badge status-${run.tone}`}><span aria-hidden="true">{run.icon}</span> {run.status}</span></td>
              <td>{run.when.toLocaleString()}</td>
              <td>{run.area}</td>
              <td>{run.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>VSCO synchronization</h2>
      <table>
        <thead><tr><th>Status</th><th>Started</th><th>Finished</th><th>Found</th><th>Updated</th><th>Skipped</th><th>Failed</th><th>Details</th></tr></thead>
        <tbody>
          {sync.map(run => {
            const status = plainStatus(run.status);
            const isError = status.tone === "error" || run.itemsFailed > 0;
            return (
              <tr className={isError ? "error-log-row" : undefined} id={`sync-${run.id}`} key={run.id}>
                <td><span className={`status-badge status-${isError ? "error" : status.tone}`}><span aria-hidden="true">{isError ? "×" : status.icon}</span> {isError ? "Needs attention" : status.label}</span></td>
                <td>{run.startedAt.toLocaleString()}</td>
                <td>{run.completedAt?.toLocaleString() ?? "Still running"}</td>
                <td>{run.itemsFetched}</td>
                <td>{run.itemsUpdated}</td>
                <td>{run.itemsSkipped}</td>
                <td>{run.itemsFailed}</td>
                <td>{run.errorSummary ?? (run.itemsFailed ? "Some VSCO items could not be updated." : "No errors.")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Provider updates</h2>
      <p className="muted">Delivery receipts and incoming-message updates from Quo and Resend.</p>
      <table>
        <thead><tr><th>Status</th><th>Received</th><th>Provider</th><th>Update</th><th>Result</th></tr></thead>
        <tbody>
          {webhooks.map(webhook => {
            const status = plainStatus(webhook.status);
            return (
              <tr className={status.tone === "error" ? "error-log-row" : undefined} id={`webhook-${webhook.id}`} key={webhook.id}>
                <td><span className={`status-badge status-${status.tone}`}><span aria-hidden="true">{status.icon}</span> {status.label}</span></td>
                <td>{webhook.receivedAt.toLocaleString()}</td>
                <td>{webhook.provider}</td>
                <td>{webhook.type}</td>
                <td>{webhook.error ?? "Processed normally."}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Scheduling-assistant runs</h2>
      <table>
        <thead><tr><th>Status</th><th>When</th><th>Model</th><th>Result</th></tr></thead>
        <tbody>
          {agents.map(run => {
            const status = plainStatus(run.status);
            return (
              <tr className={status.tone === "error" ? "error-log-row" : undefined} id={`agent-${run.id}`} key={run.id}>
                <td><span className={`status-badge status-${status.tone}`}><span aria-hidden="true">{status.icon}</span> {status.label}</span></td>
                <td>{run.createdAt.toLocaleString()}</td>
                <td>{run.model}</td>
                <td>{run.error ?? "Finished normally."}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Audit history</h2>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th></tr></thead>
        <tbody>
          {audit.map(entry => (
            <tr key={entry.id}>
              <td>{entry.createdAt.toLocaleString()}</td>
              <td>{entry.actorType.toLowerCase().replaceAll("_", " ")}</td>
              <td>{entry.action.toLowerCase().replaceAll("_", " ")}</td>
              <td>{entry.entityType}{entry.entityId ? ` · ${entry.entityId}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
