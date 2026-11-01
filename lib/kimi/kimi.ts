import { authCredential, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export async function fetchKimiUsage(
  apiKeyOrOptions?: string | QuotaFetchOptions,
  maybeOptions?: QuotaFetchOptions,
): Promise<QuotaSnapshot> {
  const options =
    typeof apiKeyOrOptions === "object" && apiKeyOrOptions !== null
      ? apiKeyOrOptions
      : (maybeOptions ?? {});
  const explicitKey =
    typeof apiKeyOrOptions === "string" ? apiKeyOrOptions : options.apiKey;
  const token = explicitKey || resolveAuthValue(process.env.KIMI_API_KEY) || authCredential("kimi-coding");

  if (!token) return { provider: "Kimi Coding", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson(
      "https://api.kimi.com/coding/v1/usages",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );
    const windows: QuotaWindow[] = [];

    for (const limit of data.limits || []) {
      const windowLimit = Number(limit.detail?.limit);
      const windowRemaining = Number(limit.detail?.remaining);
      if (Number.isFinite(windowLimit) && windowLimit > 0 && Number.isFinite(windowRemaining)) {
        const used = windowLimit - windowRemaining;
        const usedPercent = clampPercent((used / windowLimit) * 100);
        const resetDate = limit.detail?.resetTime ? new Date(limit.detail.resetTime) : undefined;
        const label =
          limit.window?.duration && limit.window?.timeUnit === "TIME_UNIT_MINUTE"
            ? `${Math.round(limit.window.duration / 60)}h`
            : "Window";
        windows.push({
          label,
          usedPercent,
          resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
        });
      }
    }

    const weeklyLimit = Number(data.usage?.limit);
    const weeklyRemaining = Number(data.usage?.remaining);
    const weeklyResetTime = data.usage?.resetTime;
    if (Number.isFinite(weeklyLimit) && weeklyLimit > 0 && Number.isFinite(weeklyRemaining)) {
      const used = weeklyLimit - weeklyRemaining;
      const usedPercent = clampPercent((used / weeklyLimit) * 100);
      windows.push({
        label: "Week",
        usedPercent,
        resetsIn: weeklyResetTime ? formatResetTime(new Date(weeklyResetTime)) : undefined,
      });
    }

    return { provider: "Kimi Coding", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Kimi Coding", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
