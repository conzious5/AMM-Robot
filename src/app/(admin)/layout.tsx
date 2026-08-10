import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { signOut } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/AdminShell";

import { getCommunicationServiceState, setCommunicationServiceStatus } from "@/services/service-control";

async function toggleCommunicationService(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  const status = String(data.get("status")) === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
  await setCommunicationServiceStatus(admin.id, status);
  revalidatePath("/", "layout");
}

async function logout() {
  "use server";
  await signOut();
  redirect("/login");
}

export default async function Layout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const service = await getCommunicationServiceState();
  return <AdminShell admin={admin} serviceStatus={service.status} toggleService={toggleCommunicationService} logout={logout}>{children}</AdminShell>;
}
