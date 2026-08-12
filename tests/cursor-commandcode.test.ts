import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  buildCommandCodeWindows,
  fetchCommandCodeUsage,
  fetchCursorUsage,
  parseCommandCodeCredits,
  parseCommandCodeSubscription,
  resolveCommandCodeCookieHeader,
  resolveCursorCookieHeader,
  cursorCookieFromAccessToken,
  parseCursorUsageSummary,
} from "../index.ts";

let tmpDir: string;
let savedAgentDir: string | undefined;
let savedFetch: typeof globalThis.fetch | undefined;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "provider-usage-test-"));
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  savedFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
});

after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedFetch) globalThis.fetch = savedFetch;
  else delete (globalThis as Record<string, unknown>).fetch;
  await rm(tmpDir, { recursive: true, force: true });
});

test("parseCursorUsageSummary keeps fractional percent units", () => {
  const windows = parseCursorUsageSummary({
    billingCycleEnd: "2026-06-01T00:00:00.000Z",
    individualUsage: {
      plan: {
        totalPercentUsed: 0.40625,
        autoPercentUsed: 0.36,
        apiPercentUsed: 12.5,
      },
    },
  });
  assert.equal(windows[0]!.label, "Plan");
  assert.equal(windows[0]!.usedPercent, 0.40625);
});

test("parseCursorUsageSummary supports agentq labels", () => {
  const windows = parseCursorUsageSummary({
    billingCycleEnd: "2026-06-01T00:00:00.000Z",
    individualUsage: {
      plan: { totalPercentUsed: 50, autoPercentUsed: 60, apiPercentUsed: 40 },
    },
  }, "agentq");
  assert.deepEqual(windows.map((w) => w.label), ["total", "auto-composer", "api-models"]);
});

test("parseCommandCodeCredits reads rolling windows", () => {
  const credits = parseCommandCodeCredits({
    credits: { monthlyCredits: 8.5 },
    windowLimits: {
      fiveHour: { cap: 3, used: 0.75, resetAt: 1_780_000_000_000 },
      weekly: { cap: 15, used: 1.5, resetAt: 1_780_100_000_000 },
    },
  });
  assert.equal(credits.fiveHour?.usedPercent, 25);
});

test("resolveCursorCookieHeader prefers quota-sessions.json", async () => {
  await writeFile(
    join(tmpDir, "quota-sessions.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=from-sessions" } }),
    "utf-8",
  );
  await writeFile(
    join(tmpDir, "auth.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=from-auth" } }),
    "utf-8",
  );
  assert.equal(resolveCursorCookieHeader(), "WorkosCursorSessionToken=from-sessions");
});

test("fetchCommandCodeUsage uses configured session cookie", async () => {
  await writeFile(
    join(tmpDir, "quota-sessions.json"),
    JSON.stringify({
      commandcode: { cookie: "__Secure-better-auth.session_token=session-token-value" },
    }),
    "utf-8",
  );

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    assert.match(headers?.Cookie ?? "", /session-token-value/);
    if (url.includes("/internal/billing/credits")) {
      return Response.json({
        credits: { monthlyCredits: 5 },
        windowLimits: { fiveHour: { cap: 2, used: 1, resetAt: 1_780_000_000_000 } },
      });
    }
    if (url.includes("/internal/billing/subscriptions")) {
      return Response.json({ success: true, data: null });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const snapshot = await fetchCommandCodeUsage();
  assert.equal(snapshot.provider, "CommandCode");
  assert.equal(snapshot.windows[0]!.label, "5h");
});

test("fetchCursorUsage parses usage-summary response", async () => {
  await writeFile(
    join(tmpDir, "quota-sessions.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=test" } }),
    "utf-8",
  );

  globalThis.fetch = async (input) => {
    assert.match(String(input), /cursor\.com\/api\/usage-summary/);
    return Response.json({
      billingCycleEnd: "2026-06-01T00:00:00.000Z",
      individualUsage: {
        plan: { totalPercentUsed: 30, autoPercentUsed: 12, apiPercentUsed: 18 },
      },
    });
  };

  const snapshot = await fetchCursorUsage();
  assert.equal(snapshot.provider, "Cursor");
  assert.deepEqual(snapshot.windows.map((w) => w.label), ["Plan", "Auto", "API"]);
});
