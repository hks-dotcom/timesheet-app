// CSV that a payroll system can load without anyone opening it first.
//
// Two decisions applied everywhere, so no caller has to remember them:
//
//   * CRLF line endings. RFC 4180 specifies CRLF and it is what
//     spreadsheet and payroll importers assume; LF-only files are the
//     common cause of a last column arriving with a stray character on
//     Windows tooling. One ending, everywhere.
//   * UTF-8, declared in the Content-Type. No BOM: it is not needed for
//     UTF-8 and importers that do not strip it read it as part of the
//     first header name.
//
// A field is quoted only when it has to be — it contains a comma, a
// quote, or a line break. Numbers are never quoted, so a column of
// amounts arrives as numbers rather than text.

export const CSV_LINE_ENDING = "\r\n";

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join(CSV_LINE_ENDING);
}

/**
 * Money, rates and hours as a fixed two-decimal string: 3614.00,
 * 79.50, 2484.38. Written unquoted, with no currency symbol and no
 * thousands separator, because the file is read by a machine.
 */
export function csvNumber(n: number): string {
  return (Number(n) || 0).toFixed(2);
}

/** "CoreThread" -> "corethread"; safe for a filename. */
export function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function csvResponse(rows: unknown[][], filename: string): Response {
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
