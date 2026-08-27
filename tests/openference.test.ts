import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchOpenferenceUsage,
  OPENFERENCE_USAGE_URL,
  parseOpenferenceUsage,
} from "../lib/openference/openference.ts";

const NOW = Date.parse("2026-08-27T21:00:00.000Z");
const WINDOW_RESET_MS = NOW + 3_600_000; // +1h
const WEEK_RESET_MS = NOW + 86_400_000; // +1d

// Mirrors the real GET https://openference.com/api/user/me shape (clean numbers
// so percents are exact): window 25% (200/800), week 50% (6500/13000).
const ME_FIXTURE = {
  userId: 2747,
  status: "active",
  usage: {
    windowQuotaUsed: 200,
    weekQuotaUsed: 6500,
    windowRequests: 100,
    weekRequests: 3000,
    todayQuotaUsed: 400,
  },
  plan: {
    name: "Pro",
    requestsPerWindow: 800,
    requestsPerWeek: 13000,
    windowHours: 5,
    maxRpm: 30,
  },
  limits: {
    windowQuotaUsed: 200,
    weekQuotaUsed: 6500,
    windowRequests: 100,
    weekRequests: 3000,
    windowResetAt: WINDOW_RESET_MS,
    weeklyResetAt: WEEK_RESET_MS,
    quotaResetAt: null,
  },
};

function response(status: number, body: unknown) {
  return Response.json(body, { status });
}

test("parseOpenferenceUsage maps window and week from the /api/user/me shape", () => {
  const windows = parseOpenferenceUsage(ME_FIXTURE, NOW);
  assert.deepEqual(windows.map((w) => w.label), ["5h", "Week"]);
  assert.equal(windows[0]!.usedPercent, 25);
  assert.equal(windows[0]!.resetsIn, "1h");
  assert.equal(windows[1]!.usedPercent, 50);
  assert.equal(windows[1]!.resetsIn, "1d");
});

test("parseOpenferenceUsage prefers usage.windowQuotaUsed over windowRequests", () => {
  const windows = parseOpenferenceUsage(
    {
      usage: { windowQuotaUsed: 400, windowRequests: 1 },
      plan: { requestsPerWindow: 800, windowHours: 5 },
      limits: { windowQuotaUsed: 999, windowRequests: 999, windowResetAt: WINDOW_RESET_MS },
    },
    NOW,
  );
  assert.equal(windows[0]!.usedPercent, 50); // 400/800, not 999/800 or 1/800
});

test("parseOpenferenceUsage falls back to limits.windowQuotaUsed then windowRequests", () => {
  const noUsageQuota = parseOpenferenceUsage(
    {
      usage: {},
      plan: { requestsPerWindow: 800, windowHours: 5 },
      limits: { windowQuotaUsed: 160, windowResetAt: WINDOW_RESET_MS },
    },
    NOW,
  );
  assert.equal(noUsageQuota[0]!.usedPercent, 20); // 160/800

  const onlyRequests = parseOpenferenceUsage(
    {
      usage: {},
      plan: { requestsPerWindow: 800, windowHours: 5 },
      limits: { windowRequests: 80, windowResetAt: WINDOW_RESET_MS },
    },
    NOW,
  );
  assert.equal(onlyRequests[0]!.usedPercent, 10); // 80/800
});

test("parseOpenferenceUsage derives the window label from plan.windowHours", () => {
  const windows = parseOpenferenceUsage(
    {
      usage: { windowQuotaUsed: 1 },
      plan: { requestsPerWindow: 800, windowHours: 24 },
      limits: { windowResetAt: WINDOW_RESET_MS },
    },
    NOW,
  );
  assert.equal(windows[0]!.label, "24h");
});

test("parseOpenferenceUsage returns no windows when limits are missing", () => {
  assert.deepEqual(parseOpenferenceUsage({ usage: { windowQuotaUsed: 1 } }, NOW), []);
  assert.deepEqual(parseOpenferenceUsage({}, NOW), []);
  assert.deepEqual(parseOpenferenceUsage(null, NOW), []);
});

test("fetchOpenferenceUsage targets the dashboard profile endpoint with Bearer auth", async () => {
  let seenUrl = "";
  let seen: RequestInit | undefined;
  const snapshot = await fetchOpenferenceUsage("sk-test", {
    now: () => NOW,
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seen = init;
      return response(200, ME_FIXTURE);
    },
  });
  assert.equal(seenUrl, OPENFERENCE_USAGE_URL);
  assert.equal(seenUrl, "https://openference.com/api/user/me");
  const headers = new Headers(seen?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.equal(headers.get("user-agent"), "pi/openference");
  assert.equal(snapshot.provider, "Openference");
  assert.equal(snapshot.windows[0]!.usedPercent, 25);
  assert.equal(snapshot.windows[1]!.usedPercent, 50);
  assert.equal(snapshot.error, undefined);
});

test("fetchOpenferenceUsage turns a 402 quota-exceeded body into a full bar", async () => {
  const snapshot = await fetchOpenferenceUsage("sk-test", {
    now: () => NOW,
    fetchImpl: async () =>
      response(402, {
        error: "Request limit exceeded (800 per 5 hours)",
        type: "insufficient_quota",
        code: "window_quota_exceeded",
        resets_at: new Date(NOW + 3_600_000).toISOString(),
      }),
  });
  assert.deepEqual(snapshot.windows, [{ label: "5h", usedPercent: 100, resetsIn: "1h" }]);
  assert.equal(snapshot.error, undefined);
});

test("fetchOpenferenceUsage maps rejected keys to auth-expired", async () => {
  const snapshot = await fetchOpenferenceUsage("sk-bad", {
    fetchImpl: async () => response(401, { error: "Missing or invalid Authorization header" }),
  });
  assert.equal(snapshot.error, "auth-expired");
  assert.deepEqual(snapshot.windows, []);
});

test("fetchOpenferenceUsage never throws on transport failures", async () => {
  const snapshot = await fetchOpenferenceUsage("sk-test", {
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(snapshot.provider, "Openference");
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.error, "unavailable");
});
