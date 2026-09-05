import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {FIAT_CURRENCIES, CRYPTO_CURRENCIES} from "./v2/currencies";
import {RateFailure, reason, request} from "./v2/http";

const help = `🚀 <b>智能汇率查询助手</b>

📊 <b>使用示例</b>
• <code>rate BTC</code> - 比特币美元价
• <code>rate ETH CNY</code> - 以太坊人民币价
• <code>rate CNY TRY</code> - 人民币兑土耳其里拉
• <code>rate BTC CNY 0.5</code> - 0.5个BTC换算
• <code>rate CNY USDT 7000</code> - 7000元换USDT`;

type Currency = {symbol: string; type: "fiat" | "crypto"};
type Rates = Record<string, number>;
const bridges = ["USDT", "BUSD", "USDC"] as const;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;",
})[char]!);
const code = (text: string) => `<code>${escape(text)}</code>`;
const validCode = (text: string) => /^[a-z][a-z0-9-]{0,63}$/i.test(text);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const positive = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RateFailure("汇率服务返回了无效价格");
  return value;
};

function normalize(token: string): string {
  const key = token.toLowerCase();
  if (key === "rm") return "myr";
  for (const table of [FIAT_CURRENCIES, CRYPTO_CURRENCIES]) {
    for (const [currency, info] of Object.entries(table)) if (info.aliases?.includes(key)) return currency;
  }
  return key;
}

function parse(args: readonly string[]): {base: string; quote: string; amount: number} {
  if (args.length > 32) throw new RateFailure("参数过多，请使用货币代码和有限数量");
  const currencies: string[] = [];
  let amount = 1;
  for (const arg of args) {
    // Reject credentials, HTML and malformed UTF-16 locally, before echoing or constructing URLs.
    if (arg.length > 64 || !/^[a-z0-9.+-]+$/i.test(arg)) throw new RateFailure("请提供有效的货币代码和有限数量");
    const token = normalize(arg);
    const number = parseFloat(token);
    if (Number.isFinite(number)) amount = number;
    else if (validCode(token) && !/^(?:nan|infinity)$/i.test(token)) currencies.push(token);
    else throw new RateFailure("请提供有效的货币代码和有限数量");
  }
  return {base: currencies[0] || "btc", quote: currencies[1] || "usd", amount};
}

function boundedSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function formatAmount(value: number): string {
  return value >= 1 ? value.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}) : value.toFixed(6);
}

function formatPrice(value: number): string {
  if (value >= 1) return formatAmount(value);
  if (value >= 0.01) return value.toFixed(4);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toExponential(2);
}

async function edit(context: PluginContext, message: MessageEnvelope, text: string): Promise<void> {
  context.signal.throwIfAborted();
  if (text.length > 4000 || /[\uD800-\uDFFF]/u.test(text)) throw new RateFailure("消息内容超出显示范围");
  await context.telegram.edit(message, text, {parseMode: "html", linkPreview: false});
  context.signal.throwIfAborted();
}

export default function createRate() {
  const fiatCache = new Map<string, {rates: Rates; ts: number}>();
  let dynamicFiats: {codes: Set<string>; ts: number} | undefined;
  let active = 0;

  async function isFiat(query: string, context: PluginContext, get: typeof request): Promise<boolean> {
    const now = Date.now();
    if (dynamicFiats && now - dynamicFiats.ts < 6 * 60 * 60 * 1000) return dynamicFiats.codes.has(query);
    const endpoints = [
      "https://api.coingecko.com/api/v3/simple/supported_vs_currencies",
      "https://api.exchangerate.host/symbols",
      "https://api.frankfurter.app/currencies",
    ];
    for (const [index, url] of endpoints.entries()) {
      try {
        const data = await get(context, url, 8000);
        const object = record(data);
        const source = index === 0 ? data : index === 1 ? record(object?.symbols) : object;
        const keys = index === 0 ? source : source ? Object.keys(source) : undefined;
        if (!Array.isArray(keys) || keys.length === 0 || keys.length > 1024 ||
            keys.some(key => typeof key !== "string" || !validCode(key))) throw new RateFailure("货币列表格式无效");
        dynamicFiats = {codes: new Set(keys.map(key => key.toLowerCase())), ts: Date.now()};
        return dynamicFiats.codes.has(query);
      } catch {
        context.signal.throwIfAborted();
      }
    }
    // Built-in currencies were already resolved before this dynamic fallback.
    dynamicFiats = {codes: new Set(Object.keys(FIAT_CURRENCIES)), ts: Date.now()};
    return dynamicFiats.codes.has(query);
  }

  async function currency(query: string, context: PluginContext, get: typeof request): Promise<Currency> {
    for (const [type, table] of [["fiat", FIAT_CURRENCIES], ["crypto", CRYPTO_CURRENCIES]] as const) {
      if (Object.hasOwn(table, query)) return {symbol: table[query].symbol, type};
    }
    return {symbol: query.toUpperCase(), type: await isFiat(query, context, get) ? "fiat" : "crypto"};
  }

  async function fiatRates(base: string, context: PluginContext, get: typeof request): Promise<Rates> {
    const key = base.toLowerCase();
    const cached = fiatCache.get(key);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.rates;
    const endpoints = [
      `https://api.exchangerate.host/latest?base=${encodeURIComponent(key)}`,
      `https://open.er-api.com/v6/latest/${encodeURIComponent(key)}`,
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(key)}`,
      `https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(key.toUpperCase())}`,
      `https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/${encodeURIComponent(key)}.json`,
    ];
    let last = "法币汇率服务不可用";
    for (const url of endpoints) {
      try {
        const data = record(await get(context, url, 8000));
        const source = record(data?.rates) ?? record(record(data?.data)?.rates) ?? record(data?.[key]);
        if (!source || data?.success === false || (data?.result != null && data.result !== "success")) {
          throw new RateFailure("法币汇率数据格式无效");
        }
        const entries = Object.entries(source);
        if (entries.length === 0 || entries.length > 1024) throw new RateFailure("法币汇率数据大小无效");
        const rates: Rates = Object.create(null);
        for (const [name, value] of entries) {
          if (!validCode(name) || (typeof value !== "number" && typeof value !== "string")) continue;
          const number = Number(value);
          if (Number.isFinite(number) && number > 0) rates[name.toLowerCase()] = number;
        }
        if (Object.keys(rates).length === 0) throw new RateFailure("法币汇率数据无有效价格");
        boundedSet(fiatCache, key, {rates, ts: Date.now()}, 16);
        return rates;
      } catch (error) {
        context.signal.throwIfAborted();
        last = reason(error);
      }
    }
    throw new RateFailure(`法币汇率服务不可用：${last}`);
  }

  return definePlugin({
    apiVersion: 1, id: "rate", description: `加密货币汇率查询 & 数量换算\n\n${help}`,
    cleanup() { fiatCache.clear(); dynamicFiats = undefined; },
    commands: {
      rate: {description: "智能汇率查询与数量换算", async handle({message, args}, context) {
        context.signal.throwIfAborted();
        if (active >= 4) {
          try { await edit(context, message, "⏳ 汇率查询繁忙，请稍后重试"); }
          catch { if (!context.signal.aborted) context.log.error("rate.message.failed"); }
          return;
        }
        active++;
        let fallback = "";
        try {
          if (!args[0] || args[0] === "help" || args[0] === "h") { await edit(context, message, help); return; }
          const {base, quote, amount} = parse(args);
          const query = encodeURIComponent(`${amount} ${base.toUpperCase()} to ${quote.toUpperCase()}`);
          fallback = `\n\n🔎 <b>谷歌兜底:</b> <a href="https://www.google.com/search?q=${escape(query)}">点击查看</a>`;
          let requests = 0;
          const get: typeof request = async (ctx, url, timeout) => {
            ctx.signal.throwIfAborted();
            if (++requests > 64) throw new RateFailure("本次查询已达到请求上限，请稍后重试");
            return request(ctx, url, timeout);
          };
          await edit(context, message, "⚡ 正在获取最新汇率数据...");
          await edit(context, message, "🔍 正在识别货币类型...");
          const source = await currency(base, context, get);
          context.signal.throwIfAborted();
          const target = await currency(quote, context, get);
          await edit(context, message, "⏳ 正在获取汇率数据...");
          const tickers = new Map<string, number>();
          async function binance(pair: string): Promise<number> {
            context.signal.throwIfAborted();
            const cached = tickers.get(pair);
            if (cached !== undefined) return cached;
            const data = record(await get(context, `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`, 5000));
            const value = data?.price;
            if (typeof value !== "number" && typeof value !== "string") throw new RateFailure("币安交易对价格无效");
            const price = positive(Number(value));
            tickers.set(pair, price);
            return price;
          }
          async function cryptoFiat(crypto: string, fiat: string): Promise<number> {
            let last = "交易对不可用";
            for (const bridge of bridges) {
              try {
                const price = await binance(`${crypto}${bridge}`);
                const rates = await fiatRates("usd", context, get);
                return positive(price * positive(rates[fiat.toLowerCase()]));
              } catch (error) {
                context.signal.throwIfAborted();
                last = reason(error);
              }
            }
            throw new RateFailure(`无法获取 ${crypto} 对 ${fiat} 的价格。最后错误: ${last}`);
          }
          async function cryptoCrypto(first: string, second: string): Promise<number> {
            try { return await binance(`${first}${second}`); } catch { context.signal.throwIfAborted(); }
            try { return positive(1 / await binance(`${second}${first}`)); } catch { context.signal.throwIfAborted(); }
            for (const bridge of bridges) {
              try { return positive(await binance(`${first}${bridge}`) / await binance(`${second}${bridge}`)); }
              catch { context.signal.throwIfAborted(); }
            }
            throw new RateFailure(`无法找到 ${first} 和 ${second} 之间的交易对`);
          }
          let price: number;
          try {
            if (source.type === "crypto" && target.type === "crypto") price = await cryptoCrypto(source.symbol, target.symbol);
            else if (source.type === "crypto") price = await cryptoFiat(source.symbol, target.symbol);
            else if (target.type === "crypto") {
              try { price = positive(1 / await cryptoFiat(target.symbol, source.symbol)); }
              catch { context.signal.throwIfAborted(); throw new RateFailure(`无法获取 ${target.symbol} 对 ${source.symbol} 的价格来计算反向汇率`); }
            } else {
              const rates = await fiatRates(source.symbol, context, get);
              if (!rates[target.symbol.toLowerCase()]) throw new RateFailure(`无法获取 ${source.symbol} 到 ${target.symbol} 的汇率`);
              price = positive(rates[target.symbol.toLowerCase()]);
            }
          } catch (error) {
            context.signal.throwIfAborted();
            await edit(context, message, `❌ <b>获取价格失败:</b> ${escape(reason(error))}\n\n🔍 <b>调试信息:</b>\n• ${code(source.symbol)} (${source.type})\n• ${code(target.symbol)} (${target.type})${fallback}`);
            return;
          }
          context.signal.throwIfAborted();
          const lastUpdated = new Date().toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"});
          const converted = amount * price;
          if (!Number.isFinite(converted)) throw new RateFailure("换算结果超出有限数值范围");
          let output = "💱 <b>汇率</b>\n\n";
          if (source.type === "crypto" && target.type === "fiat" && amount === 1) {
            output += `${code(`1 ${source.symbol} = ${formatPrice(price)} ${target.symbol}`)}\n\n`;
          } else {
            output += `${code(`${formatAmount(amount)} ${source.symbol} ≈`)}\n${code(`${formatAmount(converted)} ${target.symbol}`)}\n\n`;
            if (source.type === "fiat" && target.type === "fiat") {
              output += `📊 <b>汇率:</b> ${code(`1 ${source.symbol} = ${formatAmount(price)} ${target.symbol}`)}\n`;
            } else if (source.type === "crypto" && target.type === "crypto") {
              let first = 0, second = 0;
              try { first = await cryptoFiat(source.symbol, "USD"); second = await cryptoFiat(target.symbol, "USD"); }
              catch { context.signal.throwIfAborted(); }
              output += `💎 <b>兑换比率:</b> ${code(`1 ${source.symbol} = ${formatAmount(price)} ${target.symbol}`)}\n`;
              output += `📊 <b>基准价格:</b> ${code(`${source.symbol} $${formatPrice(first)} • ${target.symbol} $${formatPrice(second)}`)}\n`;
            } else {
              const reverse = source.type === "fiat";
              output += `💎 <b>当前汇率:</b> ${code(`1 ${reverse ? target.symbol : source.symbol} = ${formatPrice(reverse ? positive(1 / price) : price)} ${reverse ? source.symbol : target.symbol}`)}\n`;
            }
          }
          output += `⏰ <b>${source.type === "fiat" && target.type === "fiat" ? "更新时间" : "数据更新"}:</b> ${lastUpdated}`;
          await edit(context, message, output);
        } catch (error) {
          if (context.signal.aborted) return;
          context.log.error("rate.command.failed");
          const messageText = error instanceof RateFailure ? error.message : "消息处理失败，请稍后重试";
          try { await edit(context, message, `❌ <b>操作失败</b>\n\n${escape(messageText)}${fallback}`); }
          catch { if (!context.signal.aborted) context.log.error("rate.message.failed"); }
        } finally { active--; }
      }},
    },
  });
}
