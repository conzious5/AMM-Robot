import Link from "next/link";
import type { Administrator } from "@prisma/client";
import { env } from "@/lib/env";
const administratorLinks = [["/","Dashboard"],["/operations","Operations"],["/events","Events"],["/people","People"],["/confirmations","Confirmations"],["/actions","Planned Actions"],["/conversations","Conversations"],["/logs","Logs"],["/guide","Guide"],["/settings","Settings"]];
const projectManagerLinks = [["/","Dashboard"],["/operations","Operations"],["/events","Events"],["/people","People"],["/confirmations","Confirmations"],["/actions","Planned Actions"],["/conversations","Conversations"],["/guide","How to Use"],["/settings","My Settings"]];
export function AdminShell({ children, admin }: { children: React.ReactNode; admin: Administrator }) {
  const links = admin.role === "PROJECT_MANAGER" ? projectManagerLinks : administratorLinks;
  return <>
    {env().TEST_MODE && <div className="banner">TEST MODE — all outbound communication is redirected</div>}
    <nav>
      <h1>Authentic Moments</h1>
      <div className="nav-user">{admin.name}<small>{admin.role.replaceAll("_", " ").toLowerCase()}</small></div>
      {links.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}
    </nav>
    <main className="shell">{children}</main>
  </>;
}
