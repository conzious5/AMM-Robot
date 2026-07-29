import { requireAdmin } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
export default async function Layout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return <AdminShell admin={admin}>{children}</AdminShell>;
}
