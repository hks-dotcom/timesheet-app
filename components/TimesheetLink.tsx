import Link from "next/link";

// One cell of a table row, linked to the timesheet it describes.
//
// Deliberately an ordinary inline link, not a stretched overlay across
// the row. The previous version put an absolutely positioned ::after on
// a link inside the row and relied on the <tr> being its containing
// block. WebKit does not reliably honour `position: relative` on a
// <tr>, so every row's overlay resolved to the nearest positioned
// ancestor instead — the whole table — and they stacked, leaving the
// last row's overlay on top of all of them. In Safari, clicking any row
// on My timesheets opened the last row's timesheet.
//
// A link that occupies its own cell cannot do that: its hit area is its
// own text, inside its own row, in every engine. Each row carries two
// of them so there is more than one obvious place to click.
export function TimesheetLink({
  href,
  label,
  children,
}: {
  href: string;
  /** Says where it goes — "Sep 4, 2026" or "Approved" alone does not. */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link className="tslink" href={href} aria-label={label}>
      {children}
    </Link>
  );
}
