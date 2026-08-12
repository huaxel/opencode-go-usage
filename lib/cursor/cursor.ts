import type { CursorLabelStyle, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { resolveCursorCookieHeader } from "./cursor-auth.ts";

interface CursorUsageSummary {
  billingCycleEnd?: string;
  individualUsage?: {
    plan?: {
      used?: number;
      limit?: number;
      autoPercentUsed?: number;
      apiPercentUsed?: number;
      totalPercentUsed?: number;
    };
    onDemand?: {
      enabled?: boolean;
      used?: number;
      limit?: number;
      remaining?: number;
    };
    overall?: { used?: number; limit?: number };
  };
  teamUsage?: {
    pooled?: { used?: number; limit?: number };
  };
  membershipType?: string;
  isUnlimited?: boolean;
  billingCycleStart?: string;
}

function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** Cursor percent fields are already percentage units (0.36 = 0.36%). */
function cursorPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return clampPercent(value);
}

const CURSOR_LABELS: Record<
  CursorLabelStyle,
  { plan: string; auto: string; api: string }
> = {
  footer: { plan: "Plan", auto: "Auto", api: "API" },
  agentq: { plan: "total", auto: "auto-composer", api: "api-models" },
};

export function parseCursorUsageSummary(
  summary: CursorUsageSummary,
  labelStyle: CursorLabelStyle = "footer",
): QuotaWindow[] {
  const labels = CURSOR_LABELS[labelStyle];
  const billingEnd = parseIsoDate(summary.billingCycleEnd);
  const resetsIn = billingEnd ? formatResetTime(billingEnd) : undefined;
  const resetsAt = billingEnd ? billingEnd.toISOString() : null;
  const resetDescription = billingEnd
    ? billingEnd.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const plan = summary.individualUsage?.plan;
  const autoPercent = cursorPercent(plan?.autoPercentUsed);
  const apiPercent = cursorPercent(plan?.apiPercentUsed);

  const planUsedRaw = Number(plan?.used ?? 0);
  const planLimitRaw = Number(plan?.limit ?? 0);
  const overallUsed = summary.individualUsage?.overall?.used;
  const overallLimit = summary.individualUsage?.overall?.limit;
  const pooledUsed = summary.teamUsage?.pooled?.used;
  const pooledLimit = summary.teamUsage?.pooled?.limit;

  let planPercent: number;
  if (plan?.totalPercentUsed !== undefined) {
    planPercent = cursorPercent(plan.totalPercentUsed) ?? 0;
  } else if (autoPercent !== undefined && apiPercent !== undefined) {
    planPercent = clampPercent((autoPercent + apiPercent) / 2);
  } else if (apiPercent !== undefined) {
    planPercent = apiPercent;
  } else if (autoPercent !== undefined) {
    planPercent = autoPercent;
  } else if (planLimitRaw > 0) {
    planPercent = clampPercent((planUsedRaw / planLimitRaw) * 100);
  } else if (overallLimit && overallLimit > 0 && overallUsed !== undefined) {
    planPercent = clampPercent((overallUsed / overallLimit) * 100);
  } else if (pooledLimit && pooledLimit > 0 && pooledUsed !== undefined) {
    planPercent = clampPercent((pooledUsed / pooledLimit) * 100);
  } else {
    planPercent = 0;
  }

  const windows: QuotaWindow[] = [{
    ...(labelStyle === "agentq" ? { slot: "primary" as const } : {}),
    label: labels.plan,
    usedPercent: planPercent,
    resetsIn,
    resetsAt,
    resetDescription,
  }];

  if (autoPercent !== undefined) {
    windows.push({
      ...(labelStyle === "agentq" ? { slot: "secondary" as const } : {}),
      label: labels.auto,
      usedPercent: autoPercent,
      resetsIn,
      resetsAt,
      resetDescription,
    });
  }
  if (apiPercent !== undefined) {
    windows.push({
      ...(labelStyle === "agentq" ? { slot: "tertiary" as const } : {}),
      label: labels.api,
      usedPercent: apiPercent,
      resetsIn,
      resetsAt,
      resetDescription,
    });
  }

  const onDemand = summary.individualUsage?.onDemand;
  if (onDemand?.enabled) {
    windows.push({
      label: "on-demand",
      usedPercent: onDemand.used != null && onDemand.limit
        ? clampPercent((onDemand.used / onDemand.limit) * 100)
        : 0,
      resetsIn,
      resetsAt,
      resetDescription: onDemand.remaining != null
        ? `$${onDemand.remaining} remaining`
        : resetDescription,
    });
  }

  return windows;
}

async function fetchJsonWithCookie(url: string, cookieHeader: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
        "User-Agent": "pi-provider-usage",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("HTTP 401");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchCursorUsageOptions {
  labelStyle?: CursorLabelStyle;
}

export async function fetchCursorUsage(
  options: FetchCursorUsageOptions = {},
): Promise<QuotaSnapshot> {
  const cookieHeader = resolveCursorCookieHeader();
  if (!cookieHeader) {
    return { provider: "Cursor", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const data = await fetchJsonWithCookie(
      "https://cursor.com/api/usage-summary",
      cookieHeader,
    );
    const windows = parseCursorUsageSummary(data as CursorUsageSummary, options.labelStyle);
    return { provider: "Cursor", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Cursor", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
