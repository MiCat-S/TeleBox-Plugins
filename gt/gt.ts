import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPluginEntry } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { htmlEscape } from "@utils/htmlEscape";

interface TranslationProvider {
  translateText(
    text: string,
    target: "zh-CN" | "en",
    signal: AbortSignal,
  ): Promise<string>;
}

const help = `📘 <b>AI 翻译</b>

• <code>gt [文本]</code> - 翻译为简体中文
• <code>gt en [文本]</code> - 翻译为英文
• 回复消息后使用 <code>gt</code> 或 <code>gt en</code>
• <code>gt help</code> - 查看帮助

使用 ai 插件当前聊天 API、模型及超时设置。
请先安装配套 ai 插件，并通过 <code>ai config add</code> 和 <code>ai model chat</code> 配置。
待翻译文本会发送至该 API，可能产生模型调用费用。`;

class GtPlugin extends Plugin {
  description = help;
  private activeRequests = new Set<AbortController>();
  private stopped = false;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    gt: async (msg) => {
      let controller: AbortController | undefined;
      try {
        let text = msg.message.replace(/^\S+\s*/, "");
        const first = text.match(/^\S+/)?.[0].toLowerCase();
        if (first === "h" || first === "help") {
          await msg.edit({ text: help, parseMode: "html" });
          return;
        }

        const target = first === "en" ? "en" : "zh-CN";
        if (target === "en") text = text.replace(/^\S+\s*/, "");
        if (!text.trim()) {
          const reply = await safeGetReplyMessage(msg);
          text = reply?.text || "";
        }
        if (!text.trim()) {
          await msg.edit({
            text: "❌ 请提供要翻译的文本或回复一条文字消息",
            parseMode: "html",
          });
          return;
        }
        if (text.length > 5000) {
          await msg.edit({
            text: "❌ 文本过长，请保持在5000字符以内",
            parseMode: "html",
          });
          return;
        }
        if (this.stopped) return;

        const ai = getPluginEntry("ai")?.plugin as
          | (Plugin & Partial<TranslationProvider>)
          | undefined;
        if (typeof ai?.translateText !== "function") {
          await msg.edit({
            text: "❌ 请先安装或更新配套 ai 插件，并配置 ai model chat",
            parseMode: "html",
          });
          return;
        }

        controller = new AbortController();
        this.activeRequests.add(controller);
        await msg.edit({ text: "🔄 <b>AI 翻译中...</b>", parseMode: "html" });
        const translated = await ai.translateText(text, target, controller.signal);
        if (controller.signal.aborted) return;
        if (!translated.trim()) throw new Error("AI 翻译结果为空");

        // Split before HTML escaping and preserve surrogate pairs.
        const chunks: string[] = [];
        let chunk = "";
        for (const character of translated) {
          if (chunk.length + character.length > 3000) {
            chunks.push(chunk);
            chunk = "";
          }
          chunk += character;
        }
        if (chunk) chunks.push(chunk);

        const language = target === "en" ? "英文" : "中文";
        const preview = Array.from(text).slice(0, 50).join("");
        await msg.edit({
          text: `🌐 <b>AI 翻译结果</b> (→ ${language})\n\n` +
            `<b>原文:</b>\n<code>${htmlEscape(preview)}${preview.length < text.length ? "..." : ""}</code>\n\n` +
            `<b>译文:</b>\n${htmlEscape(chunks[0])}`,
          parseMode: "html",
        });
        for (const remaining of chunks.slice(1)) {
          if (controller.signal.aborted) return;
          await msg.reply({ message: htmlEscape(remaining), parseMode: "html" });
        }
      } catch {
        if (!this.stopped && !controller?.signal.aborted) {
          // Provider errors may contain credentials or source text.
          await msg.edit({
            text: "❌ AI 翻译失败，请检查 ai 聊天配置、API 可用性及超时设置后重试",
            parseMode: "html",
          });
        }
      } finally {
        if (controller) this.activeRequests.delete(controller);
      }
    },
  };

  cleanup(): void {
    this.stopped = true;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }
}

export default new GtPlugin();
