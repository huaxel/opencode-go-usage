import { authCredential, resolveAuthValue } from "../auth/auth.ts";
import { clampPercent, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export async function fetchUmansUsage(
  apiKeyOrOptions?: string | QuotaFetchOptions,
  maybeOptions?: QuotaFetchOptions,
): Promise<QuotaSnapshot> {
  const options =
    typeof apiKeyOrOptions === "object" && apiKeyOrOptions !== null
      ? apiKeyOrOptions
      : (maybeOptions ?? {});
  const explicitKey =
    typeof apiKeyOrOptions === "string" ? apiKeyOrOptions : options.apiKey;
  const key = explicitKey || resolveAuthValue(process.env.UMANS_API_KEY) || authCredential("umans");

  if (!key) return { provider: "Umans", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson(
      "https://api.code.umans.ai/v1/usage",
      {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "pi-obs-footer" },
      },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );
    const windows: QuotaWindow[] = [];
    const requestLimit = Number(data.limits?.requests?.limit);
    const requestsUsed = Number(data.usage?.requests_in_window);
    if (Number.isFinite(requestLimit) && requestLimit > 0 && Number.isFinite(requestsUsed)) {
      windows.push({ label: "Req", usedPercent: clampPercent((requestsUsed / requestLimit) * 100) });
    }

    const concurrencyLimit = Number(data.limits?.concurrency?.limit);
    const concurrencyUsed = Number(data.usage?.concurrent_sessions);
    if (Number.isFinite(concurrencyLimit) && concurrencyLimit > 0 && Number.isFinite(concurrencyUsed)) {
      windows.push({ label: "Conc", usedPercent: clampPercent((concurrencyUsed / concurrencyLimit) * 100) });
    }

    return { provider: "Umans", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Umans", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
