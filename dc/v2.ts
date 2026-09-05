import { definePlugin, type MessageEnvelope } from "telebox/sdk";
import type { Api } from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!);
const location = (name: string, dc: number): string => `📍 <b>${escape(name)}</b> 所在数据中心为: <b>DC${dc}</b>`;

export default function createDc() {
  return definePlugin({
    apiVersion: 1, id: "dc", description: "获取指定用户或当前群组/频道的 DC",
    commands: { dc: { description: "获取指定用户或当前群组/频道的 DC", async handle({ message, args }, context) {
      const edit = (text: string) => context.telegram.edit(message, text, { parseMode: "html" });
      context.signal.throwIfAborted();
      if (args.length > 1) {
        await edit("❌ 参数错误，最多只能指定一个用户");
        return;
      }
      await edit("🔍 <b>正在获取 DC 信息...</b>");
      try {
        await context.telegram.withClient(async (client, signal) => {
          const { Api } = await import("teleproto");
          const { returnBigInt } = await import("teleproto/Helpers.js");
          const call = async <T>(operation: () => Promise<T>): Promise<T> => {
            signal.throwIfAborted();
            const value = await operation();
            signal.throwIfAborted();
            return value;
          };
          signal.throwIfAborted();
          const chatFor = async (envelope: MessageEnvelope) => {
            const raw = envelope.raw as Api.Message | undefined;
            // Keep Teleproto's cache/refetch semantics only for the borrowed client's own message.
            if (raw?.client === client && typeof raw.getChat === "function") return call(() => raw.getChat());
            if (raw?.chat && !("min" in raw.chat)) return raw.chat;
            return call(() => client.getEntity(raw?.inputChat ?? raw?.peerId ?? returnBigInt(envelope.chatId)));
          };
          const showChat = async (envelope: MessageEnvelope, replied: boolean) => {
            const chat = await chatFor(envelope);
            if (!chat || !("photo" in chat) || !chat.photo || chat.photo.className === "ChatPhotoEmpty") {
              await edit(replied ? "❌ 回复的消息所在对话需要先设置头像" : "❌ 当前群组/频道没有头像，无法获取 DC 信息");
              return;
            }
            const photo = chat.photo as Api.ChatPhoto;
            await edit(location("title" in chat ? chat.title : replied ? "未知聊天" : "当前聊天", photo.dcId));
          };
          const raw = message.raw as Api.Message | undefined;
          if (message.replyToId !== undefined || raw?.replyTo) {
            const reply = await call(() => context.telegram.getReply(message));
            if (!reply) { await edit("❌ 无法获取回复的消息"); return; }
            if (!reply.senderId) { await edit("❌ 无法获取回复消息的发送者"); return; }
            try {
              const input = await call(() => client.getInputEntity(returnBigInt(reply.senderId!)));
              const full = await call(() => client.invoke(new Api.users.GetFullUser({ id: input })));
              const user = full.users[0] as Api.User;
              if (!user.photo || user.photo.className === "UserProfilePhotoEmpty") {
                await edit("❌ 目标用户没有头像，无法获取 DC 信息"); return;
              }
              await edit(location(user.firstName || "未知用户", (user.photo as Api.UserProfilePhoto).dcId));
            } catch {
              signal.throwIfAborted();
              try { await showChat(reply, true); }
              catch { signal.throwIfAborted(); await edit("❌ 无法获取该对象的 DC 信息"); }
            }
            return;
          }
          const param = args[0] || "";
          if (!param) { await showChat(message, false); return; }
          const fallback = () => /^\d+$/.test(param) ? returnBigInt(param) : param;
          let target: ReturnType<typeof fallback> = fallback();
          try {
            for (const entity of raw?.entities ?? []) {
              if (entity instanceof Api.MessageEntityMentionName) {
                // Decimal strings are phone lookups in Teleproto; a mention is an exact peer ID.
                target = entity.userId; break;
              }
              if (entity instanceof Api.MessageEntityPhone) { target = fallback(); break; }
            }
          } catch {
            context.log.error("dc_entity_parse_failed");
            target = fallback();
          }
          if (typeof target !== "string" && target.isZero()) {
            await edit("❌ 请指定有效的用户名或用户ID"); return;
          }
          try {
            const entity = await call(() => client.getEntity(target));
            const input = await call(() => client.getInputEntity(entity));
            const full = await call(() => client.invoke(new Api.users.GetFullUser({ id: input })));
            const user = full.users[0] as Api.User;
            if (!user.photo || user.photo.className === "UserProfilePhotoEmpty") {
              await edit("❌ 目标用户需要先设置头像才能获取 DC 信息"); return;
            }
            await edit(location(user.firstName || "未知用户", (user.photo as Api.UserProfilePhoto).dcId));
          } catch (error) {
            signal.throwIfAborted();
            const detail = String(error);
            const mappings = [
              ["Cannot find any entity corresponding to", "❌ 找不到对应的用户或实体"],
              ["No user has", "❌ 没有找到指定的用户"],
              ["Could not find the input entity for", "❌ 无法找到输入的实体"],
              ["int too big to convert", "❌ 用户ID过长，请检查输入"],
            ];
            const known = mappings.find(([match]) => detail.includes(match));
            if (known) await edit(known[1]);
            else {
              context.log.error("dc_user_query_failed");
              await edit("❌ <b>获取用户信息失败:</b> 未知错误，请稍后重试");
            }
          }
        });
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("dc_query_failed");
        await edit("❌ <b>DC 查询失败:</b> 未知错误，请稍后重试");
      }
    } } },
  });
}
