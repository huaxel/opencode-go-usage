import { authCredential, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export interface ClineUsageItem {
  createdAt?: string;
  costUsd?: number;
}

const CLINE_BASE_URL = "https://api.cline.bot";
const CLINE_PAGE_LIMIT = 100;
const CLINE_MAX_PAGES = 100;

function clineUrl(path: string): string {
  return new URL(path, CLINE_BASE_URL).toString();
}

export function clineApiKey(explicit?: string): string | undefined {
  return explicit || resolveAuthValue(process.env.CLINE_API_KEY) || authCredential("cline-pass", "clinepass");
}

function parseClineDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function clineWindow(
  now: number,
  label: string,
  durationMs: number,
  limitUnits: number,
  items: ClineUsageItem[],
): QuotaWindow | null {
  if (!Number.isFinite(limitUnits) || limitUnits <= 0) return null;
  const start = now - durationMs;
  let usedUnits = 0;
  let oldest: number | undefined;

  for (const item of items) {
    const createdAt = parseClineDate(item.createdAt)?.getTime();
    if (createdAt === undefined || createdAt < start || createdAt > now) continue;
    const cost = Number(item.costUsd);
    if (Number.isFinite(cost)) usedUnits += cost;
    oldest = oldest === undefined ? createdAt : Math.min(oldest, createdAt);
  }

  const usedPercent = limitUnits > 0 ? clampPercent((usedUnits / limitUnits) * 100) : 0;
  const resetAt = oldest === undefined ? undefined : new Date(oldest + durationMs);
  return { label, usedPercent, resetsIn: resetAt ? formatResetTime(resetAt) : undefined };
}

export async function fetchClineUsage(
  apiKeyOrOptions?: string | QuotaFetchOptions,
  maybeOptions?: QuotaFetchOptions,
): Promise<QuotaSnapshot> {
  const options =
    typeof apiKeyOrOptions === "object" && apiKeyOrOptions !== null
      ? apiKeyOrOptions
      : (maybeOptions ?? {});
  const explicitKey =
    typeof apiKeyOrOptions === "string" ? apiKeyOrOptions : options.apiKey;
  const apiKey = clineApiKey(explicitKey);

  if (!apiKey) {
    return { provider: "ClinePass", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "pi-obs-footer" };
    const me = await fetchJson(clineUrl("/api/v1/users/me"), { headers }, timeoutMs, fetchImpl);
    const userId = typeof me.data?.data?.id === "string" ? me.data.data.id : "";
    if (!userId) return { provider: "ClinePass", windows: [], error: "invalid-response", fetchedAt: Date.now() };

    const plans = await fetchJson(clineUrl("/api/v1/plans"), { headers }, timeoutMs, fetchImpl);
    const planList = Array.isArray(plans.data?.data) ? plans.data.data : [];
    const threshold = planList.find((plan: any) =>
      plan?.isActive && plan?.entitlements?.cline_pass?.enabled && plan?.entitlements?.cline_pass?.inferenceCapThreshold,
    )?.entitlements?.cline_pass?.inferenceCapThreshold;
    if (!threshold) return { provider: "ClinePass", windows: [], error: "no-active-plan", fetchedAt: Date.now() };

    const items: ClineUsageItem[] = [];
    let cursor = "";
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (let page = 0; page < CLINE_MAX_PAGES; page++) {
      const url = new URL(clineUrl(`/api/v1/users/${encodeURIComponent(userId)}/usages`));
      url.searchParams.set("limit", String(CLINE_PAGE_LIMIT));
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetchJson(url.toString(), { headers }, timeoutMs, fetchImpl);
      const data = response.data?.data;
      const pageItems = Array.isArray(data?.items) ? data.items : [];
      items.push(...pageItems);

      const oldest = pageItems
        .map((item: ClineUsageItem) => parseClineDate(item.createdAt)?.getTime())
        .filter((value: number | undefined): value is number => value !== undefined)
        .reduce((min: number | undefined, value: number) => min === undefined ? value : Math.min(min, value), undefined);
      cursor = typeof data?.nextToken === "string" ? data.nextToken.trim() : "";
      if (!cursor || pageItems.length === 0 || (oldest !== undefined && oldest < cutoff)) break;
    }

    const now = Date.now();
    return {
      provider: "ClinePass",
      windows: [
        clineWindow(now, "5h", 5 * 60 * 60 * 1000, Number(threshold.last5HoursUsageCostUSDPerUser), items),
        clineWindow(now, "Week", 7 * 24 * 60 * 60 * 1000, Number(threshold.last7daysUsageCostUSDPerUser), items),
        clineWindow(now, "Month", 30 * 24 * 60 * 60 * 1000, Number(threshold.last30daysUsageCostUSDPerUser), items),
      ].filter((window): window is QuotaWindow => window !== null),
      fetchedAt: now,
    };
  } catch (error) {
    return { provider: "ClinePass", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
