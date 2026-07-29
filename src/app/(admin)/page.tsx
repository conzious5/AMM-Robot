import { db } from "@/lib/db";
export default async function Dashboard() {
  const now = new Date();
  const [events,pending,confirmed,declined,failed,actions,messages,sync] = await Promise.all([
    db.event.findMany({ where:{startsAt:{gte:now},canceled:false},include:{assignments:{include:{person:true}}},orderBy:{startsAt:"asc"},take:10 }),
    db.assignment.count({where:{active:true,confirmationStatus:"PENDING"}}), db.assignment.count({where:{active:true,confirmationStatus:"CONFIRMED"}}),
    db.assignment.count({where:{active:true,confirmationStatus:"DECLINED"}}), db.message.count({where:{deliveryStatus:{in:["FAILED","BOUNCED"]}}}),
    db.plannedAction.findMany({where:{status:{in:["PLANNED","QUEUED"]}},include:{person:true,event:true},orderBy:{scheduledFor:"asc"},take:8}),
    db.message.findMany({where:{direction:"INBOUND"},include:{person:true},orderBy:{createdAt:"desc"},take:6}), db.syncRun.findFirst({orderBy:{startedAt:"desc"}})
  ]);
  return <><h1>Operations Dashboard</h1><p className="muted">Confirmation and communication status at a glance.</p><section className="grid">
    {[["Upcoming weddings",events.length],["Awaiting confirmation",pending],["Confirmed",confirmed],["Declined",declined],["Failed delivery",failed]].map(([x,n])=><div className="card" key={x}><div className="muted">{x}</div><div className="metric">{n}</div></div>)}
  </section><h2>Upcoming weddings</h2><table><thead><tr><th>Event</th><th>Date</th><th>Team</th><th>Status</th></tr></thead><tbody>{events.map(e=><tr key={e.id}><td>{e.name}<div className="muted">{e.venueName??"Venue pending"}</div></td><td>{e.startsAt.toLocaleString()}</td><td>{e.assignments.map(a=><div key={a.id}>{a.person.displayName} · {a.role.toLowerCase()}</div>)}</td><td><span className="pill">{e.status}</span></td></tr>)}</tbody></table>
  <h2>Next planned actions</h2><table><tbody>{actions.map(a=><tr key={a.id}><td>{a.scheduledFor.toLocaleString()}</td><td>{a.person?.displayName}</td><td>{a.event?.name}</td><td>{a.channel}</td><td>{a.status}</td></tr>)}</tbody></table>
  <h2>Integration health</h2><div className="card"><b>Latest VSCO sync:</b> {sync ? `${sync.status} · ${sync.startedAt.toLocaleString()}` : "Never run"}{sync?.errorSummary&&<p className="danger">{sync.errorSummary}</p>}<p>Recent inbound messages: {messages.length}</p></div></>;
}
