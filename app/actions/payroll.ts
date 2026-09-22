"use server";

// The only callable endpoint for Mark Processed. Resolves the session
// and delegates to lib/actions/payroll.ts.

import { markProcessedBatchCore } from "@/lib/actions/payroll";
import type { ProcessState } from "@/lib/actions/payroll";
import { requireUser } from "@/lib/session";

export type { ProcessState } from "@/lib/actions/payroll";

export async function markProcessedBatchAction(_prev: ProcessState, formData: FormData): Promise<ProcessState> {
  const me = await requireUser(["admin"]);
  return markProcessedBatchCore(me, formData);
}
