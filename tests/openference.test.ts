import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchOpenferenceUsage,
  OPENFERENCE_USAGE_URL,
  parseOpenferenceUsage,
} from "../lib/openference/openference.ts";

const NOW = Date.parse("2026-08-27T20:00:00.000Z");
const RESET = new Date(NOW + 3_600_000).toISOString();

const FIXTURE = {
  usage: {
    window: { used: 400, limit: 800, resets_at: RESET },
    weekly: { percent: 12.5, resetsAt: new Date(NOW + 86_400_000).toISOString() },
    monthly: { used: 20, remaining: 80, limit: 100 },
  },
};

function response(status: number, body: unknown) {
  return Response.json(body, { status });
}

test("parseOpenferenceUsage maps rolling, weekly, and monthly windows", () => {
  const windows = parseOpenferenceUsage(FIXTURE, NOW);
  assert.deepEqual(windows.map((window) => window.label), ["5h", "Week", "Month"]);
  assert.equal(windows[0]!.usedPercent, 50);
  assert.equal(windows[0]!.resetsIn, "1h");
  assert.equal(windows[1]!.usedPercent, 12.5);
  assert.equal(windows[2]!.usedPercent, 20);
});

test("parseOpenferenceUsage accepts flat quota fields", () => {
  const windows = parseOpenferenceUsage({
    window_usage: 200,
    window_limit: 800,
    window_resets_at: RESET,
    weekly_usage: 50,
    weekly_limit: 100,
  }, NOW);
  assert.equal(windows[0]!.usedPercent, 25);
  assert.equal(windows[0]!.resetsIn, "1h");
  assert.equal(windows[1]!.usedPercent, 50);
});

test("fetchOpenferenceUsage sends the API key and parses JSON", async () => {
  let seenUrl = "";
  let seen: RequestInit | undefined;
  const snapshot = await fetchOpenferenceUsage("sk-test", {
    now: () => NOW,
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seen = init;
      return response(200, FIXTURE);
    },
  });
  assert.equal(seenUrl, OPENFERENCE_USAGE_URL);
  const headers = new Headers(seen?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.equal(headers.get("user-agent"), "pi/openference");
  assert.equal(snapshot.provider, "Openference");
  assert.equal(snapshot.windows[0]!.usedPercent, 50);
  assert.equal(snapshot.error, undefined);
});

test("fetchOpenferenceUsage turns window quota exhaustion into a full bar", async () => {
  const snapshot = await fetchOpenferenceUsage("sk-test", {
    now: () => NOW,
    fetchImpl: async () => response(402, {
      error: "Request limit exceeded",
      type: "insufficient_quota",
      code: "window_quota_exceeded",
      resets_at: RESET,
    }),
  });
  assert.deepEqual(snapshot.windows, [{ label: "5h", usedPercent: 100, resetsIn: "1h" }]);
  assert.equal(snapshot.error, undefined);
});

test("fetchOpenferenceUsage maps rejected keys to auth-expired", async () => {
  const snapshot = await fetchOpenferenceUsage("sk-bad", {
    fetchImpl: async () => response(401, { error: "Invalid API key" }),
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
