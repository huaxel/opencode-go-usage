import { execFile } from "node:child_process";
import { authCredential } from "../auth/auth.ts";
import { formatResetTime, normalizePercent, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export async function fetchClaudeUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  let token = options.apiKey || authCredential("anthropic");

  if (!token) {
    try {
      // Resolve the macOS keychain credential asynchronously so a slow
      // keychain lookup never blocks the TUI thread.
      const keychain = await new Promise<string>((resolve, reject) => {
        execFile(
          "/usr/bin/security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { encoding: "utf-8", timeout: 2000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      }).then((s) => s.trim());
      const parsed = JSON.parse(keychain);
      token = parsed.claudeAiOauth?.accessToken;
    } catch {
      // No Claude CLI credential.
    }
  }

  if (!token) return { provider: "Claude", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson(
      "https://api.anthropic.com/api/oauth/usage",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );
    const windows: QuotaWindow[] = [];
    const addWindow = (source: any, label: string) => {
      const utilization = Number(source?.utilization);
      if (!Number.isFinite(utilization)) return;
      windows.push({
        label,
        usedPercent: normalizePercent(utilization),
        resetsIn: source.resets_at ? formatResetTime(new Date(source.resets_at)) : undefined,
      });
    };

    addWindow(data.five_hour, "5h");
    addWindow(data.seven_day, "Week");
    // Some subscription variants expose a monthly bucket; do not synthesize
    // one when the endpoint omits it.
    addWindow(data.monthly ?? data.thirty_day ?? data.thirty_day_window, "Month");

    return { provider: "Claude", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Claude", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
