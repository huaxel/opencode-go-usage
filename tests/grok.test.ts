import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchGrokUsage,
  fetchProviderUsage,
  parseGrokAuthFile,
} from "../index.ts";

const oidcScope = "https://auth.x.ai::grok-cli";
const legacyScope = "https://accounts.x.ai/sign-in";

test("parseGrokAuthFile prefers a usable SuperGrok OIDC token", () => {
  const contents = JSON.stringify({
    [legacyScope]: { key: "legacy-token" },
    [oidcScope]: { key: "supergrok-token" },
  });
  assert.equal(parseGrokAuthFile(contents), "supergrok-token");
});

test("parseGrokAuthFile falls back to legacy session and rejects non-OAuth credentials", () => {
  assert.equal(
    parseGrokAuthFile(JSON.stringify({ [oidcScope]: { key: "" }, [legacyScope]: { key: "legacy-token" } })),
    "legacy-token",
  );
  assert.equal(parseGrokAuthFile(JSON.stringify({ [oidcScope]: { key: "xai-inference-key" } })), undefined);
  assert.equal(parseGrokAuthFile(JSON.stringify({ [oidcScope]: { key: "Cookie: session=value" } })), undefined);
  assert.equal(parseGrokAuthFile("not-json"), undefined);
});

test("fetchGrokUsage maps the CLI billing response into a weekly quota window", async () => {
  const periodEnd = new Date(Date.now() + 24 * 60 * 60_000);
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60_000);
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer supergrok-token");
    assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
    assert.equal(init?.redirect, "error");
    return Response.json({
      config: {
        creditUsagePercent: 37,
        currentPeriod: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
      },
    });
  };

  const snapshot = await fetchGrokUsage({ apiKey: "Bearer supergrok-token", fetchImpl: mockFetch });
  assert.equal(snapshot.provider, "Grok");
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0]!.label, "Week");
  assert.equal(snapshot.windows[0]!.usedPercent, 37);
  assert.equal(snapshot.windows[0]!.resetsAt, periodEnd.toISOString());
});

test("fetchGrokUsage does not mix billing-period boundaries for its label", async () => {
  const mockFetch: typeof fetch = async () =>
    Response.json({
      config: {
        creditUsagePercent: 20,
        currentPeriod: { start: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString() },
        billingPeriodEnd: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      },
    });
  const snapshot = await fetchGrokUsage({ apiKey: "supergrok-token", fetchImpl: mockFetch });
  assert.equal(snapshot.windows[0]!.label, "Credits");
});

test("fetchGrokUsage derives usage when credits percent is absent", async () => {
  const mockFetch: typeof fetch = async () =>
    Response.json({ config: { onDemandCap: { val: 80 }, onDemandUsed: { val: 20 } } });
  const snapshot = await fetchGrokUsage({ apiKey: "supergrok-token", fetchImpl: mockFetch });
  assert.equal(snapshot.windows[0]!.label, "Credits");
  assert.equal(snapshot.windows[0]!.usedPercent, 25);
});

test("provider dispatch recognizes Grok aliases", async () => {
  const mockFetch: typeof fetch = async () => Response.json({ config: { creditUsagePercent: 12 } });
  const snapshot = await fetchProviderUsage("supergrok", { apiKey: "token", fetchImpl: mockFetch });
  assert.equal(snapshot?.provider, "Grok");
  assert.equal(snapshot?.windows[0]?.usedPercent, 12);
});
