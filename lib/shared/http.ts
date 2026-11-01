const MAX_JSON_RESPONSE_BYTES = 1_000_000;

export async function readTextLimited(
  response: Response,
  maxBytes: number = MAX_JSON_RESPONSE_BYTES,
): Promise<string> {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("response-too-large");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    if (typeof (response as any).text === "function") {
      return await (response as any).text();
    }
    if (typeof (response as any).json === "function") {
      const obj = await (response as any).json();
      return JSON.stringify(obj);
    }
    return "";
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ response: Response; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow a redirect while an authorization header may be attached.
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readTextLimited(response, MAX_JSON_RESPONSE_BYTES);
    return { response, data: JSON.parse(text) };
  } finally {
    clearTimeout(timer);
  }
}
