import { authCredential, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

const BASE_URLS = {
  global: "https://api.z.ai",
  "bigmodel-cn": "https://open.bigmodel.cn",
} as const;

type ZaiLimit = { type?: string; unit?: number; number?: number; percentage?: number; usage?: number; currentValue?: number; remaining?: number; nextResetTime?: number };

/** Parse z.ai/BigModel limits into quota windows. Unsupported limit types are ignored. */
export function parseZaiUsage(input: unknown): QuotaWindow[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const root = input as { success?: unknown; code?: unknown; data?: { limits?: unknown } };
  if (root.success !== true || root.code !== 200 || !Array.isArray(root.data?.limits)) return [];
  const unitMinutes: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
  const parsed = (root.data.limits as ZaiLimit[]).flatMap((limit): Array<{ window: QuotaWindow; minutes: number }> => {
    if (!limit || typeof limit !== "object" || !["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(limit.type ?? "")) return [];
    if (!Number.isInteger(limit.percentage)) return [];
    const usage = Number.isInteger(limit.usage) && limit.usage! > 0 ? limit.usage! : undefined;
    const remaining = Number.isInteger(limit.remaining) ? limit.remaining! : undefined;
    const current = Number.isInteger(limit.currentValue) ? limit.currentValue! : undefined;
    let percent = limit.percentage!;
    if (usage !== undefined) {
      const used = remaining !== undefined ? Math.max(usage - remaining, current ?? usage - remaining) : current;
      if (used !== undefined) percent = (Math.max(0, Math.min(usage, used)) / usage) * 100;
    }
    const minutes = limit.type === "TIME_LIMIT" ? 30 * 24 * 60 : (limit.number && unitMinutes[limit.unit ?? -1] ? limit.number * unitMinutes[limit.unit!] : 0);
    const resetAt = Number.isInteger(limit.nextResetTime) ? new Date(limit.nextResetTime!) : undefined;
    const resetsIn = resetAt && Number.isFinite(resetAt.getTime()) ? formatResetTime(resetAt) : undefined;
    const label = limit.type === "TIME_LIMIT" ? "MCP" : minutes === 300 ? "5h" : minutes === 10080 ? "Week" : minutes === 43200 ? "Month" : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : minutes ? `${minutes}m` : "Quota";
    return [{ window: { label, usedPercent: clampPercent(percent), ...(resetsIn ? { resetsIn } : {}) }, minutes }];
  });
  return parsed.sort((a, b) => a.minutes - b.minutes).map((entry) => entry.window);
}

export async function fetchZaiUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const region = options.region || (resolveAuthValue(process.env.Z_AI_REGION) === "bigmodel-cn" ? "bigmodel-cn" : "global");
  const regionalKey = region === "bigmodel-cn"
    ? resolveAuthValue(process.env.BIGMODEL_API_KEY) || resolveAuthValue(process.env.ZHIPU_API_KEY) || resolveAuthValue(process.env.ZHIPUAI_API_KEY) || resolveAuthValue(process.env.GLM_API_KEY)
    : resolveAuthValue(process.env.Z_AI_API_KEY);
  const apiKey = options.apiKey || regionalKey || authCredential("zai", "z.ai", "bigmodel");
  if (!apiKey) return { provider: "z.ai", windows: [], error: "no-auth", fetchedAt: Date.now() };
  const url = `${BASE_URLS[region]}/api/monitor/usage/quota/limit`;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  if (options.organization || options.project) {
    if (!options.organization || !options.project) return { provider: "z.ai", windows: [], error: "team-scope-requires-organization-and-project", fetchedAt: Date.now() };
    headers["Bigmodel-Organization"] = options.organization;
    headers["Bigmodel-Project"] = options.project;
  }
  const scopedUrl = options.organization ? `${url}?type=2` : url;
  try {
    const { data } = await fetchJson(scopedUrl, { headers }, options.timeoutMs ?? 10_000, options.fetchImpl ?? fetch);
    const windows = parseZaiUsage(data);
    if (!windows.length) return { provider: "z.ai", windows: [], error: "invalid-response", fetchedAt: Date.now() };
    return { provider: "z.ai", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "z.ai", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
