# @juanbenjumea/pi-provider-usage-fetcher

Shared **provider usage** library for Pi extensions, agentq, and other tooling.

Despite the name (historical), this package covers more than OpenCode Go:

| Provider | Auth | Source |
|---|---|---|
| **OpenCode Go** | API key (same as chat) | `GET https://opencode.ai/zen/go/v1/usage` |
| **Claude** | macOS keychain, `auth.json`, explicit apiKey | `GET https://api.anthropic.com/api/oauth/usage` |
| **Codex** | `auth.json`, `~/.codex/auth.json`, explicit apiKey | `GET https://chatgpt.com/backend-api/wham/usage` |
| **ClinePass** | `CLINE_API_KEY`, `auth.json`, explicit apiKey | `api.cline.bot/api/v1/*` |
| **Umans** | `UMANS_API_KEY`, `auth.json`, explicit apiKey | `GET https://api.code.umans.ai/v1/usage` |
| **Copilot** | `auth.json` (`github-copilot`), explicit apiKey | `GET https://api.github.com/copilot_internal/user` |
| **Gemini** | `auth.json`, `~/.gemini/oauth_creds.json`, explicit apiKey | `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` |
| **Kimi Coding** | `KIMI_API_KEY`, `auth.json`, explicit apiKey | `GET https://api.kimi.com/coding/v1/usages` |
| **Synthetic** | `SYNTHETIC_API_KEY`, `auth.json`, explicit apiKey | `GET https://api.synthetic.new/v2/quotas` |
| **z.ai / GLM** | Region-specific environment key, `auth.json`, explicit apiKey | `GET {api.z.ai or open.bigmodel.cn}/api/monitor/usage/quota/limit` |
| **Grok / SuperGrok** | `GROK_OAUTH_TOKEN`, `GROK_ACCESS_TOKEN`, `auth.json` (`grok`), or `~/.grok/auth.json` | Grok CLI billing proxy (`cli-chat-proxy.grok.com/v1/billing?format=credits`) |
| **Cursor** | `quota-sessions.json`, env, CodexBar, Cursor app DB | `cursor.com/api/usage-summary` |
| **CommandCode** | `quota-sessions.json`, env, CodexBar | `api.commandcode.ai/internal/billing/*` |
| **Openference** | API key from caller, `OPENFERENCE_API_KEY`, or `auth.json` | `GET https://openference.com/api/user/me` |

Legacy OpenCode Go dashboard cookie scraping remains as a fallback when no API key is configured.

Grok reports **subscription credits**, not xAI API spend. Its quota adapter follows the Grok CLI billing route observed in CodexBar; this is a private CLI endpoint and may change. It does not use xAI inference API keys or xAI Management API spend endpoints.

## Install

```bash
npm install @juanbenjumea/pi-provider-usage-fetcher
```

Monorepo consumers: `"@juanbenjumea/pi-provider-usage-fetcher": "file:../opencode-go-usage"`.

## Unified Dispatch

```ts
import { detectProvider, fetchProviderUsage, fetchAllProviderUsage } from "@juanbenjumea/pi-provider-usage-fetcher";

// Automatically detects alias ("anthropic", "github-copilot", "opencode", etc.)
const canonical = detectProvider("anthropic"); // "claude"

// Fetches and normalizes quota snapshot across any supported provider
const snapshot = await fetchProviderUsage("anthropic", { apiKey: "..." });
// { provider: "Claude", windows: [ { label: "5h", usedPercent: 45, resetsIn: "1h30m" }, ... ], fetchedAt }

// Or collect several providers concurrently; unknown providers are omitted.
const snapshots = await fetchAllProviderUsage(["anthropic", "openai-codex", "cursor"]);
```

## OpenCode Go (API-first)

```ts
import { fetchUsageApi } from "@juanbenjumea/pi-provider-usage-fetcher";

const usage = await fetchUsageApi(process.env.OPENCODE_GO_KEY!);
// { rolling, weekly, monthly, error? }
```

## Cursor / CommandCode

```ts
import { fetchCursorUsage } from "@juanbenjumea/pi-provider-usage-fetcher/cursor.ts";
import { fetchCommandCodeUsage } from "@juanbenjumea/pi-provider-usage-fetcher/commandcode.ts";
import { fetchOpenferenceUsage } from "@juanbenjumea/pi-provider-usage-fetcher/openference.ts";

// Footer labels (Plan / Auto / API)
await fetchCursorUsage();

// agentq labels (total / auto-composer / api-models)
await fetchCursorUsage({ labelStyle: "agentq" });

await fetchCommandCodeUsage();

// Uses the dashboard profile endpoint (openference.com/api/user/me), which the
// inference API key authenticates via Bearer. window = usage.windowQuotaUsed /
// plan.requestsPerWindow, week = usage.weekQuotaUsed / plan.requestsPerWeek.
const openference = await fetchOpenferenceUsage(process.env.OPENFERENCE_API_KEY);
```

Auth resolution order: provider-specific explicit key → environment variable → `auth.json` credential. For Cursor and CommandCode cookies, the existing order is `quota-sessions.json` → env vars → legacy `auth.json` cookies → CodexBar manual cookies → (Cursor only) desktop app token.

## Consumers

- `@juanbenjumea/pi-dynamic-footer` — subscription quota bars
- `@juanbenjumea/pi-multi-opencode-go` — failover usage polling
- **agentq** — `data/quota.json` collector

## Package rename

This package is published as `@juanbenjumea/pi-provider-usage-fetcher`. Existing consumers of the former `@juanbenjumea/opencode-go-usage` npm package must switch their dependency and imports when adopting this package; the old package identity remains separate.
