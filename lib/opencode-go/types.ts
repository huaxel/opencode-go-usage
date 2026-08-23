export interface OpenCodeGoWindow {
  usagePercent: number;
  resetInSec: number;
  /** API-only: window status ("ok", "exhausted", ...). Absent for dashboard parsing. */
  status?: string;
}

export interface OpenCodeGoDashboardUsage {
  rolling: OpenCodeGoWindow | null;
  weekly: OpenCodeGoWindow | null;
  monthly: OpenCodeGoWindow | null;
}

/** Normalized usage result shared by the dashboard fetch and the usage API. */
export interface OpenCodeGoUsageResult {
  rolling: OpenCodeGoWindow | null;
  weekly: OpenCodeGoWindow | null;
  monthly: OpenCodeGoWindow | null;
  /** Short error label; "auth-expired" when the workspace URL check failed. */
  error?: string;
}

/** Raw shape of the official usage API response. */
export interface OpenCodeGoApiWindow {
  status?: string;
  percent?: number;
  resetsAt?: string;
}

export interface OpenCodeGoApiResponse {
  usage?: {
    rolling?: OpenCodeGoApiWindow;
    weekly?: OpenCodeGoApiWindow;
    monthly?: OpenCodeGoApiWindow;
  };
}
