import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authCredential } from "../auth/auth.ts";
import { clampPercent, formatResetTime, safeError } from "../shared/format.ts";
import { fetchJson } from "../shared/http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../shared/quota-types.ts";

export async function fetchGeminiUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  let token = options.apiKey || authCredential("google-gemini-cli");

  if (!token) {
    try {
      const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
      if (existsSync(geminiPath)) {
        const creds = JSON.parse(readFileSync(geminiPath, "utf-8"));
        token = creds.access_token;
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { provider: "Gemini", windows: [], error: "gemini-oauth-creds-corrupt", fetchedAt: Date.now() };
      }
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EACCES") {
        return { provider: "Gemini", windows: [], error: "gemini-oauth-creds-permission", fetchedAt: Date.now() };
      }
    }
  }

  if (!token) return { provider: "Gemini", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      },
      options.timeoutMs ?? 10_000,
      options.fetchImpl ?? fetch,
    );

    const quotas: Record<string, { frac: number; resetTime?: string }> = {};
    for (const bucket of data.buckets || []) {
      const model = typeof bucket.modelId === "string" ? bucket.modelId : "unknown";
      const remainingFraction = Number(bucket.remainingFraction);
      if (!Number.isFinite(remainingFraction)) continue;
      const frac = Math.max(0, Math.min(1, remainingFraction));
      const existing = quotas[model];
      if (!existing || frac < existing.frac) {
        quotas[model] = { frac, resetTime: bucket.resetTime || bucket.reset_time };
      }
    }

    const windows: QuotaWindow[] = [];
    let proMin = 1, flashMin = 1;
    let hasProModel = false, hasFlashModel = false;
    let proReset: string | undefined, flashReset: string | undefined;

    for (const [model, { frac, resetTime }] of Object.entries(quotas)) {
      if (model.toLowerCase().includes("pro")) {
        hasProModel = true;
        if (frac < proMin) { proMin = frac; proReset = resetTime; }
      }
      if (model.toLowerCase().includes("flash")) {
        hasFlashModel = true;
        if (frac < flashMin) { flashMin = frac; flashReset = resetTime; }
      }
    }

    if (hasProModel) {
      windows.push({
        label: "Pro",
        usedPercent: clampPercent((1 - proMin) * 100),
        resetsIn: proReset ? formatResetTime(new Date(proReset)) : undefined,
      });
    }
    if (hasFlashModel) {
      windows.push({
        label: "Flash",
        usedPercent: clampPercent((1 - flashMin) * 100),
        resetsIn: flashReset ? formatResetTime(new Date(flashReset)) : undefined,
      });
    }

    return { provider: "Gemini", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Gemini", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
