// Tests for fetchDashboardUsage (shared by the failover extension and footer).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_USER_AGENT,
  fetchDashboardUsage,
} from "../lib/fetch.ts";
import { parseOpenCodeGoDashboard } from "../lib/dashboard.ts";

const FIXTURE_HTML = `
rollingUsage:$R[0]={usagePercent:42.5,resetInSec:3600}
weeklyUsage:$R[1]={resetInSec:86400,usagePercent:10}
monthlyUsage:$R[2]={usagePercent:5,resetInSec:2592000}
`;

function fakeResponse(url: string, status = 200) {
  return {
    ok: status < 400,
    status,
    url,
    text: async () => FIXTURE_HTML,
  };
}

test("fetchDashboardUsage parses a valid dashboard", async () => {
  const result = await fetchDashboardUsage("ws-1", "cookie-1", {
    fetchImpl: async (input) =>
      fakeResponse("https://opencode.ai/workspace/ws-1/go") as unknown as Response,
  });
  assert.deepEqual(result, parseOpenCodeGoDashboard(FIXTURE_HTML));
  assert.equal(result.error, undefined);
});

test("fetchDashboardUsage reports auth-expired when the URL redirects away", async () => {
  const result = await fetchDashboardUsage("ws-1", "cookie-1", {
    fetchImpl: async () =>
      fakeResponse("https://opencode.ai/login") as unknown as Response,
  });
  assert.deepEqual(result, {
    rolling: null,
    weekly: null,
    monthly: null,
    error: "auth-expired",
  });
});

test("fetchDashboardUsage reports non-OK HTTP statuses as errors", async () => {
  const result = await fetchDashboardUsage("ws-1", "cookie-1", {
    fetchImpl: async () =>
      fakeResponse("https://opencode.ai/workspace/ws-1/go", 429) as unknown as Response,
  });
  assert.equal(result.error, "HTTP 429");
  assert.equal(result.rolling, null);
});

test("fetchDashboardUsage sends cookie and default user agent", async () => {
  let seen: RequestInit | undefined;
  await fetchDashboardUsage("ws-1", "cookie-1", {
    fetchImpl: async (_input, init) => {
      seen = init;
      return fakeResponse(
        "https://opencode.ai/workspace/ws-1/go",
      ) as unknown as Response;
    },
  });
  const headers = new Headers(seen?.headers);
  assert.equal(headers.get("cookie"), "auth=cookie-1");
  assert.equal(headers.get("user-agent"), DEFAULT_USER_AGENT);
});

test("fetchDashboardUsage propagates fetch failures as errors, never throws", async () => {
  const result = await fetchDashboardUsage("ws-1", "cookie-1", {
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.error, "boom");
});
