// Expense accounts and the one resolution rule that assigns a timesheet to
// one: billable work goes to its stream's own account; non-billable work
// goes to the timesheet owner's function account. This is the only copy of
// both the account list and the mapping — the seed builder, Mark Processed,
// Reports and the verification script all import from here.

export interface AccountRow {
  code: string;
  name: string;
}

export const ACCOUNTS: AccountRow[] = [
  { code: "5000", name: "COGS — Delivery Labour" },
  { code: "5020", name: "COGS — Support" },
  { code: "6000", name: "S&M — People" },
  { code: "6100", name: "R&D — People" },
  { code: "6200", name: "G&A — People" },
];

export const FUNCTION_ACCOUNT: Record<string, string> = {
  Delivery: "5000",
  "Solutions & Support": "5020",
  "Product Engineering": "6100",
  "R&D": "6100",
  "Sales & Marketing": "6000",
  "G&A": "6200",
};

export interface StreamForAccount {
  billable: boolean;
  defaultAccount: string | null;
}

// If the stream is billable, use its own default account. Otherwise
// resolve from the timesheet owner's function — never a stream-level
// default, since a non-billable stream doesn't have one.
export function resolveExpenseAccount(stream: StreamForAccount, userFunction: string): string {
  if (stream.billable) {
    if (!stream.defaultAccount) {
      throw new Error("billable stream has no default account");
    }
    return stream.defaultAccount;
  }
  const account = FUNCTION_ACCOUNT[userFunction];
  if (!account) {
    throw new Error(`no expense account mapped for function: ${userFunction}`);
  }
  return account;
}

export function accountName(code: string): string {
  return ACCOUNTS.find((a) => a.code === code)?.name ?? code;
}
