// The single source of truth for turning the latest event type on a
// timesheet into its status. There is no status column anywhere (see
// CLAUDE.md rule 1) — every screen that needs a timesheet's status must
// compute it through this function, not by branching on event types itself.

export const STATUSES = ["draft", "submitted", "approved", "processed"] as const;

export type Status = (typeof STATUSES)[number];

export type EventType = "created" | "submitted" | "returned" | "approved" | "processed" | "reopened";

const STATUS_BY_EVENT_TYPE: Record<EventType, Status> = {
  created: "draft",
  returned: "draft",
  reopened: "draft",
  submitted: "submitted",
  approved: "approved",
  processed: "processed",
};

export function statusFromLatestEventType(eventType: string): Status {
  const status = STATUS_BY_EVENT_TYPE[eventType as EventType];
  if (!status) throw new Error(`unknown event type: ${eventType}`);
  return status;
}
