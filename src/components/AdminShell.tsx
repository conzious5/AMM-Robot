import Link from "next/link";
import type { Administrator } from "@prisma/client";
import { env } from "@/lib/env";
const links = [["/","Dashboard"],["/operations","Operations"],["/events","Events"],["/people","People"],["/confirmations","Confirmations"],["/actions","Planned Actions"],["/conversations","Conversations"],["/logs","Logs"],["/settings","Settings"]];
export function AdminShell({ children, admin }: { children: React.ReactNode; admin: Administrator }) {
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
