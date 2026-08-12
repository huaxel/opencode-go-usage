// Official OpenCode Go usage API (GET https://opencode.ai/zen/go/v1/usage).
//
// Announced 2026-08-11 (opencode.ai/zen/go/v1/usage): the Go subscription
// exposes rolling (5h), weekly, and monthly windows as JSON using the same
// API key used for chat completions — no workspace dashboard cookies, no HTML
// scraping. This module is the API-first source of usage data; the dashboard
// parser (lib/dashboard.ts) remains only as a legacy fallback for configs
// that predate the API.
import type {
  OpenCodeGoApiResponse,
  OpenCodeGoDashboardUsage,
  OpenCodeGoUsageResult,
  OpenCodeGoWindow,
} from "./types.ts";

export interface FetchUsageApiOptions {
  /** Abort timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Fetch implementation override (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Clock override (tests). Defaults to Date.now(). */
  now?: () => number;
}

export const USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";

/**
 * Parse the usage API JSON response into the shared usage-window shape.
 * A window is emitted whenever `percent` is a finite number; `resetsAt` is
 * converted to a relative reset-in-seconds value. Never throws.
 */
export function parseUsageApiJson(
  raw: unknown,
  now: number = Date.now(),
): OpenCodeGoDashboardUsage {
  const usage =
    raw && typeof raw === "object"
      ? (raw as OpenCodeGoApiResponse).usage
      : undefined;
  if (!usage || typeof usage !== "object") {
    return { rolling: null, weekly: null, monthly: null };
  }
  const mapWindow = (
    source: { status?: string; percent?: number; resetsAt?: string } | undefined,
  ): OpenCodeGoWindow | null => {
    if (!source || typeof source !== "object") return null;
    const percent = Number(source.percent);
    if (!Number.isFinite(percent)) return null;
    let resetInSec = 0;
    const resetsAt = source.resetsAt;
    if (typeof resetsAt === "string" && resetsAt.trim()) {
      const resetsAtMs = Date.parse(resetsAt);
      if (Number.isFinite(resetsAtMs)) {
        resetInSec = Math.max(0, Math.ceil((resetsAtMs - now) / 1000));
      }
    }
    const window: OpenCodeGoWindow = { usagePercent: percent, resetInSec };
    if (typeof source.status === "string" && source.status) {
      window.status = source.status;
    }
    return window;
  };
  return {
    rolling: mapWindow(usage.rolling),
    weekly: mapWindow(usage.weekly),
    monthly: mapWindow(usage.monthly),
  };
}

/**
 * Fetch usage for one OpenCode Go subscription via the official API.
 * Never throws — failures become `{ error }` results. A 401 maps to
 * "auth-expired" to match the legacy dashboard fetch semantics.
 */
export async function fetchUsageApi(
  apiKey: string,
  options: FetchUsageApiOptions = {},
): Promise<OpenCodeGoUsageResult> {
  const {
    timeoutMs = 10_000,
    fetchImpl = fetch,
    now = Date.now,
  } = options;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(USAGE_API_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      return { rolling: null, weekly: null, monthly: null, error: "auth-expired" };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseUsageApiJson(await response.json(), now());
    return parsed;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return { rolling: null, weekly: null, monthly: null, error: message };
  }
}
