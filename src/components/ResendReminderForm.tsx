"use client";

import { useActionState } from "react";
import styles from "./ResendReminderForm.module.css";

export type ResendReminderState = {
  status: "idle" | "success" | "error";
  message?: string;
};

type Props = {
  action: (state: ResendReminderState, data: FormData) => Promise<ResendReminderState>;
  assignmentId: string;
  nonce: string;
  label?: string;
};

const initialState: ResendReminderState = { status: "idle" };

export function ResendReminderForm({ action, assignmentId, nonce, label = "Resend reminder" }: Props) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="nonce" value={nonce} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <button type="submit" disabled={pending} aria-describedby={`resend-status-${assignmentId}`}>
        {pending ? "Sending reminder…" : state.status === "success" ? "Reminder queued ✓" : label}
      </button>
      <span
        id={`resend-status-${assignmentId}`}
        className={`${styles.status} ${state.status === "error" ? styles.error : styles.success}`}
        role={state.status === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {state.message ?? ""}
      </span>
    </form>
  );
}
