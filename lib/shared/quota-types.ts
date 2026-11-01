export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsIn?: string;
  resetsAt?: string | null;
  resetDescription?: string | null;
  slot?: string;
}

export interface QuotaSnapshot {
  provider: string;
  windows: QuotaWindow[];
  error?: string;
  fetchedAt: number;
}

export interface QuotaFetchOptions {
  /** Resolved by pi's model registry or caller, when available. */
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** z.ai API region; keys are region-specific. */
  region?: "global" | "bigmodel-cn";
  /** Optional z.ai organization scope; both organization and project are required. */
  organization?: string;
  project?: string;
}

export type CursorLabelStyle = "footer" | "agentq";
