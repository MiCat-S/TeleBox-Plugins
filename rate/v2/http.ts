import type {PluginContext} from "telebox/sdk";

export class RateFailure extends Error {}

const maxBytes = 128 * 1024;
type Result = {kind: "data"; data: unknown} | {kind: "invalid"} | {kind: "status"; status: number};

async function consume(response: Response, signal: AbortSignal): Promise<Result> {
  if (!response.ok) return {kind: "status", status: response.status};
  if (!response.body) return {kind: "invalid"};
  const reader = response.body.getReader();
  // A fixed buffer also bounds memory for adversarial one-byte stream chunks.
  const bytes = new Uint8Array(maxBytes);
  let total = 0, done = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel();
  const onAbort = () => { void cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { done = true; break; }
      if (chunk.value.byteLength > maxBytes - total) return {kind: "invalid"};
      bytes.set(chunk.value, total);
      total += chunk.value.byteLength;
    }
    try {
      return {kind: "data", data: JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, total)))};
    } catch {
      return {kind: "invalid"};
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { if (!done) await cancel(); } finally { reader.releaseLock(); }
  }
}

export function reason(error: unknown): string {
  if (error instanceof RateFailure) return error.message;
  const property = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
  const code = property && "value" in property ? property.value : undefined;
  if (code === "TIMEOUT") return "请求超时，请稍后重试";
  if (code === "DNS_FAILED" || code === "CONNECTION_REFUSED") return "服务不可达，请检查网络设置";
  return "网络请求失败，请稍后重试";
}

export async function request(context: PluginContext, url: string, timeoutMs: number): Promise<unknown> {
  context.signal.throwIfAborted();
  let result: Result;
  try {
    result = await context.http.withResponse(url, {method: "GET", redirect: "manual", credentials: "omit"}, consume,
      {signal: context.signal, timeoutMs});
  } catch (error) {
    context.signal.throwIfAborted();
    throw new RateFailure(reason(error));
  }
  context.signal.throwIfAborted();
  if (result.kind === "status") {
    throw new RateFailure(result.status === 429 ? "API请求过于频繁，请等待几分钟后再试" : `汇率服务 HTTP ${result.status}`);
  }
  if (result.kind === "invalid") throw new RateFailure("汇率服务返回的数据格式或大小无效");
  return result.data;
}
