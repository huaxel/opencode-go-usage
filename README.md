# @juanbenjumea/opencode-go-usage

Small library (not a Pi extension) that parses OpenCode Go workspace dashboard HTML into rolling / weekly / monthly usage windows.

Used by:

- `@juanbenjumea/pi-multi-opencode-go` — account rotation
- `@juanbenjumea/pi-dynamic-footer` — quota bars

## API

```typescript
import {
  parseOpenCodeGoDashboard,
  isAuthenticatedWorkspaceUrl,
} from "@juanbenjumea/opencode-go-usage";
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
