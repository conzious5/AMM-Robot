import Link from "next/link";
import { randomUUID } from "node:crypto";
import { formatDistanceToNow } from "date-fns";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { DataTable } from "@/components/DataTable";
import { requireAdmin } from "@/lib/auth";
import {
  cancelPlannedCommunication,
  reschedulePlannedCommunication,
  sendPlannedCommunicationNow,
  skipPlannedReminder,
} from "@/services/operations";

const activeStatuses = ["PLANNED", "QUEUED", "PROCESSING", "FAILED", "WAITING_FOR_APPROVAL"] as const;
type View = "next" | "history" | "all";

async function mutate(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  const id = String(data.get("id"));
  const op = String(data.get("op"));
  const nonce = String(data.get("nonce"));
  if (op === "skip") await skipPlannedReminder(admin.id, id, nonce);
  if (op === "send") await sendPlannedCommunicationNow(admin.id, id, nonce);
  if (op === "cancel") await cancelPlannedCommunication(admin.id, id, nonce);
  if (op === "reschedule") await reschedulePlannedCommunication(admin.id, id, new Date(String(data.get("scheduledFor"))), nonce);
  revalidatePath("/actions");
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const requested = (await searchParams).view;
  const view: View = requested === "history" || requested === "all" ? requested : "next";
  const policies = await db.reminderPolicy.findMany({
    where: { active: true },
    orderBy: { attemptNumber: "asc" },
  });
  const policySteps = new Map(policies.map(policy => [policy.name, policy.attemptNumber]));
  const data = await db.plannedAction.findMany({
    where: view === "next"
      ? { status: { in: [...activeStatuses] } }
      : view === "history"
        ? { status: { notIn: [...activeStatuses] } }
        : undefined,
    include: { person: true, event: true, assignment: true },
    orderBy: view === "history" ? { updatedAt: "desc" } : { scheduledFor: "asc" },
    take: 200,
  });

  return (
    <>
      <h1>Planned Actions</h1>
      <p className="muted">
        Only the next reminder is planned for each assignment. After it sends, the following step appears only if the contractor is still unconfirmed.
      </p>
      <div className="view-tabs">
        <Link className={`button ${view === "next" ? "" : "secondary"}`} href="/actions">Next actions</Link>
        <Link className={`button ${view === "history" ? "" : "secondary"}`} href="/actions?view=history">History</Link>
        <Link className={`button ${view === "all" ? "" : "secondary"}`} href="/actions?view=all">All</Link>
      </div>
      <div className="card action-summary">
        <b>{data.length} {view === "next" ? "current next actions" : view === "history" ? "historical actions" : "actions shown"}</b>
        {view === "next" && <span className="muted">One active reminder at most per assignment</span>}
      </div>
      <DataTable
        columns={["Scheduled timing", "Recipient / assignment", "Sequence step", "Preview", "Status", "Controls"]}
        rows={data.map(action => {
          const step = policySteps.get(action.reason);
          const relative = action.scheduledFor > new Date()
            ? `Due ${formatDistanceToNow(action.scheduledFor, { addSuffix: true })}`
            : `Due ${formatDistanceToNow(action.scheduledFor, { addSuffix: true })}`;
          const canControl = activeStatuses.includes(action.status as typeof activeStatuses[number]);
          return [
            <span key="when">
              <b>{action.scheduledFor.toLocaleString()}</b>
              <br />
              <span className={action.scheduledFor < new Date() ? "danger" : "muted"}>{relative}</span>
            </span>,
            <span key="recipient">
              <b>{action.person?.displayName ?? "System"}</b>
              <br />
              {action.event?.name ?? "Conversation reply"}
              {action.event && <><br /><span className="muted">Ceremony: {action.event.startsAt.toLocaleString()}</span></>}
            </span>,
            <span key="step">
              {step ? <b>Step {step} of {policies.length}</b> : <b>{action.type.replaceAll("_", " ").toLowerCase()}</b>}
              <br />
              {action.reason}
              <br />
              <span className="pill">{action.channel}</span>
            </span>,
            <span key="preview">{action.messagePreview.slice(0, 150)}{action.messagePreview.length > 150 ? "…" : ""}</span>,
            <span key="status">
              <span className="pill">{action.status}</span>
              {action.lastError && <><br /><span className="muted">{action.lastError}</span></>}
            </span>,
            canControl
              ? (
                <form action={mutate} className="action-controls" key="controls">
                  <input type="hidden" name="id" value={action.id} />
                  <input type="hidden" name="nonce" value={`planned-action:${action.id}:${randomUUID()}`} />
                  <button name="op" value="send">{action.status === "FAILED" ? "Retry now" : "Send now"}</button>
                  {action.assignmentId && <button className="secondary" name="op" value="skip">Skip step</button>}
                  <button className="secondary" name="op" value="cancel">Cancel</button>
                  <input name="scheduledFor" type="datetime-local" />
                  <button className="secondary" name="op" value="reschedule">Reschedule</button>
                </form>
              )
              : "—",
          ];
        })}
      />
    </>
  );
}
