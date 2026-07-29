import Link from "next/link";
import { env } from "@/lib/env";
const links = [["/","Dashboard"],["/events","Events"],["/people","People"],["/confirmations","Confirmations"],["/actions","Planned Actions"],["/conversations","Conversations"],["/logs","Logs"],["/settings","Settings"]];
export function AdminShell({ children }: { children: React.ReactNode }) { return <>{env().TEST_MODE && <div className="banner">TEST MODE — all outbound communication is redirected</div>}<nav><h1>Authentic Moments</h1>{links.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}</nav><main className="shell">{children}</main></>; }
