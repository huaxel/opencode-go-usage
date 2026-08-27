import type { QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";
import { clampPercent, safeError } from "../shared/format.ts";
import { authCredential, resolveAuthValue } from "../auth/auth.ts";

export const OPENFERENCE_USAGE_URL = "https://api.openference.com/v1/usage";
const MAX_RESPONSE_BYTES = 64 * 1024;

interface JsonObject {
  [key: string]: unknown;
}

export interface FetchOpenferenceUsageOptions {
  /** Abort timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Fetch implementation override for tests. */
  fetchImpl?: typeof fetch;
  /** Clock override for tests. */
  now?: () => number;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function numberField(source: JsonObject, names: string[]): number | undefined {
  for (const name of names) {
    const value = Number(source[name]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(source: JsonObject, names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function formatResetIn(seconds: number): string {
  if (seconds <= 0) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d${remainingHours}h` : `${days}d`;
}

function resetInSeconds(source: JsonObject, now: number): number | undefined {
  const seconds = numberField(source, ["reset_after_seconds", "resetAfterSeconds", "resets_in", "resetsIn"]);
  if (seconds !== undefined) return Math.max(0, Math.ceil(seconds));

  const reset = numberField(source, ["resets_at", "resetsAt", "reset_at", "resetAt", "next_reset", "nextReset"]);
  if (reset !== undefined) {
    const milliseconds = reset > 10_000_000_000 ? reset : reset * 1000;
    return Math.max(0, Math.ceil((milliseconds - now) / 1000));
  }

  const resetText = stringField(source, ["resets_at", "resetsAt", "reset_at", "resetAt", "next_reset", "nextReset"]);
  if (resetText) {
    const milliseconds = Date.parse(resetText);
    if (Number.isFinite(milliseconds)) return Math.max(0, Math.ceil((milliseconds - now) / 1000));
  }
  return undefined;
}

const PERCENT_FIELDS = ["percent", "used_percent", "usedPercent", "usage_percent", "usagePercent", "percent_used", "percentUsed", "utilization"];
const USED_FIELDS = ["used", "usage", "requests_used", "requestsUsed", "used_requests", "usedRequests", "consumed", "count", "requests"];
const LIMIT_FIELDS = ["limit", "request_limit", "requestLimit", "requests_limit", "requestsLimit", "max", "capacity", "total"];
const REMAINING_FIELDS = ["remaining", "requests_remaining", "requestsRemaining"];
const RESET_FIELDS = ["resets_at", "resetsAt", "reset_at", "resetAt", "reset_after_seconds", "resetAfterSeconds"];

function parseWindow(source: JsonObject | undefined, now: number): QuotaWindow | null {
  if (!source) return null;

  let percent = numberField(source, PERCENT_FIELDS);
  const used = numberField(source, USED_FIELDS);
  const limit = numberField(source, LIMIT_FIELDS);
  const remaining = numberField(source, REMAINING_FIELDS);

  if (percent === undefined && used !== undefined && limit !== undefined && limit > 0) {
    percent = (used / limit) * 100;
  }
  if (percent === undefined && remaining !== undefined && limit !== undefined && limit > 0) {
    percent = ((limit - remaining) / limit) * 100;
  }
  if (percent === undefined || !Number.isFinite(percent)) return null;

  const reset = resetInSeconds(source, now);
  return {
    label: "",
    usedPercent: clampPercent(percent),
    resetsIn: reset === undefined ? undefined : formatResetIn(reset),
  };
}

function candidateContainers(raw: JsonObject): JsonObject[] {
  const containers = [raw, asObject(raw.usage), asObject(raw.quota), asObject(raw.data)];
  return containers.filter((value): value is JsonObject => value !== undefined);
}

function findWindow(raw: JsonObject, names: string[], flatPrefixes: string[], now: number): QuotaWindow | null {
  for (const container of candidateContainers(raw)) {
    for (const name of names) {
      const candidate = asObject(container[name]);
      const parsed = parseWindow(candidate, now);
      if (parsed) return parsed;
    }

    const flat: JsonObject = {};
    for (const prefix of flatPrefixes) {
      for (const [target, fields] of [
        ["percent", PERCENT_FIELDS],
        ["used", USED_FIELDS],
        ["limit", LIMIT_FIELDS],
        ["remaining", REMAINING_FIELDS],
      ] as const) {
        for (const field of fields) {
          if (container[`${prefix}${field}`] !== undefined) flat[target] = container[`${prefix}${field}`];
        }
      }
      for (const field of RESET_FIELDS) {
        if (container[`${prefix}${field}`] !== undefined) flat[field] = container[`${prefix}${field}`];
      }
    }
    const parsed = parseWindow(flat, now);
    if (parsed) return parsed;

    // A response with a single current-window object may put its fields
    // directly under `usage`, rather than under `usage.window`.
    if (names.includes("window") || names.includes("rolling")) {
      const parsedDirect = parseWindow(container, now);
      if (parsedDirect) return parsedDirect;
    }
  }
  return null;
}

/** Parse a successful Openference usage response into footer windows. */
export function parseOpenferenceUsage(raw: unknown, now: number = Date.now()): QuotaWindow[] {
  const object = asObject(raw);
  if (!object) return [];

  const windows: QuotaWindow[] = [];
  const rolling = findWindow(object, ["window", "rolling", "current_window", "currentWindow", "five_hour", "fiveHour", "five_hour_window", "fiveHourWindow"], ["window_", "rolling_", "five_hour_", "fiveHour"], now);
  if (rolling) windows.push({ ...rolling, label: "5h" });

  const weekly = findWindow(object, ["weekly", "week", "weekly_window", "weekWindow"], ["weekly_", "week_"], now);
  if (weekly) windows.push({ ...weekly, label: "Week" });

  const monthly = findWindow(object, ["monthly", "month", "monthly_window", "monthWindow"], ["monthly_", "month_"], now);
  if (monthly) windows.push({ ...monthly, label: "Month" });

  return windows;
}

async function readTextLimited(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("response-too-large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function responseJson(response: Response): Promise<unknown> {
  return JSON.parse(await readTextLimited(response));
}

function quotaExceededWindows(raw: unknown, now: number): QuotaWindow[] {
  const body = asObject(raw);
  if (!body) return [];
  const resetAt = typeof body.resets_at === "string" ? body.resets_at : undefined;
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  const resetsIn = Number.isFinite(resetMs)
    ? formatResetIn(Math.max(0, Math.ceil((resetMs - now) / 1000)))
    : undefined;
  const window: QuotaWindow = { label: "5h", usedPercent: 100, resetsIn };
  if (body.code === "weekly_request_limit_exceeded") window.label = "Week";
  return [window];
}

/** Fetch Openference's authenticated quota endpoint. Never throws. */
export async function fetchOpenferenceUsage(
  apiKey?: string,
  options: FetchOpenferenceUsageOptions = {},
): Promise<QuotaSnapshot> {
  const key = apiKey || resolveAuthValue(process.env.OPENFERENCE_API_KEY) || authCredential("openference");
  if (!key) return { provider: "Openference", windows: [], error: "no-auth", fetchedAt: Date.now() };

  const { timeoutMs = 10_000, fetchImpl = fetch, now = Date.now } = options;
  const fetchedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(OPENFERENCE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "User-Agent": "pi/openference",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await responseJson(response);
    if (response.status === 401 || response.status === 403) {
      return { provider: "Openference", windows: [], error: "auth-expired", fetchedAt };
    }
    if (response.status === 402) {
      const windows = quotaExceededWindows(body, now());
      if (windows.length > 0) return { provider: "Openference", windows, fetchedAt };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const windows = parseOpenferenceUsage(body, now());
    return {
      provider: "Openference",
      windows,
      ...(windows.length === 0 ? { error: "invalid-response" } : {}),
      fetchedAt,
    };
  } catch (error) {
    return { provider: "Openference", windows: [], error: safeError(error), fetchedAt };
  }
}
