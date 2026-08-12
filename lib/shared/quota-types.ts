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

export type CursorLabelStyle = "footer" | "agentq";
