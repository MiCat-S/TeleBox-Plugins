import {isIP} from "node:net";
import {domainToASCII} from "node:url";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

const help = `📍 <b>IP查询插件</b>

<b>使用方法：</b>
• <code>ip &lt;IP地址&gt;</code>
• <code>ip &lt;域名&gt;</code>
• 回复包含IP/域名的消息后使用 <code>ip</code>

<b>示例：</b>
• <code>ip 8.8.8.8</code>
• <code>ip google.com</code>
• <code>ip 2001:4860:4860::8888</code>`;

const description = `
IP 查询插件：
- ip &lt;IP地址/域名&gt; - 查询 IP 地址或域名的详细信息
- 也可回复包含 IP/域名 的消息后使用 ip 命令

示例：
1. ip 8.8.8.8
2. ip google.com
3. 回复包含 IP 的消息后使用 ip
  `;

const fields = "status,message,country,regionName,city,isp,org,as,query,timezone,proxy,hosting";
const maxResponseBytes = 64 * 1024;
const escape = (text: string): string => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;",
})[character]!);

function target(query: string): string | undefined {
  if (query.length > 254 || /[\s@/\\?#%\[\]]/.test(query)) return;
  if (isIP(query)) return query;
  if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(query)) return;
  const ascii = domainToASCII(query);
  const name = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  const labels = name.split(".");
  if (!name || name.length > 253 || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      !/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(labels.at(-1)!)) return;
  return ascii;
}

function fromReply(text: string): string {
  const clean = text.trim();
  const ipv4 = clean.match(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/);
  // Unicode-aware boundaries prevent taking an ASCII suffix of an IDN label.
  const domain = clean.match(/(?<![\p{L}\p{M}\p{N}.-])(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?![\p{L}\p{M}\p{N}-])/u);
  return ipv4?.[0] ?? domain?.[0] ?? clean.split(/\s+/)[0];
}

function displayTarget(query: string): string {
  // Credential-bearing URLs are not query targets and must not be echoed into an edit.
  if (/[@?#]|:\/\//.test(query)) return "无效输入";
  return Array.from(query).slice(0, 254).join("") + (query.length > 254 ? "..." : "");
}

function failure(query: string, reason: string): string {
  return `❌ <b>查询失败</b>

<b>查询目标:</b> <code>${escape(displayTarget(query))}</code>
<b>失败原因:</b> ${escape(reason)}

💡 <b>建议:</b>
• 检查IP地址或域名格式
• 稍后重试查询`;
}

function parseFailure(query: string): string {
  return `❌ <b>数据解析失败</b>

<b>查询目标:</b> <code>${escape(displayTarget(query))}</code>
<b>错误原因:</b> API返回了非预期的数据格式

💡 <b>建议:</b> 请稍后重试或联系管理员`;
}

type ApiResult = {kind: "data"; value: unknown} | {kind: "invalid"} | {kind: "http"; status: number};

async function consume(response: Response, signal: AbortSignal): Promise<ApiResult> {
  if (response.status !== 200) return {kind: "http", status: response.status};
  if (!response.body) return {kind: "invalid"};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
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
      total += chunk.value.byteLength;
      if (total > maxResponseBytes) return {kind: "invalid"};
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
    try {
      return {kind: "data", value: JSON.parse(Buffer.concat(chunks, total).toString("utf8"))};
    } catch {
      return {kind: "invalid"};
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { if (!done) await cancel(); } finally { reader.releaseLock(); }
  }
}

function format(query: string, result: ApiResult): {text: string; linkPreview?: boolean} {
  const invalid = () => ({text: parseFailure(query)});
  if (result.kind === "http") return {text: failure(query, `API请求失败，HTTP状态码: ${result.status}`)};
  if (result.kind === "invalid") return invalid();
  const data = result.value;
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalid();
  const record = data as Record<string, unknown>;
  if (record.status === "fail") {
    if (record.message != null && typeof record.message !== "string") return invalid();
    const message = record.message || "查询失败，请检查IP地址或域名是否正确";
    const output = failure(query, message as string);
    return output.length <= 4000 ? {text: output} : invalid();
  }
  if (record.status !== "success") return invalid();
  const textFields = ["country", "regionName", "city", "isp", "org", "as", "query", "timezone"] as const;
  if (textFields.some(field => record[field] != null && typeof record[field] !== "string") ||
      ["proxy", "hosting"].some(field => record[field] != null && typeof record[field] !== "boolean")) {
    return invalid();
  }
  const value = (field: typeof textFields[number]) => record[field] as string || "N/A";
  let output = "";
  if (record.proxy) output += "此 IP 可能为代理 IP\n";
  if (record.hosting) output += "此 IP 可能为数据中心 IP\n";
  if (output) output += "\n";
  output += `🌍 <b>IP/域名查询结果</b>

<b>🔍 查询目标:</b> <code>${escape(value("query"))}</code>
<b>📍 地理位置:</b> ${escape(value("country"))} - ${escape(value("regionName"))} - ${escape(value("city"))}
<b>🏢 ISP:</b> ${escape(value("isp"))}
<b>🏦 组织:</b> ${escape(value("org"))}
<b>🔢 AS号:</b> <code>${escape(value("as"))}</code>`;
  if (record.timezone) output += `\n<b>⏰ 时区:</b> ${escape(value("timezone"))}`;
  const asNumber = value("as").match(/^AS(\d+)/)?.[1];
  if (asNumber) output += `\n\nhttps://bgp.he.net/AS${asNumber}`;
  return output.length <= 4000 ? {text: output, linkPreview: true} : invalid();
}

async function edit(context: PluginContext, message: MessageEnvelope, text: string, linkPreview?: boolean): Promise<void> {
  context.signal.throwIfAborted();
  await context.telegram.edit(message, text, {parseMode: "html", ...(linkPreview === undefined ? {} : {linkPreview})});
}

export default function createIp() {
  return definePlugin({
    apiVersion: 1, id: "ip", description,
    commands: {
      ip: {description: "查询 IP 地址或域名的详细信息", async handle({message, args}, context) {
        try {
          context.signal.throwIfAborted();
          let query = args.join(" ").trim();
          if (!query) {
            try {
              const reply = await context.telegram.getReply(message);
              context.signal.throwIfAborted();
              if (reply?.text) query = fromReply(reply.text);
            } catch {
              if (context.signal.aborted) return;
              context.log.error("ip.reply.failed");
            }
          }
          if (!query) { await edit(context, message, help); return; }
          const clean = target(query);
          if (!clean) { await edit(context, message, failure(query, "请提供有效的IP地址或域名")); return; }
          await edit(context, message, `🔍 <b>正在查询:</b> <code>${escape(query)}</code>`);
          let result: ApiResult;
          try {
            result = await context.http.withResponse(
              `http://ip-api.com/json/${encodeURIComponent(clean)}?lang=zh-CN&fields=${fields}`,
              {method: "GET", redirect: "manual", credentials: "omit", headers: {"User-Agent": "TeleBox-IP-Plugin/1.0"}},
              consume, {signal: context.signal, timeoutMs: 15000},
            );
          } catch (error) {
            if (context.signal.aborted) return;
            const code = error instanceof Error && "code" in error ? error.code : undefined;
            const reason = code === "TIMEOUT" ? "请求超时，请稍后重试"
              : code === "DNS_FAILED" ? "DNS解析失败，请检查网络连接"
              : code === "CONNECTION_REFUSED" ? "连接被拒绝，请稍后重试" : "网络请求失败";
            context.log.error("ip.request.failed", {timeout: code === "TIMEOUT"});
            await edit(context, message, failure(query, reason));
            return;
          }
          context.signal.throwIfAborted();
          const output = format(query, result);
          await edit(context, message, output.text, output.linkPreview);
        } catch {
          if (context.signal.aborted) return;
          context.log.error("ip.command.failed");
          try {
            await edit(context, message, `❌ <b>IP查询失败</b>

<b>错误信息:</b> 消息处理失败，请稍后重试

💡 <b>建议:</b>
• 检查网络连接
• 稍后重试查询
• 确认IP地址或域名格式正确`);
          } catch {
            if (!context.signal.aborted) context.log.error("ip.message.failed");
          }
        }
      }},
    },
  });
}
