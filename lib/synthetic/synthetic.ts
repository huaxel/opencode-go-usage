import { authCredential, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

const LABEL_KEYS = ["name", "label", "type", "period", "scope", "title", "id"];
const USED_PCT_KEYS = ["percentUsed", "usedPercent", "usagePercent", "usage_percent", "used_percent", "percent_used", "percent"];
const REMAINING_PCT_KEYS = ["percentRemaining", "remainingPercent", "remaining_percent", "percent_remaining"];
const LIMIT_KEYS = ["limit", "messageLimit", "message_limit", "messages", "maxRequests", "max_requests", "requestLimit", "request_limit", "quota", "max", "total", "capacity", "allowance"];
const USED_KEYS = ["used", "usage", "usedMessages", "used_messages", "messagesUsed", "messages_used", "requests", "requestCount", "request_count", "consumed", "spent"];
const REMAINING_KEYS = ["remaining", "left", "available", "balance"];
const RESET_KEYS = ["resetAt", "reset_at", "resetsAt", "resets_at", "renewAt", "renew_at", "renewsAt", "renews_at", "periodEnd", "period_end", "expiresAt", "expires_at", "endAt", "end_at"];

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    const number = typeof candidate === "number" ? candidate : typeof candidate === "string" && candidate.trim() ? Number(candidate) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function isQuota(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return [USED_PCT_KEYS, REMAINING_PCT_KEYS, LIMIT_KEYS, USED_KEYS, REMAINING_KEYS]
    .some((keys) => firstNumber(object, keys) !== undefined);
}

function toPercent(value: number): number {
  return clampPercent(value >= 0 && value <= 1 ? value * 100 : value);
}

function parseReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN;
    return Number.isFinite(millis) ? formatResetTime(new Date(millis)) : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return formatResetTime(date);
  }
  return undefined;
}

/** Parse a Synthetic quota response, preserving provider labels and known slots. */
export function parseSyntheticUsage(input: unknown): QuotaWindow[] {
  if (!input || typeof input !== "object") return [];
  const root = (Array.isArray(input) ? { quotas: input } : input) as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : undefined;
  const named = (item: unknown, label: string): Record<string, unknown> | undefined =>
    isQuota(item) ? { ...item, label: firstString(item, LABEL_KEYS) || label } : undefined;
  const slots = [
    named(root.rollingFiveHourLimit, "5h") || named(data?.rollingFiveHourLimit, "5h"),
    named(root.weeklyTokenLimit, "Week") || named(data?.weeklyTokenLimit, "Week"),
    named((root.search as Record<string, unknown> | undefined)?.hourly, "Search") || named((data?.search as Record<string, unknown> | undefined)?.hourly, "Search"),
  ].filter((item): item is Record<string, unknown> => Boolean(item));
  const collect = (value: unknown, out: Record<string, unknown>[], depth = 0): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) collect(child, out, depth + 1);
    } else if (isQuota(value)) out.push(value);
    else for (const child of Object.values(value)) collect(child, out, depth + 1);
  };
  let candidates = slots;
  if (!candidates.length) {
    for (const key of ["quotas", "quota", "limits", "usage", "entries", "subscription"]) {
      collect(root[key] ?? data?.[key], candidates);
      if (candidates.length) break;
    }
    if (!candidates.length) collect(data, candidates);
  }

  return candidates.flatMap((item, index): QuotaWindow[] => {
    let used = firstNumber(item, USED_PCT_KEYS);
    if (used !== undefined) used = toPercent(used);
    else {
      let limit = firstNumber(item, LIMIT_KEYS);
      let count = firstNumber(item, USED_KEYS);
      const remaining = firstNumber(item, REMAINING_KEYS);
      if (limit === undefined && count !== undefined && remaining !== undefined) limit = count + remaining;
      if (count === undefined && limit !== undefined && remaining !== undefined) count = limit - remaining;
      if (count === undefined || limit === undefined || limit <= 0) {
        const pctRemaining = firstNumber(item, REMAINING_PCT_KEYS);
        if (pctRemaining !== undefined) used = 100 - toPercent(pctRemaining);
      } else used = clampPercent((count / limit) * 100);
    }
    if (used === undefined || !Number.isFinite(used)) return [];
    const label = firstString(item, LABEL_KEYS) || ["5h", "Week", "Search"][index] || `Quota ${index + 1}`;
    const reset = RESET_KEYS.map((key) => parseReset(item[key])).find(Boolean);
    return [{ label, usedPercent: used, ...(reset ? { resetsIn: reset } : {}) }];
  });
}

export async function fetchSyntheticUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const apiKey = options.apiKey || resolveAuthValue(process.env.SYNTHETIC_API_KEY) || authCredential("synthetic");
  if (!apiKey) return { provider: "Synthetic", windows: [], error: "no-auth", fetchedAt: Date.now() };
  try {
    const { data } = await fetchJson("https://api.synthetic.new/v2/quotas", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    }, options.timeoutMs ?? 10_000, options.fetchImpl ?? fetch);
    const windows = parseSyntheticUsage(data);
    if (!windows.length) return { provider: "Synthetic", windows: [], error: "invalid-response", fetchedAt: Date.now() };
    return { provider: "Synthetic", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Synthetic", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
