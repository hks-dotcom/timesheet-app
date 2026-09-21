import type { Status } from "@/lib/status";

// Every status carries both a shape and a label — never hue alone.
const MARK: Record<Status, { className: string; glyph: string; label: string }> = {
  draft: { className: "mk-draft", glyph: "", label: "Draft" },
  submitted: { className: "mk-submitted", glyph: "", label: "Submitted" },
  approved: { className: "mk-approved", glyph: "✓", label: "Approved" },
  processed: { className: "mk-processed", glyph: "▪", label: "Processed" },
};

const RETURNED = { className: "mk-returned", glyph: "↩", label: "Returned to draft" };

function markFor(status: Status, returnedReason?: string | null) {
  return status === "draft" && returnedReason ? RETURNED : MARK[status];
}

export function StatusMark({
  status,
  returnedReason,
  label,
}: {
  status: Status;
  returnedReason?: string | null;
  label?: string;
}) {
  const mark = markFor(status, returnedReason);
  return (
    <span className="st">
      <span className={`mk ${mark.className}`} aria-hidden="true">
        {mark.glyph}
      </span>
      {label ?? mark.label}
    </span>
  );
}

// Just the dot, no label — for contexts (like the activity trail) where an
// adjacent text label already names the event.
export function MarkGlyph({ status, returnedReason }: { status: Status; returnedReason?: string | null }) {
  const mark = markFor(status, returnedReason);
  return (
    <span className={`mk ${mark.className}`} aria-hidden="true">
      {mark.glyph}
    </span>
  );
}

// The event-TYPE dot for the trail: "returned" always shows the returned
// mark, "reopened"/"created" show the draft mark, regardless of what the
// timesheet's overall current status is.
export function eventTypeStatus(eventType: string): { status: Status; returnedReason?: string } {
  if (eventType === "returned") return { status: "draft", returnedReason: "returned" };
  if (eventType === "created" || eventType === "reopened") return { status: "draft" };
  return { status: eventType as Status };
}
