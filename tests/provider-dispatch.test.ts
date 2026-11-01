import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectProvider,
  fetchProviderUsage,
  fetchAllProviderUsage,
  fetchQuota,
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchClineUsage,
  fetchUmansUsage,
  fetchCopilotUsage,
  fetchGeminiUsage,
  fetchKimiUsage,
  fetchSyntheticUsage,
  fetchZaiUsage,
  parseSyntheticUsage,
  parseZaiUsage,
  fetchOpencodeGoUsage,
} from "../index.ts";

test("detectProvider maps aliases and canonical names", () => {
  assert.equal(detectProvider("anthropic"), "claude");
  assert.equal(detectProvider("claude-bridge"), "claude");
  assert.equal(detectProvider("claude"), "claude");
  assert.equal(detectProvider("openai-codex"), "codex");
  assert.equal(detectProvider("codex"), "codex");
  assert.equal(detectProvider("opencode"), "opencode-go");
  assert.equal(detectProvider("opencode-go"), "opencode-go");
  assert.equal(detectProvider("cline-pass"), "cline-pass");
  assert.equal(detectProvider("clinepass"), "cline-pass");
  assert.equal(detectProvider("umans"), "umans");
  assert.equal(detectProvider("github-copilot"), "copilot");
  assert.equal(detectProvider("copilot"), "copilot");
  assert.equal(detectProvider("google-gemini-cli"), "gemini");
  assert.equal(detectProvider("gemini"), "gemini");
  assert.equal(detectProvider("kimi-coding"), "kimi");
  assert.equal(detectProvider("kimi"), "kimi");
  assert.equal(detectProvider("synthetic.new"), "synthetic");
  assert.equal(detectProvider("z.ai"), "zai");
  assert.equal(detectProvider("cursor"), "cursor");
  assert.equal(detectProvider("commandcode"), "commandcode");
  assert.equal(detectProvider("openference"), "openference");
  assert.equal(detectProvider("unknown-provider"), null);
  assert.equal(detectProvider(""), null);
});

test("fetchClaudeUsage parses utilization windows", async () => {
  const resetTime = new Date(Date.now() + 3600_000).toISOString();
  const mockFetch: typeof fetch = async (input, init) => {
    assert.match(String(input), /api\.anthropic\.com\/api\/oauth\/usage/);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer claude-token");
    assert.equal(headers?.["anthropic-beta"], "oauth-2025-04-20");
    return Response.json({
      five_hour: { utilization: 0.45, resets_at: resetTime },
      seven_day: { utilization: 0.20, resets_at: resetTime },
      monthly: { utilization: 0.10, resets_at: resetTime },
    });
  };

  const snapshot = await fetchClaudeUsage({
    apiKey: "claude-token",
    fetchImpl: mockFetch,
  });

  assert.equal(snapshot.provider, "Claude");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[0]!.label, "5h");
  assert.equal(snapshot.windows[0]!.usedPercent, 45);
  assert.equal(snapshot.windows[1]!.label, "Week");
  assert.equal(snapshot.windows[1]!.usedPercent, 20);
  assert.equal(snapshot.windows[2]!.label, "Month");
  assert.equal(snapshot.windows[2]!.usedPercent, 10);
});

test("fetchCodexUsage parses rate limit windows", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    assert.match(String(input), /chatgpt\.com\/backend-api\/wham\/usage/);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer codex-token");
    return Response.json({
      rate_limit: {
        primary_window: { used_percent: 60, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 25, reset_after_seconds: 86400 },
        monthly_window: { used_percent: 15, reset_after_seconds: 604800 },
      },
    });
  };

  const snapshot = await fetchCodexUsage({
    apiKey: "codex-token",
    fetchImpl: mockFetch,
  });

  assert.equal(snapshot.provider, "Codex");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[0]!.label, "5h");
  assert.equal(snapshot.windows[0]!.usedPercent, 60);
  assert.equal(snapshot.windows[1]!.label, "Week");
  assert.equal(snapshot.windows[1]!.usedPercent, 25);
  assert.equal(snapshot.windows[2]!.label, "Month");
  assert.equal(snapshot.windows[2]!.usedPercent, 15);
});

test("fetchClineUsage parses usages against plan thresholds", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/v1/users/me")) {
      return Response.json({ data: { id: "user_123" } });
    }
    if (url.includes("/api/v1/plans")) {
      return Response.json({
        data: [
          {
            isActive: true,
            entitlements: {
              cline_pass: {
                enabled: true,
                inferenceCapThreshold: {
                  last5HoursUsageCostUSDPerUser: 10,
                  last7daysUsageCostUSDPerUser: 50,
                  last30daysUsageCostUSDPerUser: 200,
                },
              },
            },
          },
        ],
      });
    }
    if (url.includes("/usages")) {
      return Response.json({
        data: {
          items: [
            { createdAt: new Date(Date.now() - 60_000).toISOString(), costUsd: 2.5 },
            { createdAt: new Date(Date.now() - 3600_000).toISOString(), costUsd: 5 },
          ],
        },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const snapshot = await fetchClineUsage("cline-key", { fetchImpl: mockFetch });
  assert.equal(snapshot.provider, "ClinePass");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[0]!.label, "5h");
  assert.equal(snapshot.windows[0]!.usedPercent, 75); // 7.5 / 10 * 100
  assert.equal(snapshot.windows[1]!.label, "Week");
  assert.equal(snapshot.windows[1]!.usedPercent, 15); // 7.5 / 50 * 100
  assert.equal(snapshot.windows[2]!.label, "Month");
  assert.equal(snapshot.windows[2]!.usedPercent, 3.75); // 7.5 / 200 * 100
});

test("fetchUmansUsage parses requests and concurrency windows", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.code\.umans\.ai\/v1\/usage/);
    return Response.json({
      limits: {
        requests: { limit: 1000 },
        concurrency: { limit: 10 },
      },
      usage: {
        requests_in_window: 400,
        concurrent_sessions: 3,
      },
    });
  };

  const snapshot = await fetchUmansUsage("umans-key", { fetchImpl: mockFetch });
  assert.equal(snapshot.provider, "Umans");
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0]!.label, "Req");
  assert.equal(snapshot.windows[0]!.usedPercent, 40);
  assert.equal(snapshot.windows[1]!.label, "Conc");
  assert.equal(snapshot.windows[1]!.usedPercent, 30);
});

test("fetchCopilotUsage parses premium and chat quota snapshots", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.github\.com\/copilot_internal\/user/);
    return Response.json({
      quota_reset_date_utc: new Date(Date.now() + 3600_000).toISOString(),
      quota_snapshots: {
        premium_interactions: { percent_remaining: 80 },
        chat: { percent_remaining: 35, unlimited: false },
      },
    });
  };

  const snapshot = await fetchCopilotUsage({
    apiKey: "gh-token",
    fetchImpl: mockFetch,
  });

  assert.equal(snapshot.provider, "Copilot");
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0]!.label, "Premium");
  assert.equal(snapshot.windows[0]!.usedPercent, 20); // 100 - 80
  assert.equal(snapshot.windows[1]!.label, "Chat");
  assert.equal(snapshot.windows[1]!.usedPercent, 65); // 100 - 35
});

test("fetchGeminiUsage parses model quotas into Pro and Flash windows", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /cloudcode-pa\.googleapis\.com/);
    return Response.json({
      buckets: [
        { modelId: "gemini-1.5-pro", remainingFraction: 0.7, resetTime: new Date(Date.now() + 3600_000).toISOString() },
        { modelId: "gemini-1.5-flash", remainingFraction: 0.9, resetTime: new Date(Date.now() + 7200_000).toISOString() },
      ],
    });
  };

  const snapshot = await fetchGeminiUsage({
    apiKey: "gemini-token",
    fetchImpl: mockFetch,
  });

  assert.equal(snapshot.provider, "Gemini");
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0]!.label, "Pro");
  assert.equal(Math.round(snapshot.windows[0]!.usedPercent), 30);
  assert.equal(snapshot.windows[1]!.label, "Flash");
  assert.equal(Math.round(snapshot.windows[1]!.usedPercent), 10);
});

test("fetchKimiUsage parses rate limits and weekly usage", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.kimi\.com\/coding\/v1\/usages/);
    return Response.json({
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: 100, remaining: 30, resetTime: new Date(Date.now() + 3600_000).toISOString() },
        },
      ],
      usage: {
        limit: 1000,
        remaining: 600,
        resetTime: new Date(Date.now() + 86400_000).toISOString(),
      },
    });
  };

  const snapshot = await fetchKimiUsage("kimi-token", { fetchImpl: mockFetch });
  assert.equal(snapshot.provider, "Kimi Coding");
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0]!.label, "5h");
  assert.equal(snapshot.windows[0]!.usedPercent, 70);
  assert.equal(snapshot.windows[1]!.label, "Week");
  assert.equal(snapshot.windows[1]!.usedPercent, 40);
});

test("parseSyntheticUsage normalizes named quota slots and reset timestamps", () => {
  const windows = parseSyntheticUsage({
    rollingFiveHourLimit: { used: 25, limit: 100, resetAt: new Date(Date.now() + 3600_000).toISOString() },
    weeklyTokenLimit: { percentRemaining: 0.75 },
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.usedPercent, 25);
  assert.equal(windows[0]!.label, "5h");
  assert.ok(windows[0]!.resetsIn);
  assert.equal(windows[1]!.usedPercent, 25);
  assert.equal(windows[1]!.label, "Week");
});

test("fetchSyntheticUsage calls the fixed quota endpoint with bearer auth", async () => {
  const snapshot = await fetchSyntheticUsage({
    apiKey: "synthetic-token",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://api.synthetic.new/v2/quotas");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-token");
      return Response.json({ quotas: [{ label: "Weekly", used: 4, limit: 10 }] });
    },
  });
  assert.equal(snapshot.windows[0]!.usedPercent, 40);
});

test("parseZaiUsage parses and orders quota limits", () => {
  const windows = parseZaiUsage({ success: true, code: 200, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 70, usage: 100, currentValue: 25 },
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20, usage: 100, remaining: 80 },
    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10 },
  ] } });
  assert.equal(windows.length, 3);
  assert.equal(windows[0]!.label, "5h");
  assert.equal(windows[0]!.usedPercent, 20);
  assert.equal(windows[1]!.label, "Week");
  assert.equal(windows[1]!.usedPercent, 25);
  assert.equal(windows[2]!.label, "MCP");
});

test("fetchZaiUsage selects region and applies team headers only when requested", async () => {
  const snapshot = await fetchZaiUsage({
    apiKey: "zai-token",
    region: "bigmodel-cn",
    organization: "org-1",
    project: "project-1",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer zai-token");
      assert.equal(headers["Bigmodel-Organization"], "org-1");
      assert.equal(headers["Bigmodel-Project"], "project-1");
      return Response.json({ success: true, code: 200, data: { limits: [
        { type: "TOKENS_LIMIT", unit: 5, number: 5, percentage: 40 },
      ] } });
    },
  });
  assert.equal(snapshot.provider, "z.ai");
  assert.equal(snapshot.windows[0]!.usedPercent, 40);
});

test("fetchOpencodeGoUsage parses usage API response", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /opencode\.ai\/zen\/go\/v1\/usage/);
    return Response.json({
      usage: {
        rolling: { percent: 45, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        weekly: { percent: 20, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
        monthly: { percent: 10, resetsAt: new Date(Date.now() + 604800_000).toISOString() },
      },
    });
  };

  const snapshot = await fetchOpencodeGoUsage({
    apiKey: "opencode-key",
    fetchImpl: mockFetch,
  });

  assert.equal(snapshot.provider, "opencode-go");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[0]!.label, "5h");
  assert.equal(snapshot.windows[0]!.usedPercent, 45);
  assert.equal(snapshot.windows[1]!.label, "Week");
  assert.equal(snapshot.windows[1]!.usedPercent, 20);
  assert.equal(snapshot.windows[2]!.label, "Month");
  assert.equal(snapshot.windows[2]!.usedPercent, 10);
});

test("fetchAllProviderUsage collects providers and omits unknown aliases", async () => {
  const mockFetch: typeof fetch = async () => Response.json({
    limits: { requests: { limit: 100 } },
    usage: { requests_in_window: 50 },
  });
  const snapshots = await fetchAllProviderUsage(["umans", "not-a-provider"], {
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.provider, "Umans");
  assert.equal(snapshots[0]!.windows[0]!.usedPercent, 50);
});

test("fetchProviderUsage / fetchQuota dispatches by alias and canonical name", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.code\.umans\.ai\/v1\/usage/);
    return Response.json({
      limits: { requests: { limit: 100 } },
      usage: { requests_in_window: 50 },
    });
  };

  const snapshot1 = await fetchProviderUsage("umans", { apiKey: "key", fetchImpl: mockFetch });
  assert.ok(snapshot1);
  assert.equal(snapshot1!.provider, "Umans");
  assert.equal(snapshot1!.windows[0]!.usedPercent, 50);

  const snapshot2 = await fetchQuota("umans", { apiKey: "key", fetchImpl: mockFetch });
  assert.ok(snapshot2);
  assert.equal(snapshot2!.provider, "Umans");

  const unknown = await fetchProviderUsage("not-a-provider");
  assert.equal(unknown, null);
});
