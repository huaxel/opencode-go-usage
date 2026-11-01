import type { QuotaFetchOptions, QuotaSnapshot } from "../shared/quota-types.ts";
import { fetchClaudeUsage } from "../claude/claude.ts";
import { fetchCodexUsage } from "../codex/codex.ts";
import { fetchClineUsage } from "../cline/cline.ts";
import { fetchUmansUsage } from "../umans/umans.ts";
import { fetchCopilotUsage } from "../copilot/copilot.ts";
import { fetchGeminiUsage } from "../gemini/gemini.ts";
import { fetchKimiUsage } from "../kimi/kimi.ts";
import { fetchSyntheticUsage } from "../synthetic/synthetic.ts";
import { fetchZaiUsage } from "../zai/zai.ts";
import { fetchCursorUsage } from "../cursor/cursor.ts";
import { fetchCommandCodeUsage } from "../commandcode/commandcode.ts";
import { fetchOpenferenceUsage } from "../openference/openference.ts";
import { fetchOpencodeGoUsage } from "../opencode-go/opencode-go.ts";
import { safeError } from "../shared/format.ts";

export const PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude",
  "claude-bridge": "claude",
  claude: "claude",
  "openai-codex": "codex",
  codex: "codex",
  opencode: "opencode-go",
  "opencode-go": "opencode-go",
  "cline-pass": "cline-pass",
  clinepass: "cline-pass",
  umans: "umans",
  "github-copilot": "copilot",
  copilot: "copilot",
  "google-gemini-cli": "gemini",
  gemini: "gemini",
  "kimi-coding": "kimi",
  kimi: "kimi",
  synthetic: "synthetic",
  "synthetic.new": "synthetic",
  zai: "zai",
  "z.ai": "zai",
  "glm-coding-plan": "zai",
  cursor: "cursor",
  commandcode: "commandcode",
  openference: "openference",
};

export function detectProvider(providerId: string): string | null {
  if (!providerId || typeof providerId !== "string") return null;
  const normalized = providerId.trim().toLowerCase();
  return PROVIDER_MAP[normalized] || PROVIDER_MAP[providerId] || null;
}

export type ProviderFetcher = (options?: QuotaFetchOptions) => Promise<QuotaSnapshot>;

export const PROVIDER_FETCHERS: Record<string, ProviderFetcher> = {
  claude: fetchClaudeUsage,
  codex: fetchCodexUsage,
  "opencode-go": fetchOpencodeGoUsage,
  "cline-pass": (options) => fetchClineUsage(options),
  umans: (options) => fetchUmansUsage(options),
  copilot: fetchCopilotUsage,
  gemini: fetchGeminiUsage,
  kimi: (options) => fetchKimiUsage(options),
  synthetic: fetchSyntheticUsage,
  zai: fetchZaiUsage,
  cursor: () => fetchCursorUsage(),
  commandcode: () => fetchCommandCodeUsage(),
  openference: (options) => fetchOpenferenceUsage(options?.apiKey, options),
};

export async function fetchProviderUsage(
  providerIdOrAlias: string,
  options: QuotaFetchOptions = {},
): Promise<QuotaSnapshot | null> {
  const canonical = detectProvider(providerIdOrAlias);
  if (!canonical) return null;

  const fetcher = PROVIDER_FETCHERS[canonical];
  if (!fetcher) return null;

  try {
    return await fetcher(options);
  } catch (error) {
    return {
      provider: canonical,
      windows: [],
      error: safeError(error),
      fetchedAt: Date.now(),
    };
  }
}

/** Fetch several providers concurrently; unknown providers are omitted and failures remain isolated. */
export async function fetchAllProviderUsage(
  providerIds: string[],
  options: QuotaFetchOptions = {},
): Promise<QuotaSnapshot[]> {
  const results = await Promise.all(providerIds.map((providerId) => fetchProviderUsage(providerId, options)));
  return results.filter((result): result is QuotaSnapshot => result !== null);
}

export const fetchQuota = fetchProviderUsage;
