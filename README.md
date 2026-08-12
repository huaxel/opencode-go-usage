# @juanbenjumea/opencode-go-usage

Shared **provider usage** library for Pi extensions, agentq, and other tooling.

Despite the name (historical), this package covers more than OpenCode Go:

| Provider | Auth | Source |
|---|---|---|
| **OpenCode Go** | API key (same as chat) | `GET https://opencode.ai/zen/go/v1/usage` |
| **Cursor** | `quota-sessions.json`, env, CodexBar, Cursor app DB | `cursor.com/api/usage-summary` |
| **CommandCode** | `quota-sessions.json`, env, CodexBar | `api.commandcode.ai/internal/billing/*` |

Legacy OpenCode Go dashboard cookie scraping remains as a fallback when no API key is configured.

## Install

```bash
npm install @juanbenjumea/opencode-go-usage
```

Monorepo consumers: `"@juanbenjumea/opencode-go-usage": "file:../opencode-go-usage"`.

## OpenCode Go (API-first)

```ts
import { fetchUsageApi } from "@juanbenjumea/opencode-go-usage";

const usage = await fetchUsageApi(process.env.OPENCODE_GO_KEY!);
// { rolling, weekly, monthly, error? }
```

## Cursor / CommandCode

```ts
import { fetchCursorUsage } from "@juanbenjumea/opencode-go-usage/cursor.ts";
import { fetchCommandCodeUsage } from "@juanbenjumea/opencode-go-usage/commandcode.ts";

// Footer labels (Plan / Auto / API)
await fetchCursorUsage();

// agentq labels (total / auto-composer / api-models)
await fetchCursorUsage({ labelStyle: "agentq" });

await fetchCommandCodeUsage();
```

Auth resolution order: `quota-sessions.json` → env vars → legacy `auth.json` cookies → CodexBar manual cookies → (Cursor only) desktop app token.

## Consumers

- `@juanbenjumea/pi-dynamic-footer` — subscription quota bars
- `@juanbenjumea/pi-multi-opencode-go` — failover usage polling
- **agentq** — `data/quota.json` collector

## Future

A rename to `@juanbenjumea/provider-usage` may happen in a major release; subpath exports will remain stable through 0.x.
