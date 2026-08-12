# @juanbenjumea/opencode-go-usage

Small library (not a Pi extension) that fetches OpenCode Go usage windows (rolling / weekly / monthly).

**Primary path (v0.2.0+):** the official usage API — `GET https://opencode.ai/zen/go/v1/usage` with the same API key used for chat completions. No workspace cookies, no HTML scraping.

**Legacy fallback:** parses the OpenCode Go workspace dashboard HTML (`usagePercent` / `resetInSec` regexes) for configs that predate the API.

Used by:

- `@juanbenjumea/pi-multi-opencode-go` — account rotation
- `@juanbenjumea/pi-dynamic-footer` — quota bars

## API

```typescript
import { fetchUsageApi } from "@juanbenjumea/opencode-go-usage";

// Official API — key only, no cookies.
const usage = await fetchUsageApi("sk-...");
// { rolling: { usagePercent, resetInSec, status? } | null, weekly: ..., monthly: ..., error? }

// Legacy dashboard scrape (cookie auth) — kept for backwards compatibility.
import { fetchDashboardUsage } from "@juanbenjumea/opencode-go-usage/lib/fetch.ts";
const legacy = await fetchDashboardUsage("wrk_...", "Fe26.2**...");
```

## Test

```bash
npm test
```

## Publish

```bash
npm publish --access public
```

MIT
