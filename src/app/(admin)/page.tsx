import Link from "next/link";
import { db } from "@/lib/db";
import { OperationStatusSummary } from "@/components/OperationStatusSummary";
import { getOperationOverview } from "@/services/operation-status";

export default async function Dashboard() {
  const now = new Date();
  const [events, upcomingCount, pending, confirmed, declined, failed, actions, messages, sync, ready, needsAttention, overview] = await Promise.all([
    db.event.findMany({
      where: { startsAt: { gte: now }, canceled: false },
      include: { assignments: { include: { person: true } } },
      orderBy: { startsAt: "asc" },
      take: 10,
    }),
    db.event.count({ where: { startsAt: { gte: now }, canceled: false } }),
    db.assignment.count({ where: { active: true, person: { active: true }, event: { startsAt: { gte: now }, canceled: false }, confirmationStatus: "PENDING" } }),
    db.assignment.count({ where: { active: true, person: { active: true }, event: { startsAt: { gte: now }, canceled: false }, confirmationStatus: "CONFIRMED" } }),
    db.assignment.count({ where: { active: true, person: { active: true }, event: { startsAt: { gte: now }, canceled: false }, confirmationStatus: "DECLINED" } }),
    db.message.count({ where: { deliveryStatus: { in: ["FAILED", "BOUNCED", "COMPLAINED"] } } }),
    db.plannedAction.findMany({
      where: { status: { in: ["PLANNED", "QUEUED"] }, event: { startsAt: { gte: now }, canceled: false }, person: { active: true } },
      include: { person: true, event: true },
      orderBy: { scheduledFor: "asc" },
      take: 8,
    }),
    db.message.findMany({ where: { direction: "INBOUND" }, include: { person: true }, orderBy: { createdAt: "desc" }, take: 6 }),
    db.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.event.count({ where: { startsAt: { gte: now }, canceled: false, readinessStatus: "READY" } }),
    db.event.count({ where: { startsAt: { gte: now }, canceled: false, readinessStatus: { in: ["AT_RISK", "INCOMPLETE", "CHANGED_SINCE_CONFIRMATION"] } } }),
    getOperationOverview(),
  ]);

  return (
    <>
      <h1>Operations Dashboard</h1>
      <p className="muted">Confirmation and communication status at a glance.</p>

      {overview.errorCount > 0 && (
        <div className="system-error-banner" role="alert">
          <div>
            <b>× AMM Robot needs attention</b>
            <span>{overview.errorCount} error or urgent item{overview.errorCount === 1 ? "" : "s"} need review.</span>
          </div>
          <Link className="button danger-button" href="/logs#errors">View error logs</Link>
        </div>
      )}

      <h2>System status</h2>
      <OperationStatusSummary items={overview.summaries} />

      <section className="grid dashboard-metrics">
        {[
          ["Upcoming weddings", upcomingCount],
          ["Ready", ready],
          ["Needs attention", needsAttention],
          ["Awaiting confirmation", pending],
          ["Confirmed", confirmed],
          ["Declined", declined],
          ["Failed delivery", failed],
        ].map(([label, value]) => (
          <div className="card" key={label}>
            <div className="muted">{label}</div>
            <div className="metric">{value}</div>
          </div>
        ))}
      </section>

      <h2>Next 10 upcoming weddings</h2>
      <table>
        <thead><tr><th>Event</th><th>Date</th><th>Team</th><th>Readiness</th></tr></thead>
        <tbody>
          {events.map(event => (
            <tr key={event.id}>
              <td>{event.name}<div className="muted">{event.venueName ?? "Venue pending"}</div></td>
              <td>{event.startsAt.toLocaleString()}</td>
              <td>{event.assignments.filter(assignment => assignment.active && assignment.person.active).map(assignment => <div key={assignment.id}>{assignment.person.displayName} · {assignment.role.toLowerCase()}</div>)}</td>
              <td>
                <span className="pill">{event.readinessStatus.replaceAll("_", " ")}</span>
                {Array.isArray(event.readinessReasons) && event.readinessReasons.length > 0 && <div className="muted">{event.readinessReasons.map(String).slice(0, 2).join("; ")}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Next planned actions</h2>
      <table>
        <tbody>
          {actions.map(action => <tr key={action.id}><td>{action.scheduledFor.toLocaleString()}</td><td>{action.person?.displayName}</td><td>{action.event?.name}</td><td>{action.channel}</td><td>{action.status}</td></tr>)}
        </tbody>
      </table>

      <h2>Integration health</h2>
      <div className="card">
        <b>Latest VSCO sync:</b> {sync ? `${sync.status} · ${sync.startedAt.toLocaleString()}` : "Never run"}
        {sync?.errorSummary && <p className="danger">{sync.errorSummary}</p>}
        <p>Recent inbound messages: {messages.length}</p>
      </div>
    </>
  );
}
