// Tests for fetchUsageApi + parseUsageApiJson (official OpenCode Go usage API).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchUsageApi,
  parseUsageApiJson,
  USAGE_API_URL,
} from "../lib/usage-api.ts";

const FIXTURE_JSON = {
  usage: {
    rolling: { status: "ok", percent: 15, resetsAt: "2026-08-12T13:03:22.155Z" },
    weekly: { status: "ok", percent: 42, resetsAt: "2026-08-17T00:00:00.155Z" },
    monthly: { status: "ok", percent: 82, resetsAt: "2026-08-31T20:44:05.155Z" },
  },
};

const NOW = Date.parse("2026-08-12T12:03:22.155Z");

function fakeResponse(status = 200, body: unknown = FIXTURE_JSON) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  };
}

test("parseUsageApiJson maps percent/resetsAt into usage windows", () => {
  const parsed = parseUsageApiJson(FIXTURE_JSON, NOW);
  assert.equal(parsed.rolling?.usagePercent, 15);
  assert.equal(parsed.rolling?.resetInSec, 3600);
  assert.equal(parsed.rolling?.status, "ok");
  assert.equal(parsed.weekly?.usagePercent, 42);
  assert.equal(parsed.weekly?.resetInSec, Math.floor((Date.parse("2026-08-17T00:00:00.155Z") - NOW) / 1000));
  assert.equal(parsed.monthly?.usagePercent, 82);
  assert.equal(parsed.monthly?.status, "ok");
});

test("parseUsageApiJson clamps resetInSec at 0 for past resets", () => {
  const parsed = parseUsageApiJson(
    { usage: { rolling: { status: "ok", percent: 5, resetsAt: "2026-01-01T00:00:00.000Z" } } },
    NOW,
  );
  assert.equal(parsed.rolling?.usagePercent, 5);
  assert.equal(parsed.rolling?.resetInSec, 0);
  assert.equal(parsed.weekly, null);
  assert.equal(parsed.monthly, null);
});

test("parseUsageApiJson returns nulls for malformed input", () => {
  for (const raw of [null, undefined, "nope", {}, { usage: null }, { usage: { rolling: {} } }]) {
    const parsed = parseUsageApiJson(raw, NOW);
    assert.equal(parsed.rolling, null);
    assert.equal(parsed.weekly, null);
    assert.equal(parsed.monthly, null);
  }
});

test("fetchUsageApi sends Bearer auth and parses response", async () => {
  let seen: RequestInit | undefined;
  let seenUrl: string | undefined;
  const result = await fetchUsageApi("sk-test", {
    now: () => NOW,
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seen = init;
      return fakeResponse(200) as unknown as Response;
    },
  });
  assert.equal(seenUrl, USAGE_API_URL);
  const headers = new Headers(seen?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.equal(result.error, undefined);
  assert.equal(result.rolling?.usagePercent, 15);
});

test("fetchUsageApi maps 401 to auth-expired", async () => {
  const result = await fetchUsageApi("sk-bad", {
    fetchImpl: async () => fakeResponse(401) as unknown as Response,
  });
  assert.deepEqual(result, {
    rolling: null,
    weekly: null,
    monthly: null,
    error: "auth-expired",
  });
});

test("fetchUsageApi reports non-OK HTTP statuses as errors", async () => {
  const result = await fetchUsageApi("sk-test", {
    fetchImpl: async () => fakeResponse(429) as unknown as Response,
  });
  assert.equal(result.error, "HTTP 429");
  assert.equal(result.rolling, null);
});

test("fetchUsageApi propagates fetch failures as errors, never throws", async () => {
  const result = await fetchUsageApi("sk-test", {
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.error, "boom");
});
