"use server";

// The only callable endpoints for filing, returning and approving
// timesheets. Each resolves the session and delegates to
// lib/actions/timesheet.ts.

import {
  approveBatchCore,
  overrideApproveCore,
  returnCore,
  saveDraftCore,
  submitCore,
} from "@/lib/actions/timesheet";
import type { ApproveState, FormState } from "@/lib/actions/timesheet";
import { requireUser } from "@/lib/session";

export type { ApproveState, FormState } from "@/lib/actions/timesheet";

export async function saveDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser(["intern", "consultant"]);
  return saveDraftCore(me, formData);
}

export async function submitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser(["intern", "consultant"]);
  return submitCore(me, formData);
}

export async function returnAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser(["manager"]);
  return returnCore(me, formData);
}

export async function approveBatchAction(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const me = await requireUser(["manager"]);
  return approveBatchCore(me, formData);
}

export async function overrideApproveAction(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const me = await requireUser(["admin"]);
  return overrideApproveCore(me, formData);
}
