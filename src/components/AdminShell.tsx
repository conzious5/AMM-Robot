import Link from "next/link";
import type { Administrator } from "@prisma/client";
import { env } from "@/lib/env";
import type { CommunicationServiceStatus } from "@/services/service-control";
const administratorLinks = [["/","Dashboard"],["/operations","Operations"],["/events","Events"],["/people","People"],["/wedgewood-contacts","Wedgewood Contacts"],["/confirmations","Confirmations"],["/actions","Planned Actions"],["/conversations","Conversations"],["/logs","Logs"],["/guide","Guide"],["/settings","Settings"]];
const projectManagerLinks = [["/","Dashboard"],["/operations","Operations"],["/events","Events"],["/people","People"],["/wedgewood-contacts","Wedgewood Contacts"],["/confirmations","Confirmations"],["/actions","Planned Actions"],["/conversations","Conversations"],["/guide","How to Use"],["/settings","My Settings"]];
export function AdminShell({
  children,
  admin,
  serviceStatus,
  toggleService,
  logout,
}: {
  children: React.ReactNode;
  admin: Administrator;
  serviceStatus: CommunicationServiceStatus;
  toggleService: (data: FormData) => Promise<void>;
  logout: () => Promise<void>;
}) {
  const links = admin.role === "PROJECT_MANAGER" ? projectManagerLinks : administratorLinks;
  const active = serviceStatus === "ACTIVE";
  return <>
    {env().TEST_MODE && <div className="banner">TEST MODE — all outbound communication is redirected</div>}
    <nav>
      <h1>Authentic Moments</h1>
      <div className="nav-user">{admin.name}<small>{admin.role.replaceAll("_", " ").toLowerCase()}</small></div>
      {links.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}
      <form action={logout}><button className="secondary">Sign out</button></form>
    </nav>
    <aside className={`service-switch ${active ? "service-active" : "service-suspended"}`} aria-label="Communication service status">
      <span className="service-state"><span className="service-dot" aria-hidden="true" /> Service {active ? "active" : "suspended"}</span>
      {admin.role === "ADMIN" && (
        <form action={toggleService}>
          <input type="hidden" name="status" value={active ? "SUSPENDED" : "ACTIVE"} />
          <button className={active ? "suspend-button" : undefined}>{active ? "Suspend" : "Activate"}</button>
        </form>
      )}
    </aside>
    <main className="shell">{children}</main>
  </>;
}
