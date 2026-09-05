import {definePlugin} from "telebox/sdk";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const help = `📘 <b>AI 翻译</b>

• <code>gt [文本]</code> - 翻译为简体中文
• <code>gt en [文本]</code> - 翻译为英文
• 回复消息后使用 <code>gt</code> 或 <code>gt en</code>
• <code>gt help</code> - 查看帮助

使用 ai 插件当前聊天 API、模型及超时设置。
请先安装配套 ai 插件，并通过 <code>ai config add</code> 和 <code>ai model chat</code> 配置。
待翻译文本会发送至该 API，可能产生模型调用费用。`;

function* chunks(text: string): Generator<string> {
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 3000) { yield chunk; chunk = ""; }
    chunk += character;
  }
  if (chunk) yield chunk;
}

export default function createGt() {
  return definePlugin({
    apiVersion: 1, id: "gt", description: help,
    commands: {
      gt: {description: "AI 翻译", async handle({message}, context) {
        try {
          let text = message.text.replace(/^\S+\s*/, "");
          const first = text.match(/^\S+/)?.[0].toLowerCase();
          if (first === "help" || first === "h") {
            await context.telegram.edit(message, help, {parseMode: "html"});
            return;
          }
          const target = first === "en" ? "en" : "zh-CN";
          if (target === "en") text = text.replace(/^\S+\s*/, "");
          if (!text.trim()) text = (await context.telegram.getReply(message))?.text ?? "";
          if (!text.trim()) {
            await context.telegram.edit(message, "❌ 请提供要翻译的文本或回复一条文字消息");
            return;
          }
          if (text.length > 5000) {
            await context.telegram.edit(message, "❌ 文本过长，请保持在5000字符以内");
            return;
          }
          if (!context.services.available("ai", "translate")) {
            await context.telegram.edit(message, "❌ 请先安装或更新配套 ai 插件，并配置 ai model chat");
            return;
          }
          await context.telegram.edit(message, "🔄 <b>AI 翻译中...</b>", {parseMode: "html"});
          const translated = await context.services.call<unknown>("ai", "translate", {text, target}, context.signal);
          context.signal.throwIfAborted();
          if (typeof translated !== "string" || !translated.trim()) throw new Error("Invalid translation result");
          const preview = Array.from(text).slice(0, 50).join("");
          let firstChunk = true;
          for (const chunk of chunks(translated)) {
            context.signal.throwIfAborted();
            if (firstChunk) {
              await context.telegram.edit(message,
                `🌐 <b>AI 翻译结果</b> (→ ${target === "en" ? "英文" : "中文"})\n\n` +
                `<b>原文:</b>\n<code>${escape(preview)}${preview.length < text.length ? "..." : ""}</code>\n\n` +
                `<b>译文:</b>\n${escape(chunk)}`, {parseMode: "html"});
              firstChunk = false;
            } else {
              await context.telegram.reply(message, escape(chunk), {parseMode: "html"});
            }
          }
        } catch {
          if (!context.signal.aborted) await context.telegram.edit(message,
            "❌ AI 翻译失败，请检查 ai 聊天配置、API 可用性及超时设置后重试");
        }
      }},
    },
  });
}
