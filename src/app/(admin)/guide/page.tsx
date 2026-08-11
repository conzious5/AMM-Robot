import Link from "next/link";
import { requireAdmin } from "@/lib/auth";

export default async function Page() {
  const admin = await requireAdmin();
  const projectManager = admin.role === "PROJECT_MANAGER";
  return (
    <>
      <h1>{projectManager ? "Project-manager guide" : "AMM Robot user guide"}</h1>
      <p className="muted">A practical reference for operating Authentic Moments staffing and reminders safely.</p>

      <section className="card">
        <h2>Start here</h2>
        <ol>
          <li>Open <Link href="/operations"><b>Operations</b></Link> for the weddings that need attention.</li>
          <li>Review readiness reasons before changing an assignment or contacting a contractor.</li>
          <li>Use the controls inside a wedding to confirm, decline, resend, correct contact details, replace staff, or pause communication.</li>
          <li>Check <Link href="/conversations"><b>Conversations</b></Link> for contractor replies and <Link href="/actions"><b>Planned Actions</b></Link> for upcoming reminders.</li>
        </ol>
      </section>

      <section className="card">
        <h2>Daily workflow</h2>
        <ul>
          <li>Read the 8:00 AM operations brief and start with the next seven days.</li>
          <li>Resolve scheduling conflicts, declines, missing roles, and incorrect contact information first.</li>
          <li>Make sure every assigned photographer and videographer confirms independently, including second shooters.</li>
          <li>Use “Ask the operations agent” for readiness, unconfirmed assignments, missing roles, delivery failures, recent changes, and upcoming reminders.</li>
          <li>Calendar time edits automatically re-plan reminder timing; they do not create a critical reconfirmation alert.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Wedgewood contacts</h2>
        <p>Use <Link href="/wedgewood-contacts"><b>Wedgewood Contacts</b></Link> for venue and team email addresses. VSCO address-book matches are imported automatically, multiple contacts can be kept for each venue, and edits or removals are preserved on future syncs.</p>
      </section>

      <section className="card">
        <h2>Communication controls</h2>
        <ul>
          <li><b>Resend reminder:</b> starts an audited reminder action for that assignment.</li>
          <li><b>Contact contractor:</b> sends the exact reviewed message by email or text.</li>
          <li><b>Pause communications:</b> stops automated messages for an event or assignment until resumed.</li>
          <li><b>Mark confirmed/declined:</b> updates only that person’s assignment and recalculates wedding readiness.</li>
        </ul>
        <p className="muted">Every consequential action is recorded. Check the target, wedding, channel, and message before sending.</p>
      </section>

      <section className="card">
        <h2>Your access boundaries</h2>
        <p>Project managers can manage day-to-day staffing, confirmations, contractor communication, notes, milestones, and alerts.</p>
        <p>Project managers cannot view or change secrets, activate production messaging, delete records, or delete audit history.</p>
      </section>

      <section className="card">
        <h2>Account and notifications</h2>
        <p>Use <Link href="/settings"><b>My Settings</b></Link> to change your password, notification email/phone, alert channel, daily-brief preference, or brief time.</p>
        <p>If a send fails or the dashboard shows a red system alert, leave production controls unchanged and notify Zac with the exact error shown.</p>
      </section>
    </>
  );
}
