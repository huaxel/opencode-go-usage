// Openference usage via the dashboard profile endpoint.
//
// Openference exposes no usage endpoint on its inference API
// (api.openference.com/v1). The dashboard's `/user/usage` analytics page calls
// `GET /api/user/usage`, but the per-window quota bars are served by the
// profile endpoint `GET /api/user/me` on the web host (openference.com), which
// the same inference API key authenticates via Bearer. The response carries a
// `usage` object (cost-weighted quota used), a `plan` object (window/weekly
// allowances), and a `limits` object (epoch-ms reset timestamps). The web UI's
// `tst()` helper prefers `windowQuotaUsed` over `windowRequests` as the used
// value, and `plan.requestsPerWindow`/`plan.requestsPerWeek` as the limits —
// this parser mirrors that.
import type { QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";
import { clampPercent, safeError } from "../shared/format.ts";
import { authCredential, resolveAuthValue } from "../auth/auth.ts";

export const OPENFERENCE_USAGE_URL = "https://openference.com/api/user/me";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_WINDOW_HOURS = 5;

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

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
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

function resetInFromEpochMs(ms: unknown, now: number): string | undefined {
  const value = finiteNumber(ms);
  if (value === undefined) return undefined;
  // Openference reports resets as epoch milliseconds.
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return formatResetIn(Math.max(0, Math.ceil((milliseconds - now) / 1000)));
}

/**
 * Pick the "used" value for a window, mirroring the dashboard `tst()` helper:
 * prefer `usage.<quotaKey>`, then `limits.<quotaKey>`, then `limits.<requestsKey>`
 * (a cost-weighted quota is always preferred over a raw request count).
 */
function pickUsed(
  usage: JsonObject | undefined,
  limits: JsonObject | undefined,
  quotaKey: string,
  requestsKey: string,
): number | undefined {
  return (
    finiteNumber(usage?.[quotaKey]) ??
    finiteNumber(limits?.[quotaKey]) ??
    finiteNumber(limits?.[requestsKey])
  );
}

function pickLimit(plan: JsonObject | undefined, key: string): number | undefined {
  const value = finiteNumber(plan?.[key]);
  return value !== undefined && value > 0 ? value : undefined;
}

function buildWindow(
  used: number | undefined,
  limit: number | undefined,
  reset: string | undefined,
  label: string,
): QuotaWindow | null {
  if (used === undefined || limit === undefined || limit <= 0) return null;
  return {
    label,
    usedPercent: clampPercent((used / limit) * 100),
    resetsIn: reset,
  };
}

/** Parse a successful `GET /api/user/me` response into footer windows. */
export function parseOpenferenceUsage(raw: unknown, now: number = Date.now()): QuotaWindow[] {
  const object = asObject(raw);
  if (!object) return [];

  const usage = asObject(object.usage);
  const plan = asObject(object.plan);
  const limits = asObject(object.limits);

  const windows: QuotaWindow[] = [];

  const windowHours = finiteNumber(plan?.windowHours) ?? DEFAULT_WINDOW_HOURS;
  const window = buildWindow(
    pickUsed(usage, limits, "windowQuotaUsed", "windowRequests"),
    pickLimit(plan, "requestsPerWindow"),
    resetInFromEpochMs(limits?.windowResetAt, now),
    `${windowHours}h`,
  );
  if (window) windows.push(window);

  const week = buildWindow(
    pickUsed(usage, limits, "weekQuotaUsed", "weekRequests"),
    pickLimit(plan, "requestsPerWeek"),
    resetInFromEpochMs(limits?.weeklyResetAt, now),
    "Week",
  );
  if (week) windows.push(week);

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

/** Fetch Openference's authenticated usage endpoint. Never throws. */
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

    if (response.status === 401 || response.status === 403) {
      return { provider: "Openference", windows: [], error: "auth-expired", fetchedAt };
    }

    const body = await responseJson(response);

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
