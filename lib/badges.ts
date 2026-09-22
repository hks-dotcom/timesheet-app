// The number on each nav tab itself — separate from the notification
// bell's unread count. Entity-scoped (admin/manager queries already are;
// the contributor count is inherently scoped to just that one person).
// Zero is represented as "no entry", not a stored/shown 0 — and never a
// stored count: every number here is derived from the latest event, at
// read time. Lives here rather than inside components/AppShell.tsx so a
// proof script can call the exact function the nav renders.

import { fromUTCDate, mostRecentFriday } from "./dateutil";
import { contributorActionNeededCount, latestContractTerm, offerableWeeks, type WeekActionStatus } from "./domain";
import {
  getContractTermsForUser,
  getPendingForManager,
  getReadyForProcessing,
  getSubmittedForEntity,
  listTimesheetsForUser,
  type SessionUser,
} from "./repo";

export type BadgeTab = "processed" | "overrides" | "queue" | "new";

export async function navBadgesFor(me: SessionUser): Promise<Partial<Record<BadgeTab, number>>> {
  const todayISO = fromUTCDate(new Date());
  if (me.role === "admin") {
    const [ready, submitted] = await Promise.all([getReadyForProcessing(me.entityId), getSubmittedForEntity(me.entityId)]);
    const badges: Partial<Record<BadgeTab, number>> = {};
    if (ready.length) badges.processed = ready.length;
    if (submitted.length) badges.overrides = submitted.length;
    return badges;
  }
  if (me.role === "manager") {
    const pending = await getPendingForManager(me.id);
    return pending.length ? { queue: pending.length } : {};
  }
  if (me.payType !== "hourly") return {};
  const anchor = mostRecentFriday(new Date());
  const sheets = await listTimesheetsForUser(me.id);
  const earliestWeek = sheets.reduce((min, t) => (t.weekEnding < min ? t.weekEnding : min), anchor);
  const terms = await getContractTermsForUser(me.id);
  const endDate = latestContractTerm(terms)?.endDate ?? null;
  // D9: a week past the contract end date is never something to act on —
  // the same offerableWeeks New Timesheet and the Tracker use.
  const recentWeeks = offerableWeeks(anchor, earliestWeek, endDate);
  const byWeek = new Map<string, WeekActionStatus>(
    sheets.map((t) => [t.weekEnding, { status: t.status, returnedReason: t.returnedReason }]),
  );
  const count = contributorActionNeededCount(recentWeeks, todayISO, byWeek);
  return count ? { new: count } : {};
}
