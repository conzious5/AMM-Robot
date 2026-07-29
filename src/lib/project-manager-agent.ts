export const projectManagerToolNames = [
  "get_event_readiness",
  "list_ready_events",
  "list_events_needing_attention",
  "list_unconfirmed_assignments",
  "list_unfilled_roles",
  "list_recent_declines",
  "list_delivery_failures",
  "list_upcoming_planned_actions",
  "get_person_confirmation_status",
  "get_event_staffing",
  "resend_assignment_reminder",
  "send_manual_message",
  "mark_assignment_confirmed",
  "mark_assignment_declined",
  "resolve_operational_alert",
  "get_open_tasks_for_event",
  "get_overdue_tasks",
  "get_tasks_assigned_to_user",
  "list_recent_changes",
] as const;

export function classifyProjectManagerQuestion(question: string) {
  const value = question.toLowerCase();
  if (/need(?:s)? (?:my|cylina|attention)|at risk|what.*do today/.test(value)) return "list_events_needing_attention";
  if (/what changed|recent changes|changed today/.test(value)) return "list_recent_changes";
  if (/fully staffed|readiness of|is the .* wedding ready/.test(value)) return "get_event_readiness";
  if (/ready|weekend/.test(value)) return "list_ready_events";
  if (/not confirmed|unconfirmed|confirm.*august/.test(value)) return "list_unconfirmed_assignments";
  if (/missing.*(?:video|photo)|unfilled/.test(value)) return "list_unfilled_roles";
  if (/overdue task|tasks.*overdue/.test(value)) return "get_overdue_tasks";
  if (/reminder.*tomorrow|going out tomorrow|upcoming action/.test(value)) return "list_upcoming_planned_actions";
  if (/decline/.test(value)) return "list_recent_declines";
  if (/failed|bounce|delivery/.test(value)) return "list_delivery_failures";
  return "help";
}
