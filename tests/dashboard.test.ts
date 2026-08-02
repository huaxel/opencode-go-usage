import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenCodeGoDashboard } from "../lib/dashboard.ts";

const FIXTURE = `
rollingUsage:$R[0]={usagePercent:42.5,resetInSec:3600}
weeklyUsage:$R[1]={resetInSec:86400,usagePercent:10}
monthlyUsage:$R[2]={usagePercent:5,resetInSec:2592000}
`;

test("parseOpenCodeGoDashboard reads rolling, weekly, monthly", () => {
  const parsed = parseOpenCodeGoDashboard(FIXTURE);
  assert.equal(parsed.rolling?.usagePercent, 42.5);
  assert.equal(parsed.rolling?.resetInSec, 3600);
  assert.equal(parsed.weekly?.usagePercent, 10);
  assert.equal(parsed.weekly?.resetInSec, 86400);
  assert.equal(parsed.monthly?.usagePercent, 5);
  assert.equal(parsed.monthly?.resetInSec, 2592000);
});

test("parseOpenCodeGoDashboard accepts both field orders", () => {
  const parsed = parseOpenCodeGoDashboard(
    "rollingUsage:$R[0]={usagePercent:12.5,resetInSec:60} weeklyUsage:$R[1]={resetInSec:120,usagePercent:25} monthlyUsage:$R[2]={usagePercent:1,resetInSec:3600}",
  );
  assert.deepEqual(parsed.rolling, { usagePercent: 12.5, resetInSec: 60 });
  assert.deepEqual(parsed.weekly, { usagePercent: 25, resetInSec: 120 });
  assert.deepEqual(parsed.monthly, { usagePercent: 1, resetInSec: 3600 });
});

test("parseOpenCodeGoDashboard returns nulls for empty html", () => {
  const parsed = parseOpenCodeGoDashboard("<html></html>");
  assert.equal(parsed.rolling, null);
  assert.equal(parsed.weekly, null);
  assert.equal(parsed.monthly, null);
});
