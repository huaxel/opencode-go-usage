import { authCredential } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export async function fetchCopilotUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const token = options.apiKey || authCredential("github-copilot");
  if (!token) return { provider: "Copilot", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson(
      "https://api.github.com/copilot_internal/user",
      {
        headers: {
          "Editor-Version": "vscode/1.96.2",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-Github-Api-Version": "2025-04-01",
          Accept: "application/json",
          Authorization: `token ${token}`,
        },
      },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );
    const windows: QuotaWindow[] = [];

    const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
    const resetsIn = resetDate ? formatResetTime(resetDate) : undefined;

    if (data.quota_snapshots?.premium_interactions) {
      const pi = data.quota_snapshots.premium_interactions;
      const remaining = Number(pi.percent_remaining);
      if (Number.isFinite(remaining)) {
        windows.push({ label: "Premium", usedPercent: clampPercent(100 - remaining), resetsIn });
      }
    }

    if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
      const chat = data.quota_snapshots.chat;
      const remaining = Number(chat.percent_remaining);
      if (Number.isFinite(remaining)) {
        windows.push({
          label: "Chat",
          usedPercent: clampPercent(100 - remaining),
          resetsIn,
        });
      }
    }

    return { provider: "Copilot", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Copilot", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
