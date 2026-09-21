import Link from "next/link";
import type { Status } from "@/lib/status";
import { MarkGlyph } from "./StatusMark";

export function Kpi({ value, label, status, href }: { value: number; label: string; status?: Status; href: string }) {
  return (
    <Link className="kpi" href={href}>
      <div className="v">{value}</div>
      <div className="l">
        {status && <MarkGlyph status={status} />}
        {label}
      </div>
    </Link>
  );
}
