import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";

export default async function Page({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  await requireAdmin();
  const { role } = await searchParams;
  const destination = role === "video"
    ? "https://authentic-moments.com/video-thank-you-for-confirming/"
    : "https://authentic-moments.com/photo-thank-you-for-confirming/";

  async function confirm() {
    "use server";
    redirect(destination);
  }

  return (
    <main className="login card">
      <h1>Test your confirmation flow</h1>
      <p>This test follows the same destination routing as a live {role === "video" ? "videographer" : "photographer"} assignment.</p>
      <form action={confirm}><button>Confirm Assignment</button></form>
      <p className="muted">This is a test only. No contractor assignment will be changed.</p>
    </main>
  );
}
