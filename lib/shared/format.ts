export function clampPercent(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

export function formatResetTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem > 0 ? `${days}d${rem}h` : `${days}d`;
}

export function formatResetSeconds(seconds: number | undefined): string | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  return formatResetTime(new Date(Date.now() + Math.max(0, seconds!) * 1000));
}

export function safeError(error: unknown): string {
  if (error instanceof Error && /^HTTP \d+$/.test(error.message)) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  return "unavailable";
}
