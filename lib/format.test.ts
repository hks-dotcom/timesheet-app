import assert from "node:assert/strict";
import test from "node:test";
import { roundMoney } from "./format";

interface Case {
  name: string;
  n: number;
  expected: number;
}

const cases: Case[] = [
  // The canonical failure: 1.005 is stored as the double closest to it,
  // 1.00499999999999989342 — Math.round(1.005 * 100) / 100 gives 1.00.
  { name: "the classic 1.005 case", n: 1.005, expected: 1.01 },
  { name: "negative half-cent tie", n: -1.005, expected: -1.01 },
  // 2.675 * 100 famously prints as 267.49999999999994 in JS.
  { name: "2.675 (classic toFixed pitfall)", n: 2.675, expected: 2.68 },
  // Exact ties produced by real hours x rate products in this app's
  // domain (quarter hours x an arbitrary numeric(8,2) rate).
  { name: "0.25h x $0.58/h", n: 0.25 * 0.58, expected: 0.15 },
  { name: "0.25h x $8.54/h", n: 0.25 * 8.54, expected: 2.14 },
  { name: "0.25h x $4.02/h", n: 0.25 * 4.02, expected: 1.01 },
  // A tie that happens to round correctly under the old method too —
  // confirms the fix doesn't only work by accident on the broken cases.
  { name: "22.75h x $79.50/h (eighths of a dollar, exactly representable)", n: 22.75 * 79.5, expected: 1808.63 },
  // Non-ties: must still round the ordinary way.
  { name: "just below half", n: 0.144, expected: 0.14 },
  { name: "just above half", n: 0.146, expected: 0.15 },
  { name: "already exact", n: 10, expected: 10 },
  { name: "zero", n: 0, expected: 0 },
  { name: "a large amount", n: 22.75 * 999.99, expected: 22749.77 },
];

for (const c of cases) {
  test(`roundMoney: ${c.name}`, () => {
    const result = roundMoney(c.n);
    console.log(`  roundMoney(${c.n}) -> ${result} (expected ${c.expected})`);
    assert.equal(result, c.expected);
  });
}
