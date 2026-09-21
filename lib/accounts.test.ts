import assert from "node:assert/strict";
import test from "node:test";
import { FUNCTION_ACCOUNT, resolveExpenseAccount } from "./accounts";

test("billable stream uses its own default account, not the function", () => {
  const account = resolveExpenseAccount({ billable: true, defaultAccount: "5000" }, "Sales & Marketing");
  assert.equal(account, "5000");
});

test("billable stream with no default account throws rather than silently falling back", () => {
  assert.throws(() => resolveExpenseAccount({ billable: true, defaultAccount: null }, "Delivery"));
});

// Tara Young's exact case: Sales & Marketing, Internal stream (non-billable).
test("Tara Young's Internal-stream week resolves to 6000 via her function, not a stream default", () => {
  const account = resolveExpenseAccount({ billable: false, defaultAccount: null }, "Sales & Marketing");
  assert.equal(account, "6000");
});

for (const [userFunction, expected] of Object.entries(FUNCTION_ACCOUNT)) {
  test(`non-billable stream for ${userFunction} resolves to ${expected}`, () => {
    const account = resolveExpenseAccount({ billable: false, defaultAccount: null }, userFunction);
    assert.equal(account, expected);
  });
}

test("non-billable stream for an unmapped function throws", () => {
  assert.throws(() => resolveExpenseAccount({ billable: false, defaultAccount: null }, "Not A Real Function"));
});
