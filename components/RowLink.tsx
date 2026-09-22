import Link from "next/link";

// (c) A whole table row that is one real link.
//
// The link is a genuine <a href>, so Enter on a focused row navigates,
// middle-click and cmd-click open a new tab, and the browser shows the
// destination on hover — none of which an onClick handler gives you. It
// is stretched over the row by a ::after pseudo-element (see
// .rowlink-cover in globals.css) rather than by wrapping the <tr>,
// because an <a> cannot legally contain table cells.
//
// Anything else interactive in the row must sit above the cover:
// .rowlink-above lifts it, so a checkbox or a dropdown keeps working
// and never navigates.
//
// Put this inside the row's FIRST cell. The visible text stays the
// cell's own content; the link carries an accessible name saying where
// it goes, since "Sep 4, 2026" on its own does not.
export function RowLink({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <>
      <Link className="rowlink-cover" href={href} aria-label={label}>
        <span className="visually-hidden">{label}</span>
      </Link>
      {children}
    </>
  );
}
