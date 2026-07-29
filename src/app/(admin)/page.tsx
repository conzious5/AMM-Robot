import Link from "next/link";
import { db } from "@/lib/db";
import { OperationStatusSummary } from "@/components/OperationStatusSummary";
import { getOperationOverview } from "@/services/operation-status";
import { communicationChannelLabel } from "@/lib/channels";
import { launchIncludedEventWhere } from "@/lib/launch-cutoff";
import { formatInTimeZone } from "date-fns-tz";

function displayDateTime(date: Date, timezone = "America/Denver") {
  return formatInTimeZone(date, timezone, "M/d/yyyy, h:mm a zzz");
}

export default async function Dashboard() {
  const now = new Date();
  const [events, upcomingCount, pending, confirmed, declined, failed, actions, messages, sync, ready, needsAttention, overview] = await Promise.all([
    db.event.findMany({
      where: { startsAt: { gte: now }, canceled: false, ...launchIncludedEventWhere },
      include: { assignments: { include: { person: true } } },
      orderBy: { startsAt: "asc" },
      take: 10,
    }),
    db.event.count({ where: { startsAt: { gte: now }, canceled: false, ...launchIncludedEventWhere } }),
    db.assignment.count({ where: { active: true, person: { active: true }, event: { startsAt: { gte: now }, canceled: false, ...launchIncludedEventWhere }, confirmationStatus: "PENDING" } }),
    db.assignment.count({ where: { active: true, person: { active: true }, event: { startsAt: { gte: now }, canceled: false, ...launchIncludedEventWhere }, confirmationStatus: "CONFIRMED" } }),
    db.assignment.count({ where: { active: true, person: { active: true }, event: { startsAt: { gte: now }, canceled: false, ...launchIncludedEventWhere }, confirmationStatus: "DECLINED" } }),
    db.message.count({ where: { deliveryStatus: { in: ["FAILED", "BOUNCED", "COMPLAINED"] } } }),
    db.plannedAction.findMany({
      where: { status: { in: ["PLANNED", "QUEUED"] }, event: { startsAt: { gte: now }, canceled: false, ...launchIncludedEventWhere }, person: { active: true } },
      include: { person: true, event: true },
      orderBy: { scheduledFor: "asc" },
      take: 8,
    }),
    db.message.findMany({ where: { direction: "INBOUND" }, include: { person: true }, orderBy: { createdAt: "desc" }, take: 6 }),
    db.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.event.count({ where: { startsAt: { gte: now }, canceled: false, readinessStatus: "READY", ...launchIncludedEventWhere } }),
    db.event.count({ where: { startsAt: { gte: now }, canceled: false, readinessStatus: { in: ["AT_RISK", "INCOMPLETE", "CHANGED_SINCE_CONFIRMATION"] }, ...launchIncludedEventWhere } }),
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
              <td>{displayDateTime(event.startsAt, event.timezone)}</td>
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
      <p className="muted">Maximum: one automated reminder per contractor per local calendar day. The delivery method is shown for every action.</p>
      <table>
        <thead><tr><th>When</th><th>Contractor</th><th>Wedding</th><th>Communication</th><th>Status</th></tr></thead>
        <tbody>
          {actions.map(action => <tr key={action.id}><td>{displayDateTime(action.scheduledFor, action.person?.timezone ?? action.event?.timezone)}</td><td>{action.person?.displayName}</td><td>{action.event?.name}</td><td><span className="pill">{communicationChannelLabel(action.channel)}</span></td><td>{action.status}</td></tr>)}
        </tbody>
      </table>

      <h2>Integration health</h2>
      <div className="card">
        <b>Latest VSCO sync:</b> {sync ? `${sync.status} · ${displayDateTime(sync.startedAt)}` : "Never run"}
        {sync?.errorSummary && <p className="danger">{sync.errorSummary}</p>}
        <p>Recent inbound messages: {messages.length}</p>
      </div>
    </>
  );
}
