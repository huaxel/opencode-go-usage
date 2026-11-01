import { authCredential, authProviderBlock, loadAuthJson, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, formatResetSeconds } from "../shared/format.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";
import { fetchDashboardUsage } from "./fetch.ts";
import type { OpenCodeGoWindow } from "./types.ts";
import { fetchUsageApi } from "./usage-api.ts";

export function buildOpencodeGoWindows(
  parsed: { rolling: OpenCodeGoWindow | null; weekly: OpenCodeGoWindow | null; monthly: OpenCodeGoWindow | null },
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (parsed.rolling) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(parsed.rolling.usagePercent),
      resetsIn: formatResetSeconds(parsed.rolling.resetInSec),
    });
  }
  if (parsed.weekly) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(parsed.weekly.usagePercent),
      resetsIn: formatResetSeconds(parsed.weekly.resetInSec),
    });
  }
  if (parsed.monthly) {
    windows.push({
      label: "Month",
      usedPercent: clampPercent(parsed.monthly.usagePercent),
      resetsIn: formatResetSeconds(parsed.monthly.resetInSec),
    });
  }
  return windows;
}

export async function fetchOpencodeGoUsage(
  options: QuotaFetchOptions & {
    workspaceId?: string;
    authCookie?: string;
  } = {},
): Promise<QuotaSnapshot> {
  const auth = loadAuthJson();
  const key =
    options.apiKey ||
    resolveAuthValue(process.env.OPENCODE_API_KEY) ||
    authCredential("opencode-go", "opencode");

  if (key) {
    const usage = await fetchUsageApi(key, {
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (usage.rolling || usage.weekly || usage.monthly) {
      return {
        provider: "opencode-go",
        windows: buildOpencodeGoWindows(usage),
        fetchedAt: Date.now(),
      };
    }
  }

  // Fall back to single-account quota-status config.
  const quotaCfg = authProviderBlock(auth, "quota-status")?.["opencode-go"] as Record<string, unknown> | undefined;
  const workspaceId = (options.workspaceId || resolveAuthValue(quotaCfg?.workspaceId) || "").trim();
  const authCookie = (options.authCookie || resolveAuthValue(quotaCfg?.authCookie) || "").trim();
  if (!workspaceId || !authCookie) {
    return { provider: "opencode-go", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  const parsed = await fetchDashboardUsage(workspaceId, authCookie);
  if (!parsed || (!parsed.rolling && !parsed.weekly && !parsed.monthly)) {
    return { provider: "opencode-go", windows: [], error: parsed?.error || "no-auth", fetchedAt: Date.now() };
  }
  if (parsed.error) {
    return { provider: "opencode-go", windows: [], error: parsed.error, fetchedAt: Date.now() };
  }
  return { provider: "opencode-go", windows: buildOpencodeGoWindows(parsed), fetchedAt: Date.now() };
}
