import { definePlugin, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import type { Api } from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!);
const code = (value: unknown): string => `<code>${escape(value)}</code>`;
const help = (prefix: string): string => `🆔 <b>用户信息查询插件</b>

<b>使用方式：</b>
• <code>${escape(prefix)}ids</code> - 显示自己的信息
• <code>${escape(prefix)}ids @用户名</code> - 查询指定用户信息
• <code>${escape(prefix)}ids 用户ID</code> - 通过ID查询用户信息
• 回复消息后使用 <code>${escape(prefix)}ids</code> - 查询被回复用户信息

<b>显示信息包括：</b>
• 用户名和显示名称
• 用户ID、注册时间估算、DC
• <b>入群时间</b>（仅群组有效）
• 共同群组数量
• 用户简介
• 三种跳转链接

<b>支持格式：</b>
• @用户名、用户ID、频道ID、回复消息`;

const points: readonly (readonly [number, number])[] = [
  [0, 1376438400], [50000000, 1400000000], [150000000, 1451606400],
  [350000000, 1483228800], [500000000, 1514764800], [900000000, 1559347200],
  [1100000000, 1585699200], [1450000000, 1609459200], [2150000000, 1640995200],
  [5100000000, 1654041600], [5600000000, 1672531200], [6800000000, 1704067200],
  [7800000000, 1735689600], [8500000000, 1767225600],
];

function registration(id: string): string {
  if (id.startsWith("-")) return "频道/群组";
  // Only the historical date estimate uses floating point; RPCs and links keep the exact ID.
  const value = Number(id);
  let lower = points[0], upper = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    if (value >= points[i][0] && value <= points[i + 1][0]) {
      lower = points[i]; upper = points[i + 1]; break;
    }
  }
  const date = new Date((lower[1] + (value - lower[0]) * (upper[1] - lower[1]) / (upper[0] - lower[0])) * 1000);
  return Number.isNaN(date.getTime()) ? "未知" : `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

type Profile = Partial<Pick<Api.User, "id" | "username" | "firstName" | "lastName" | "bot" | "verified" | "premium" | "scam" | "fake">> & {
  first_name?: string; last_name?: string;
};
interface Info {
  id: string; user?: Profile; bio?: string; commonChats: number; dc: string; joinedDate?: string;
}
class InvalidTargetError extends Error {}

function format(info: Info): string {
  const { id, user } = info;
  const first = user?.firstName || user?.first_name;
  const last = user?.lastName || user?.last_name;
  const username = user?.username;
  const name = first ? first + (last ? " " + last : "") : username ? "@" + username : "用户 " + id;
  const status = [user?.bot && "🤖 机器人", user?.verified && "✅ 已验证", user?.premium && "⭐ Premium",
    user?.scam && "⚠️ 诈骗", user?.fake && "❌ 虚假"].filter(Boolean);
  let bio = info.bio || "无简介";
  if (bio.length > 200) {
    const end = /[\uD800-\uDBFF]/.test(bio[199]) ? 199 : 200;
    bio = bio.substring(0, end) + "...";
  }
  const links = [`tg://user?id=${id}`, username ? `https://t.me/${username}` : `https://t.me/@id${id}`, `tg://openmessage?user_id=${id}`];
  return `👤 <b>${escape(name)}</b>\n\n<b>基本信息：</b>\n` +
    `• 用户名：${code(username ? "@" + username : "无用户名")}\n• 用户ID：${code(id)}\n` +
    `• 注册时间（基于ID估算）：${code(registration(id))}\n` +
    (info.joinedDate ? `• 入群时间：${code(info.joinedDate)}\n` : "") +
    `• DC：${code(info.dc)}\n• 共同群：${code(info.commonChats)} 个\n` +
    (status.length ? `• 状态：${status.join(" ")}\n` : "") +
    `\n<b>简介：</b>\n${code(bio)}\n\n<b>跳转链接：</b>\n` +
    links.map((link, i) => `• <a href="${escape(link)}">${["用户资料", "聊天链接", "打开消息"][i]}</a>\n`).join("") +
    `\n<b>链接文本：</b>\n` + links.map(link => `• ${code(link)}`).join("\n");
}

async function send(context: PluginContext, message: MessageEnvelope, text: string): Promise<void> {
  if (text.length <= 4096) {
    await context.telegram.edit(message, text, { parseMode: "html" });
    return;
  }
  // An oversized href cannot be paginated. Its label remains, and the full URL is in the link-text section.
  text = text.replace(/<a href="[^"]{3500,}">([^<]*)<\/a>/g, "$1");
  // Tokenize only our generated HTML, keeping entities, code points and formatting intact across pages.
  const pages: string[] = [], stack: { open: string; close: string }[] = [];
  let page = "";
  const closing = () => stack.map(tag => tag.close).reverse().join("");
  for (const token of text.match(/<[^>]*>|&(?:amp|lt|gt|quot|#x27);|[\s\S]/gu) ?? []) {
    if (page.length + token.length + closing().length > 3900) {
      pages.push(page + closing());
      page = stack.map(tag => tag.open).join("");
    }
    if (/^<\//.test(token)) stack.pop();
    else if (token.startsWith("<")) stack.push({ open: token, close: `</${token.match(/^<(\w+)/)![1]}>` });
    page += token;
  }
  if (page) pages.push(page);
  for (let i = 0; i < pages.length; i++) {
    context.signal.throwIfAborted();
    const output = pages[i] + `\n\n📄 (${i + 1}/${pages.length})`;
    if (i === 0) await context.telegram.edit(message, output, { parseMode: "html" });
    else await context.telegram.reply(message, output, { parseMode: "html" });
  }
}

export default function createIds() {
  return definePlugin({
    apiVersion: 1, id: "ids", description: `用户信息查询插件\n\n${help("")}`,
    commands: { ids: { description: "用户信息查询插件", async handle({ message, prefix }, context) {
      const target = message.text.trim().split(/\r?\n/)[0].split(/\s+/)[1] || "";
      try {
        context.signal.throwIfAborted();
        if (target === "help" || target === "h") {
          await context.telegram.edit(message, help(prefix), { parseMode: "html" });
          return;
        }
        await context.telegram.edit(message, "🔍 <b>正在查询用户信息...</b>", { parseMode: "html" });
        const info = await context.telegram.withClient(async (client, signal): Promise<Info | undefined> => {
          const { Api } = await import("teleproto");
          const { returnBigInt } = await import("teleproto/Helpers.js");
          const call = async <T>(operation: () => Promise<T>): Promise<T> => {
            signal.throwIfAborted();
            const value = await operation();
            signal.throwIfAborted();
            return value;
          };
          signal.throwIfAborted();
          let user: Profile | undefined, id: ReturnType<typeof returnBigInt> | undefined;
          let hasReplySender = false;
          if (target.startsWith("@")) {
            const entity = await call(() => client.getEntity(target));
            user = entity as Profile; id = returnBigInt(entity.id);
          } else if (target) {
            // Retain parseInt's decimal/hex prefix acceptance without rounding 64-bit IDs.
            const match = target.match(/^([+-]?)(?:0x([0-9a-f]+)|(\d+))/i);
            if (!match) throw new InvalidTargetError();
            const magnitude = BigInt(match[2] ? "0x" + match[2] : match[3]);
            id = returnBigInt(match[1] === "-" ? -magnitude : magnitude);
            try { user = await call(() => client.getEntity(id!)) as Profile; }
            catch { signal.throwIfAborted(); }
          } else {
            try {
              const reply = await call(() => context.telegram.getReply(message));
              if (reply?.senderId) {
                hasReplySender = true;
                id = returnBigInt(reply.senderId);
                user = (reply.raw as Api.Message | undefined)?.sender as Profile | undefined;
              }
            } catch { signal.throwIfAborted(); }
          }
          if (!hasReplySender && !user && (!id || id.isZero())) {
            try {
              const me = await call(() => client.getMe());
              if (!(me instanceof Api.User)) return undefined;
              user = me; id = me.id;
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof Error && error.message.includes("AUTH_KEY_UNREGISTERED")) return undefined;
              throw error;
            }
          }
          if (!id || id.isZero()) return { id: "0", commonChats: 0, dc: "未知" };
          const result: Info = { id: id.toString(), user, commonChats: 0, dc: "未知" };
          try {
            const full = await call(() => client.invoke(new Api.users.GetFullUser({ id })));
            result.bio = full.fullUser?.about;
            result.commonChats = full.fullUser?.commonChatsCount || 0;
            const photo = (full.users[0] as Api.User | undefined)?.photo;
            result.dc = photo?.className === "UserProfilePhotoEmpty" ? "无头像" : photo && "dcId" in photo ? `DC${photo.dcId}` : "未知";
          } catch { signal.throwIfAborted(); }
          const raw = message.raw as Api.Message | undefined;
          if (raw?.isGroup || raw?.isChannel || (!raw && message.chatId.startsWith("-"))) {
            try {
              const participant = await call(() => client.invoke(new Api.channels.GetParticipant({
                channel: raw?.peerId ?? returnBigInt(message.chatId), participant: id,
              })));
              if ("date" in participant.participant && participant.participant.date) {
                const date = new Date(participant.participant.date * 1000);
                const pad = (value: number) => String(value).padStart(2, "0");
                result.joinedDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
              }
            } catch { signal.throwIfAborted(); }
          }
          return result;
        });
        context.signal.throwIfAborted();
        if (!info) return;
        if (info.id === "0") {
          await context.telegram.edit(message, "❌ 无法获取用户信息", { parseMode: "html" });
          return;
        }
        await send(context, message, format(info));
      } catch (error) {
        if (context.signal.aborted) return;
        const detail = error instanceof InvalidTargetError ? "无效格式" : "未知错误，请稍后重试";
        await context.telegram.edit(message, `❌ <b>查询失败:</b> ${detail}`, { parseMode: "html" });
      }
    } } },
  });
}
