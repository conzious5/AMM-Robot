import { randomUUID } from "node:crypto";
import Link from "next/link";
import { differenceInCalendarDays } from "date-fns";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  addOperationalNote,
  answerProjectManagerQuestion,
  createManualAssignment,
  markAssignmentStatus,
  pauseCommunications,
  replaceAssignment,
  resendAssignmentReminder,
  resolveOperationalAlert,
  sendManualMessage,
  setOperationalTaskCompleted,
  updatePersonContact,
  upsertManualMilestone,
} from "@/services/operations";

async function operate(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  const op = String(data.get("op"));
  const nonce = String(data.get("nonce") || randomUUID());
  if (op === "confirm" || op === "decline") {
    await markAssignmentStatus(admin.id, String(data.get("assignmentId")), op === "confirm" ? "CONFIRMED" : "DECLINED", nonce);
  }
  if (op === "resend") await resendAssignmentReminder(admin.id, String(data.get("assignmentId")), nonce);
  if (op === "resolve") await resolveOperationalAlert(admin.id, String(data.get("alertId")), nonce);
  if (op === "contact") {
    await sendManualMessage({
      adminId: admin.id,
      personId: String(data.get("personId")),
      eventId: String(data.get("eventId")),
      assignmentId: String(data.get("assignmentId")),
      channel: String(data.get("channel")) === "SMS" ? "SMS" : "EMAIL",
      text: String(data.get("message")),
      idempotencyKey: nonce,
      approved: true,
    });
  }
  if (op === "contact-update") {
    await updatePersonContact(admin.id, String(data.get("personId")), {
      email: String(data.get("email") || ""),
      phone: String(data.get("phone") || ""),
    }, nonce);
  }
  if (op === "replace") await replaceAssignment(admin.id, String(data.get("assignmentId")), String(data.get("replacementPersonId")), nonce);
  if (op === "create-assignment") {
    const role = String(data.get("role"));
    if (!["PHOTOGRAPHER", "VIDEOGRAPHER", "ASSISTANT", "OTHER"].includes(role)) throw new Error("Invalid assignment role.");
    await createManualAssignment(admin.id, String(data.get("eventId")), String(data.get("personId")), role as "PHOTOGRAPHER" | "VIDEOGRAPHER" | "ASSISTANT" | "OTHER", nonce);
  }
  if (op === "event-note") await addOperationalNote(admin.id, "event", String(data.get("eventId")), String(data.get("note")), nonce);
  if (op === "pause-event" || op === "resume-event") await pauseCommunications(admin.id, "event", String(data.get("eventId")), op === "pause-event", nonce);
  if (op === "milestone") {
    await upsertManualMilestone({
      adminId: admin.id,
      eventId: String(data.get("eventId")),
      name: String(data.get("name")),
      dueAt: data.get("dueAt") ? new Date(String(data.get("dueAt"))) : undefined,
      critical: data.get("critical") === "on",
      completed: data.get("completed") === "on",
      idempotencyKey: nonce,
    });
  }
  if (op === "task-complete" || op === "task-reopen") {
    await setOperationalTaskCompleted(admin.id, String(data.get("taskId")), op === "task-complete", nonce);
  }
  revalidatePath("/operations");
}

async function ask(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  const question = String(data.get("question"));
  const answer = await answerProjectManagerQuestion(admin.id, question);
  await db.setting.upsert({
    where: { key: `project-manager-agent:last:${admin.id}` },
    update: { value: { question, answer, at: new Date().toISOString() } },
    create: { key: `project-manager-agent:last:${admin.id}`, value: { question, answer, at: new Date().toISOString() } },
  });
  revalidatePath("/operations");
}

function reasons(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

export default async function Page() {
  const admin = await requireAdmin();
  const now = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 86400000);
  const [events, alerts, changes, actions, people, agentResult, conflicts] = await Promise.all([
    db.event.findMany({
      where: { startsAt: { gte: now }, canceled: false },
      include: {
        assignments: { where: { active: true }, include: { person: true, messages: true, plannedActions: true } },
        operationalTasks: { where: { status: { notIn: ["DELETED"] } }, orderBy: { dueAt: "asc" } },
        messages: { include: { person: true }, orderBy: { createdAt: "desc" }, take: 20 },
        plannedActions: { where: { status: { in: ["PLANNED", "QUEUED", "FAILED"] } }, orderBy: { scheduledFor: "asc" } },
      },
      orderBy: { startsAt: "asc" },
    }),
    db.operationalAlert.findMany({ where: { status: "OPEN" }, include: { event: true, person: true, assignment: true }, orderBy: [{ severity: "asc" }, { firstSeenAt: "asc" }] }),
    db.eventChange.findMany({ include: { event: true }, orderBy: { createdAt: "desc" }, take: 25 }),
    db.plannedAction.findMany({ where: { status: { in: ["PLANNED", "QUEUED", "FAILED"] } }, include: { event: true, person: true }, orderBy: { scheduledFor: "asc" }, take: 25 }),
    db.person.findMany({ where: { active: true }, orderBy: { displayName: "asc" } }),
    db.setting.findUnique({ where: { key: `project-manager-agent:last:${admin.id}` } }),
    db.operationalAlert.count({ where: { status: "OPEN", type: "SCHEDULING_CONFLICT" } }),
  ]);
  const ready = events.filter(event => event.readinessStatus === "READY");
  const needsAttention = events.filter(event => event.readinessStatus !== "READY");
  const count = (status: string) => events.filter(event => event.readinessStatus === status).length;
  const unfilled = alerts.filter(alert => alert.type === "REQUIRED_ROLE_UNFILLED").length;
  const unconfirmed = events.reduce((total, event) => total + event.assignments.filter(item => item.confirmationStatus !== "CONFIRMED").length, 0);
  const withinSeven = events.filter(event => event.startsAt <= sevenDays).length;
  const lastAgent = agentResult?.value as { question?: string; answer?: string } | null;

  return (
    <>
      <h1>Project-Manager Operations</h1>
      <p className="muted">Readiness, staffing, communication, tasks, and intervention controls for Authentic Moments.</p>

      <section className="grid">
        {[
          ["Ready", count("READY")],
          ["Waiting", count("WAITING_FOR_CONFIRMATION")],
          ["At risk", count("AT_RISK")],
          ["Incomplete", count("INCOMPLETE")],
          ["Changed", count("CHANGED_SINCE_CONFIRMATION")],
          ["Within 7 days", withinSeven],
          ["Unfilled roles", unfilled],
          ["Unconfirmed", unconfirmed],
          ["Conflicts", conflicts],
        ].map(([label, value]) => (
          <div className="card" key={label}><div className="muted">{label}</div><div className="metric">{value}</div></div>
        ))}
      </section>

      <h2>Ask the operations agent</h2>
      <form action={ask} className="card agent-question">
        <input name="question" required placeholder="Which weddings need my attention?" />
        <button>Ask</button>
      </form>
      {lastAgent?.answer && <pre className="card agent-answer">{lastAgent.answer}</pre>}

      <h2>Needs project-manager attention</h2>
      {needsAttention.length === 0 && <div className="card ready">All upcoming events are currently ready.</div>}
      {needsAttention.map(event => {
        const eventAlerts = alerts.filter(alert => alert.eventId === event.id);
        const eventReasons = reasons(event.readinessReasons);
        const lastResponse = event.messages.find(message => message.direction === "INBOUND");
        const nextAction = event.plannedActions[0];
        return (
          <article className="card operations-event" id={`event-${event.id}`} key={event.id}>
            <div className="operations-heading">
              <div>
                <h3>{event.name}</h3>
                <p>{event.startsAt.toLocaleString()} · {differenceInCalendarDays(event.startsAt, now)} days remaining</p>
                <span className="pill">{event.readinessStatus.replaceAll("_", " ")}</span>
              </div>
              {event.administrativeUrl && <Link className="button secondary" href={event.administrativeUrl}>Open VSCO job</Link>}
            </div>
            <ul>{eventReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            <div className="operations-context">
              <span><b>Messages sent:</b> {event.messages.filter(message => message.direction === "OUTBOUND").length}</span>
              <span><b>Last response:</b> {lastResponse ? `${lastResponse.person.displayName} · ${lastResponse.textContent.slice(0, 100)}` : "None"}</span>
              <span><b>Next action:</b> {nextAction ? `${nextAction.scheduledFor.toLocaleString()} · ${nextAction.reason}` : "None planned"}</span>
            </div>

            {eventAlerts.map(alert => (
              <div className="alert-row" key={alert.id}>
                <div><b>{alert.severity}</b> · {alert.reason}<br /><span className="muted">{alert.recommendedAction}</span></div>
                <form action={operate}>
                  <input type="hidden" name="nonce" value={`resolve:${alert.id}:${randomUUID()}`} />
                  <input type="hidden" name="alertId" value={alert.id} />
                  <button name="op" value="resolve">Resolve alert</button>
                </form>
              </div>
            ))}

            <h4>Assignments</h4>
            {event.assignments.map(assignment => (
              <details className="assignment-control" key={assignment.id}>
                <summary>
                  <b>{assignment.person.displayName}</b> · {assignment.role.toLowerCase()} · <span className="pill">{assignment.confirmationStatus}</span>
                </summary>
                <div className="control-grid">
                  <form action={operate} className="card">
                    <input type="hidden" name="nonce" value={`status:${assignment.id}:${randomUUID()}`} />
                    <input type="hidden" name="assignmentId" value={assignment.id} />
                    <b>Confirmation</b>
                    <div className="action-controls">
                      <button name="op" value="confirm">Mark confirmed</button>
                      <button className="secondary" name="op" value="decline">Mark declined</button>
                      <button name="op" value="resend">Resend reminder</button>
                    </div>
                  </form>
                  <form action={operate} className="card">
                    <input type="hidden" name="nonce" value={`contact:${assignment.id}:${randomUUID()}`} />
                    <input type="hidden" name="personId" value={assignment.personId} />
                    <b>Correct contact details</b>
                    <input name="email" type="email" defaultValue={assignment.person.email ?? ""} placeholder="Email" />
                    <input name="phone" defaultValue={assignment.person.phone ?? ""} placeholder="+1…" />
                    <button name="op" value="contact-update">Save contact</button>
                  </form>
                  <form action={operate} className="card">
                    <input type="hidden" name="nonce" value={`message:${assignment.id}:${randomUUID()}`} />
                    <input type="hidden" name="assignmentId" value={assignment.id} />
                    <input type="hidden" name="eventId" value={event.id} />
                    <input type="hidden" name="personId" value={assignment.personId} />
                    <b>Contact contractor</b>
                    <select name="channel" defaultValue={assignment.person.phone ? "SMS" : "EMAIL"}>
                      <option value="EMAIL">Email</option><option value="SMS">SMS</option>
                    </select>
                    <textarea name="message" required placeholder="Message" />
                    <button name="op" value="contact">Review target and send</button>
                  </form>
                  <form action={operate} className="card">
                    <input type="hidden" name="nonce" value={`replace:${assignment.id}:${randomUUID()}`} />
                    <input type="hidden" name="assignmentId" value={assignment.id} />
                    <b>Replace assignment</b>
                    <select name="replacementPersonId" required>
                      <option value="">Choose replacement…</option>
                      {people.filter(person => person.id !== assignment.personId).map(person => <option value={person.id} key={person.id}>{person.displayName}</option>)}
                    </select>
                    <button name="op" value="replace">Replace and start confirmation</button>
                  </form>
                </div>
              </details>
            ))}

            <div className="control-grid">
              <form action={operate} className="card">
                <input type="hidden" name="nonce" value={`create-assignment:${event.id}:${randomUUID()}`} />
                <input type="hidden" name="eventId" value={event.id} />
                <b>Create manual assignment</b>
                <select name="personId" required>
                  <option value="">Choose contractor…</option>
                  {people.map(person => <option value={person.id} key={person.id}>{person.displayName}</option>)}
                </select>
                <select name="role" defaultValue="PHOTOGRAPHER">
                  <option value="PHOTOGRAPHER">Photographer</option>
                  <option value="VIDEOGRAPHER">Videographer</option>
                  <option value="ASSISTANT">Assistant</option>
                </select>
                <button name="op" value="create-assignment">Create and start confirmation</button>
              </form>
              <form action={operate} className="card">
                <input type="hidden" name="nonce" value={`note:${event.id}:${randomUUID()}`} />
                <input type="hidden" name="eventId" value={event.id} />
                <b>Internal event note</b>
                <textarea name="note" defaultValue={event.internalNotes ?? ""} />
                <button name="op" value="event-note">Save note</button>
              </form>
              <form action={operate} className="card">
                <input type="hidden" name="nonce" value={`pause:${event.id}:${randomUUID()}`} />
                <input type="hidden" name="eventId" value={event.id} />
                <b>Communications</b>
                <p className="muted">{event.paused ? "Paused" : "Active"}</p>
                <button name="op" value={event.paused ? "resume-event" : "pause-event"}>{event.paused ? "Resume" : "Pause"} event communications</button>
              </form>
              <form action={operate} className="card">
                <input type="hidden" name="nonce" value={`milestone:${event.id}:${randomUUID()}`} />
                <input type="hidden" name="eventId" value={event.id} />
                <b>Add local critical milestone</b>
                <input name="name" required placeholder="Timeline received" />
                <input name="dueAt" type="datetime-local" />
                <label><input className="inline-input" type="checkbox" name="critical" /> Blocks readiness</label>
                <label><input className="inline-input" type="checkbox" name="completed" /> Already completed</label>
                <button name="op" value="milestone">Add milestone</button>
              </form>
            </div>

            {event.operationalTasks.length > 0 && <>
              <h4>Tasks and milestones</h4>
              <ul>{event.operationalTasks.map(task => <li key={task.id}>
                {task.name} · {task.status.replaceAll("_", " ").toLowerCase()} · {task.source.replaceAll("_", " ").toLowerCase()}{task.criticalForReadiness ? " · blocks readiness" : ""}
                <form action={operate} className="inline-form">
                  <input type="hidden" name="nonce" value={`task:${task.id}:${randomUUID()}`} />
                  <input type="hidden" name="taskId" value={task.id} />
                  <button name="op" value={task.status === "COMPLETED" ? "task-reopen" : "task-complete"}>{task.status === "COMPLETED" ? "Reopen" : "Complete"}</button>
                </form>
              </li>)}</ul>
            </>}
          </article>
        );
      })}

      <h2>Ready to go</h2>
      <table><thead><tr><th>Event</th><th>Date</th><th>Venue</th><th>Staff</th></tr></thead><tbody>
        {ready.map(event => <tr key={event.id}><td>{event.name}</td><td>{event.startsAt.toLocaleString()}</td><td>{event.venueName ?? "Pending"}</td><td>{event.assignments.map(item => `${item.person.displayName} (${item.role.toLowerCase()})`).join(", ")}</td></tr>)}
      </tbody></table>

      <h2>Recent VSCO changes</h2>
      <table><thead><tr><th>When</th><th>Event</th><th>Field</th><th>Change</th></tr></thead><tbody>
        {changes.map(change => <tr key={change.id}><td>{change.createdAt.toLocaleString()}</td><td>{change.event.name}</td><td>{change.field}</td><td><span className="muted">{String(change.oldValue ?? "—")}</span> → {String(change.newValue ?? "—")}</td></tr>)}
      </tbody></table>

      <h2>Upcoming robot actions</h2>
      <table><thead><tr><th>When</th><th>Person</th><th>Event</th><th>Action</th><th>Status</th></tr></thead><tbody>
        {actions.map(action => <tr key={action.id}><td>{action.scheduledFor.toLocaleString()}</td><td>{action.person?.displayName ?? "System"}</td><td>{action.event?.name ?? "—"}</td><td>{action.reason}</td><td><span className="pill">{action.status}</span></td></tr>)}
      </tbody></table>
    </>
  );
}
