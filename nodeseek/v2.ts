import {setTimeout as sleep} from "node:timers/promises";
import {definePlugin, type PluginContext} from "telebox/sdk";
import {curlCffi, probeCurlCffi, validatePythonPath} from "./v2/curl-cffi";

type Data = Record<string, unknown> & {
  cookie: string;
  autoEnabled: boolean;
  lastDoneDate: string;
  lastResult: string;
};
type Status = "success" | "already" | "invalid" | "fail" | "error";
type Result = {result: Status; msg: string; diag?: string};
const defaults: Data = {cookie: "", autoEnabled: false, lastDoneDate: "", lastResult: ""};
const titles: Record<Status, string> = {
  success: "签到成功", already: "今日已签到", invalid: "Cookie 已失效", fail: "签到失败", error: "请求出错",
};
const icons: Record<Status, string> = {success: "🍗", already: "✅", invalid: "⚠️", fail: "❌", error: "⚠️"};
const headers = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  origin: "https://www.nodeseek.com", referer: "https://www.nodeseek.com/board", "Content-Type": "application/json",
};
const help = `🍗 <b>NodeSeek 自动签到</b>

<b>用法：</b>
• <code>.nodeseek set &lt;cookie&gt;</code> 设置/更新登录 Cookie
• <code>.nodeseek now</code> 立即手动签到一次
• <code>.nodeseek status</code> 查看 Cookie 与签到状态
• <code>.nodeseek auto on</code> 开启每日自动签到（8:00~8:59 随机一次）
• <code>.nodeseek auto off</code> 关闭每日自动签到
• <code>.nodeseek help</code> 显示本帮助

<b>获取 Cookie：</b>
浏览器登录 nodeseek.com 后按 F12 打开开发者工具 → Network → 刷新页面 → 任意请求的 Request Headers 中复制完整 Cookie 字段值。

Cookie 保存在本机 assets/nodeseek/data.json。登录失效后请重新设置 Cookie。遇到 Cloudflare/WAF 挑战时使用已有 Python 的 curl_cffi 浏览器指纹回退；可在面板配置 Python 绝对路径，留空时优先使用插件数据目录的旧 venv，其次从本地 PATH 查找。`;

const escape = (text: string): string => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function redact(text: string, cookie: string, limit = 500): string {
  // Redact before truncation, including individual cookie values echoed by an upstream.
  const secrets = [cookie, ...cookie.split(";").map(part => {
    const separator = part.indexOf("=");
    return separator < 0 ? "" : part.slice(separator + 1).trim();
  })].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  // Repair unpaired JSON surrogates and never split an astral character at the limit.
  // Node 24 provides this API; the shared SDK's ES2022 lib predates its declaration.
  text = (text as string & {toWellFormed(): string}).toWellFormed();
  const end = text.charCodeAt(limit - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? limit - 1 : limit);
}

function waf(server: string, body: string): boolean {
  return /cloudflare/i.test(server) ||
    /cf-browser-verification|just a moment|attention required|checking your browser|sorry, you have been blocked/i.test(body);
}

function classify(status: number, server: string, body: string, cookie: string, transport: string, fallbackFailed: boolean): Result {
  let data: unknown;
  let parsed = true;
  try { data = JSON.parse(body); } catch { parsed = false; }
  const payload = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const code = payload.code ?? payload.retcode ?? payload.status;
  const rawMessage = payload.message || payload.msg || payload.reason || "";
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const msg = redact(message, cookie);
  // Business JSON takes precedence: NodeSeek also returns already-done results over HTTP 500.
  if (/未登录|登录已过期|请先登录|not.*login|unauthorized|invalid.*cookie|cookie/i.test(message) ||
      code === 401 || code === 4001 || code === 1001) {
    return {result: "invalid", msg: msg || "Cookie 已失效，请重新获取"};
  }
  if (payload.success === true || payload.code === 1 || payload.retcode === 1 || /鸡腿|签到成功|成功签到/.test(message)) {
    return {result: "success", msg: msg || "签到成功"};
  }
  if (/已完成签到|已签到|今天已签到|已经签到/.test(message) || code === 0) {
    return {result: "already", msg: msg || "今日已签到"};
  }
  const challenge = waf(server, body);
  // Raw response snippets can contain credentials unrelated to the configured cookie.
  const diag = `transport=${transport} | HTTP ${status} | JSON=${parsed} | WAF=${challenge}${fallbackFailed ? " | fallback=失败，请检查 Python/curl_cffi 配置" : ""}`;
  if (status !== 200) return {
    result: status === 401 ? "invalid" : challenge ? "fail" : "error",
    msg: status === 401 ? "Cookie 已失效，请重新获取" :
      `HTTP ${status}${challenge ? "（疑似被 Cloudflare/WAF 拦截，并非 Cookie 失效）" : ""}`,
    diag,
  };
  if (!parsed) return {result: "error", msg: challenge ?
    "请求被 Cloudflare/WAF 拦截，稍后重试" : "响应格式异常，无法解析", diag};
  return {result: "fail", msg: msg || `签到失败（业务码 ${typeof code === "number" ? code : "未知"}）`, diag};
}

async function consume(response: Response, signal: AbortSignal): Promise<{status: number; server: string; body: string}> {
  const result = {status: response.status, server: response.headers.get("server") || "", body: ""};
  if (!response.body) return result;
  const reader = response.body.getReader();
  // Fixed storage bounds retained memory even for adversarial one-byte chunks.
  const buffer = new Uint8Array(64 * 1024);
  let bytes = 0, done = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel();
  // The observer prevents an unhandled rejection; finally awaits the same cancellation.
  const onAbort = () => { void cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { done = true; break; }
      if (chunk.value.byteLength > buffer.length - bytes) throw new Error("NodeSeek response exceeds byte limit");
      buffer.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    result.body = new TextDecoder().decode(buffer.subarray(0, bytes));
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { if (!done || cancellation) await cancel(); } finally { reader.releaseLock(); }
  }
}

function wait(ctx: PluginContext, ms: number, signal: AbortSignal): Promise<void> {
  return ctx.tasks.run("nodeseek:wait", scoped => sleep(ms, undefined, {signal: AbortSignal.any([scoped, signal])}));
}

async function sign(ctx: PluginContext, cookie: string, random: boolean, signal: AbortSignal): Promise<Result> {
  let info: Result = {result: "error", msg: "网络请求出错"};
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const url = `https://www.nodeseek.com/api/attendance?random=${random}`;
      let response = await ctx.http.withResponse(
        url,
        {method: "POST", body: "{}", redirect: "manual", credentials: "omit", headers: {...headers, Cookie: cookie}},
        consume, {signal, timeoutMs: 15000},
      );
      signal.throwIfAborted();
      let transport = "scoped-http", fallbackFailed = false;
      if ((response.status !== 200 && waf(response.server, response.body)) || waf("", response.body)) {
        try {
          response = await curlCffi(ctx, url, {...headers, Cookie: cookie}, signal);
          transport = "curl_cffi";
        } catch {
          signal.throwIfAborted();
          fallbackFailed = true;
          ctx.log.error("nodeseek.fallback.failed", {attempt: attempt + 1});
        }
      }
      info = classify(response.status, response.server, response.body, cookie, transport, fallbackFailed);
    } catch (error) {
      signal.throwIfAborted();
      const timeout = error instanceof Error && "code" in error && error.code === "TIMEOUT";
      ctx.log.error("nodeseek.request.failed", {attempt: attempt + 1, timeout});
      info = {result: "error", msg: timeout ? "网络请求超时，请稍后重试" : "网络请求出错，请稍后重试"};
    }
    if (info.result !== "fail" && info.result !== "error") return info;
    if (attempt < 2) await wait(ctx, 3000, signal);
  }
  return info;
}

function store(ctx: PluginContext) { return ctx.storage.json<Data>("data.json", defaults); }

async function persist(ctx: PluginContext, cookie: string, info: Result, signal: AbortSignal): Promise<void> {
  await store(ctx).update(data => {
    // A cookie replaced while HTTP was in flight owns its own completion history.
    if (data.cookie !== cookie) return data;
    data.lastResult = info.msg;
    if (info.result !== "fail" && info.result !== "error") data.lastDoneDate = today();
    return data;
  }, signal);
}

/** signRandom keeps the original source-selected reward mode; default is random rewards. */
export default function createNodeSeek({signRandom = true}: {signRandom?: boolean} = {}) {
  let signing = false;
  let dailyRunning = false;
  return definePlugin({
    apiVersion: 1, id: "nodeseek", description: "NodeSeek 论坛每日签到，领取鸡腿",
    commands: {nodeseek: {description: "NodeSeek 签到、Cookie 与自动签到设置", async handle({message, args}, ctx) {
      const edit = (text: string, html = false) => {
        ctx.signal.throwIfAborted();
        return ctx.telegram.edit(message, text, html ? {parseMode: "html"} : {});
      };
      try {
        ctx.signal.throwIfAborted();
        const sub = (args[0] || "").toLowerCase();
        if (!sub || sub === "help" || !["set", "now", "status", "auto"].includes(sub)) {
          await edit(help, true); return;
        }
        if (sub === "set") {
          const cookie = args.slice(1).join(" ");
          if (cookie.length < 20) {
            await edit("❌ 请提供有效的 Cookie，例如：\n<code>.nodeseek set ns_xxx=xxx; other=xxx</code>", true); return;
          }
          await store(ctx).update(data => ({...data, cookie, lastDoneDate: ""}), ctx.signal);
          await edit("🍪 Cookie 已保存，可以用 <code>.nodeseek now</code> 测试签到了", true);
          return;
        }
        if (sub === "auto") {
          const mode = (args[1] || "").toLowerCase();
          if (mode !== "on" && mode !== "off") {
            await edit("用法：<code>.nodeseek auto on</code> 或 <code>.nodeseek auto off</code>", true); return;
          }
          await store(ctx).update(data => ({...data, autoEnabled: mode === "on"}), ctx.signal);
          await edit(mode === "on" ? "✅ 已开启每日自动签到" : "⏹️ 已关闭每日自动签到"); return;
        }
        const data = await store(ctx).read(ctx.signal);
        if (sub === "status") {
          const fallback = await probeCurlCffi(ctx, ctx.signal);
          await edit([
            `🍪 Cookie：${data.cookie ? "已设置" : "未设置"}`,
            `⏰ 自动签到：${data.autoEnabled ? "已开启（每天 8:00~8:59 随机一次）" : "未开启"}`,
            `📅 今日是否已处理：${data.lastDoneDate === today() ? "是" : "否"}`,
            `📝 最近一次结果：${redact(data.lastResult || "无", data.cookie || "")}`,
            `🛡️ Cloudflare fallback：${fallback}`,
          ].join("\n")); return;
        }
        if (!data.cookie) {
          await edit("⚠️ 还没有设置 Cookie，先用 <code>.nodeseek set &lt;cookie&gt;</code> 设置", true); return;
        }
        if (signing) { await edit("⏳ 正在签到，请等待当前签到完成"); return; }
        signing = true;
        try {
          await edit("⏳ 正在签到…");
          const info = await sign(ctx, data.cookie, signRandom, ctx.signal);
          await persist(ctx, data.cookie, info, ctx.signal);
          await edit(`${icons[info.result]} <b>${titles[info.result]}</b>\n${escape(info.msg)}${info.diag ? `\n\n<code>${escape(info.diag)}</code>` : ""}`, true);
        } finally { signing = false; }
      } catch {
        ctx.signal.throwIfAborted();
        ctx.log.error("nodeseek.command.failed");
        try { await edit("❌ 出错了：NodeSeek 操作失败，请检查配置或稍后重试"); }
        catch {
          ctx.signal.throwIfAborted();
          throw new Error("NodeSeek message delivery failed");
        }
      }
    }}},
    jobs: {nodeseek_daily_checkin: {
      cron: "0 8 * * *", description: "NodeSeek 每日自动签到（8:00~8:59 内随机执行一次）",
      async handle(ctx, callerSignal) {
        const signal = AbortSignal.any([ctx.signal, callerSignal]);
        signal.throwIfAborted();
        if (dailyRunning) return;
        dailyRunning = true;
        try {
          let data = await store(ctx).read(signal);
          if (!data.autoEnabled || !data.cookie || data.lastDoneDate === today()) return;
          await wait(ctx, Math.floor(Math.random() * 59 * 60 * 1000), signal);
          data = await store(ctx).read(signal);
          if (!data.autoEnabled || !data.cookie || data.lastDoneDate === today() || signing) return;
          signing = true;
          try {
            const info = await sign(ctx, data.cookie, signRandom, signal);
            await persist(ctx, data.cookie, info, signal);
            signal.throwIfAborted();
            await ctx.telegram.withClient(async (client, transportSignal) => {
              signal.throwIfAborted();
              transportSignal.throwIfAborted();
              await client.sendMessage("me", {message: `${icons[info.result]} NodeSeek ${titles[info.result]}\n${info.msg}`, parseMode: false});
            });
          } finally { signing = false; }
        } finally { dailyRunning = false; }
      },
    }},
    settings: ctx => ({
      id: "nodeseek", title: "NodeSeek 通知", description: "NodeSeek 论坛通知配置", category: "插件配置", icon: "📢",
      getSchema: () => [
        {key: "cookie", label: "Cookie", type: "password", secret: true, description: "NodeSeek 论坛登录 Cookie"},
        {key: "chatId", label: "推送 Chat ID", type: "string", description: "推送通知的目标 Chat ID"},
        {key: "interval", label: "检查间隔 (分钟)", type: "number", min: 1, max: 1440, default: 5, description: "论坛通知检查间隔"},
        {key: "maxItems", label: "最大推送条数", type: "number", min: 1, max: 20, default: 5, description: "单次推送的最大通知条数"},
        {key: "pythonPath", label: "Python 绝对路径", type: "string", description: "已有 curl_cffi 的 Python；留空时优先旧 venv，其次本地 PATH"},
      ],
      getValues: signal => ctx.storage.json("config.json", {}).read(signal),
      setValues: async (patch, signal) => {
        if (patch.pythonPath !== undefined) validatePythonPath(patch.pythonPath);
        await ctx.storage.json("config.json", {}).update(data => ({...data, ...patch}), signal);
      },
    }),
  });
}
