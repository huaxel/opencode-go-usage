import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { authCredential, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export const GROK_CREDITS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OIDC_SCOPE_PREFIX = "https://auth.x.ai::";
const LEGACY_SCOPE = "https://accounts.x.ai/sign-in";

/** Parse the scope-keyed auth.json written by `grok login`, preferring SuperGrok OIDC. */
export function parseGrokAuthFile(contents: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]),
    );
    const candidates = [
      ...entries.filter(([scope]) => scope.startsWith(OIDC_SCOPE_PREFIX)),
      ...entries.filter(([scope]) => scope === LEGACY_SCOPE || scope.includes("/sign-in")),
    ];
    for (const [, entry] of candidates) {
      const token = typeof entry.key === "string" ? normalizeBearer(entry.key) : undefined;
      if (token) return token;
    }
  } catch {
    // Treat absent, malformed, or partial CLI credentials as unavailable.
  }
  return undefined;
}

function normalizeBearer(value: string | undefined): string | undefined {
  let token = value?.trim() ?? "";
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  // xAI inference keys and cookies are not SuperGrok OAuth credentials.
  if (
    !token ||
    token.toLowerCase().startsWith("xai-") ||
    token.toLowerCase().startsWith("cookie:") ||
    token.includes("=")
  ) {
    return undefined;
  }
  return token;
}

function grokCliToken(): string | undefined {
  const configuredHome = process.env.GROK_HOME?.trim();
  const home = configuredHome
    ? resolve(configuredHome.replace(/^~(?=\/|$)/, homedir()))
    : join(homedir(), ".grok");
  const path = join(home, "auth.json");
  try {
    if (existsSync(path)) return parseGrokAuthFile(readFileSync(path, "utf8"));
  } catch {
    // Treat inaccessible credentials as unavailable; never expose file errors or contents.
  }
  return undefined;
}

function grokToken(apiKey?: string): string | undefined {
  return (
    normalizeBearer(apiKey) ||
    normalizeBearer(resolveAuthValue(process.env.GROK_OAUTH_TOKEN)) ||
    normalizeBearer(resolveAuthValue(process.env.GROK_ACCESS_TOKEN)) ||
    normalizeBearer(authCredential("grok", "supergrok")) ||
    grokCliToken()
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function windowLabel(start: Date | undefined, end: Date | undefined): string {
  if (!start || !end || end <= start) return "Credits";
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days >= 4 && days <= 12) return "Week";
  if (days >= 20 && days <= 45) return "Month";
  return "Credits";
}

export async function fetchGrokUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const token = grokToken(options.apiKey);
  if (!token) return { provider: "Grok", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson(
      GROK_CREDITS_ENDPOINT,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-xai-token-auth": "xai-grok-cli",
          Accept: "application/json",
        },
      },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );

    const config = data?.config;
    if (!config || typeof config !== "object") throw new Error("invalid-response");
    const creditPercent = finiteNumber(config.creditUsagePercent);
    const cap = finiteNumber(config.onDemandCap?.val);
    const used = finiteNumber(config.onDemandUsed?.val);
    const derivedPercent = cap !== undefined && cap > 0 && used !== undefined ? (used / cap) * 100 : undefined;
    const usedPercent = creditPercent ?? derivedPercent;
    if (usedPercent === undefined) throw new Error("invalid-response");

    const period = config.currentPeriod;
    const currentPeriodEnd = parseDate(period?.end);
    const end = currentPeriodEnd ?? parseDate(config.billingPeriodEnd);
    // Do not combine a start from the current-period object with a fallback end
    // from another period; duration is used only to label the quota window.
    const start = currentPeriodEnd
      ? parseDate(period?.start)
      : parseDate(config.billingPeriodStart);
    const resetDate = end && end.getTime() > Date.now() ? end : undefined;
    const window: QuotaWindow = {
      label: windowLabel(start, end),
      usedPercent: clampPercent(usedPercent),
      ...(resetDate
        ? { resetsAt: resetDate.toISOString(), resetsIn: formatResetTime(resetDate) }
        : {}),
    };
    return { provider: "Grok", windows: [window], fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Grok", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
