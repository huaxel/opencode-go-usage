import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authCredential, loadAuthJson } from "../auth/auth.ts";
import { clampPercent, formatResetSeconds, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export async function fetchCodexUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  let token = options.apiKey || authCredential("openai-codex");
  let accountId = (loadAuthJson() as Record<string, any>)["openai-codex"]?.accountId;

  if (!token) {
    const codexPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    try {
      const data = JSON.parse(readFileSync(codexPath, "utf-8"));
      token = data.OPENAI_API_KEY || data.tokens?.access_token;
      accountId ||= data.tokens?.account_id;
    } catch {
      // No Codex credential.
    }
  }

  if (!token) return { provider: "Codex", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "pi-agent",
      Accept: "application/json",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const { data } = await fetchJson(
      "https://chatgpt.com/backend-api/wham/usage",
      { headers },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );
    const windows: QuotaWindow[] = [];

    const rateLimit = data.rate_limit ?? {};
    for (const [label, window] of [
      ["5h", rateLimit.primary_window],
      ["Week", rateLimit.secondary_window],
      ["Month", rateLimit.monthly_window ?? rateLimit.tertiary_window],
    ] as const) {
      if (!window) continue;
      const resetAt = typeof window.reset_at === "number" ? new Date(window.reset_at * 1000) : undefined;
      const usedPercent = Number(window.used_percent);
      if (!Number.isFinite(usedPercent)) continue;
      windows.push({
        label,
        usedPercent: clampPercent(usedPercent),
        resetsIn: resetAt ? formatResetTime(resetAt) : formatResetSeconds(Number(window.reset_after_seconds)),
      });
    }

    return { provider: "Codex", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Codex", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
