import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as os from "os";
import { safeGetMessages } from "@utils/safeGetMessages";

import { htmlEscape } from "@utils/htmlEscape";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

type ImageMagickCommand = "magick" | "convert";

function getImageMagickCommand(): ImageMagickCommand | null {
  const candidates: ImageMagickCommand[] = os.platform() === "win32"
    ? ["magick"]
    : ["magick", "convert"];

  for (const command of candidates) {
    try {
      execFileSync(command, ["-version"], { stdio: "ignore" });
      return command;
    } catch {}
  }

  return null;
}

function getImageMagickInstallHelp(): string {
  const platform = os.platform();
  if (platform === "linux") {
    return "Ubuntu/Debian: sudo apt install imagemagick\nRHEL/CentOS: sudo yum install ImageMagick\nFedora: sudo dnf install ImageMagick";
  }
  if (platform === "darwin") {
    return "macOS: brew install imagemagick";
  }
  if (platform === "win32") {
    return "Windows: 请从 ImageMagick 官网下载安装，并确保 magick.exe 已加入 PATH";
  }
  return "请查阅 ImageMagick 官方文档并手动安装";
}

function imageMagickMissingText(): string {
  return `❌ <b>未检测到 ImageMagick</b>\n\n插件不会自动修改系统或安装依赖，请由管理员确认后手动执行：\n<pre>${htmlEscape(getImageMagickInstallHelp())}</pre>`;
}

// 帮助文档
const help_text = `🖼️ <b>贴纸转图片插件</b>

<b>📝 功能描述:</b>
• 🔄 <b>格式转换</b>：将Telegram贴纸转换为JPG/PNG图片
• 🎨 <b>透明处理</b>：支持保持或移除透明背景
• 📄 <b>文档模式</b>：支持以文档形式发送原图
• ⚡ <b>依赖检测</b>：使用前检测 ImageMagick，不会自动安装系统软件

<b>🔧 使用方法:</b>
• <code>${mainPrefix}sticker_to_pic</code> - 转换为JPG（回复贴纸）
• <code>${mainPrefix}stp</code> - 快捷命令
• <code>${mainPrefix}stp png</code> - 转换为PNG格式
• <code>${mainPrefix}stp transparent</code> - PNG格式保持透明
• <code>${mainPrefix}stp doc</code> - 以文档形式发送源文件

<b>💡 示例:</b>
• <code>${mainPrefix}stp</code> - 转换为JPG图片
• <code>${mainPrefix}stp png</code> - 转换为PNG图片
• <code>${mainPrefix}stp transparent</code> - PNG透明背景
• <code>${mainPrefix}stp doc</code> - 文档模式发送

<b>🔄 管理命令:</b>
• <code>${mainPrefix}stp check</code> - 检查 ImageMagick 状态

<b>📋 支持格式:</b>
• 输入：WebP贴纸文件
• 输出：JPG（默认）、PNG
• 透明：仅PNG格式支持

<b>⚙️ 系统要求:</b>
• ImageMagick（需管理员显式安装）`;

class StickerToPicPlugin extends Plugin {

  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    "sticker_to_pic": this.handleStickerToPic.bind(this),
    "stp": this.handleStickerToPic.bind(this),
  };

  private async handleStickerToPic(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 参数解析（严格按acron.ts模式）
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身
    const sub = (args[0] || "").toLowerCase();

    try {
      // 无参数时处理贴纸转换
      if (!sub) {
        await this.processStickerConversion(msg, client, 'jpg', false, false);
        return;
      }

      // 明确请求帮助时才显示
      if (sub === "help" || sub === "h") {
        await msg.edit({
          text: help_text,
          parseMode: "html"
        });
        return;
      }

      // 隐藏的检查命令（不在帮助文档中显示）
      if (sub === "check") {
        await msg.edit({ text: "🔍 正在检查ImageMagick状态...", parseMode: "html" });
        const command = getImageMagickCommand();
        if (!command) {
          await msg.edit({ text: imageMagickMissingText(), parseMode: "html" });
          return;
        }

        const version = execFileSync(command, ["-version"], { encoding: "utf8" });
        const versionLine = version.split("\n")[0];
        await msg.edit({
          text: `✅ <b>ImageMagick状态正常</b>\n\n<b>命令:</b> <code>${command}</code>\n<b>版本信息:</b>\n<code>${htmlEscape(versionLine)}</code>`,
          parseMode: "html"
        });
        return;
      }

      // 解析转换参数
      let outputFormat = 'jpg';
      let keepTransparency = false;
      let sendAsDocument = false;

      if (sub === 'png') {
        outputFormat = 'png';
        keepTransparency = args.includes('transparent');
      } else if (sub === 'transparent') {
        outputFormat = 'png';
        keepTransparency = true;
      } else if (sub === 'doc') {
        sendAsDocument = true;
        if (args.includes('png')) {
          outputFormat = 'png';
          keepTransparency = args.includes('transparent');
        }
      } else {
        // 未知子命令，提示错误
        await msg.edit({
          text: `❌ <b>未知子命令:</b> <code>${htmlEscape(sub)}</code>\n\n请使用 <code>${mainPrefix}stp help</code> 查看可用选项`,
          parseMode: "html"
        });
        return;
      }

      await this.processStickerConversion(msg, client, outputFormat, keepTransparency, sendAsDocument);

    } catch (error: any) {
      console.error("[sticker_to_pic] 插件执行失败:", error);
      await msg.edit({
        text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  private async processStickerConversion(
    msg: Api.Message, 
    client: any, 
    outputFormat: string, 
    keepTransparency: boolean, 
    sendAsDocument: boolean
  ): Promise<void> {
    try {
       
      let targetMsg = msg;
      
      if (msg.replyTo && 'replyToMsgId' in msg.replyTo && msg.replyTo.replyToMsgId) {
        try {
          const replyMsgId = msg.replyTo.replyToMsgId;
          const messages = await safeGetMessages(client, msg.peerId!, {
            ids: [replyMsgId]
          });
          
          if (messages && messages.length > 0) {
            targetMsg = messages[0];
          }
        } catch (error) {
          console.error("[sticker_to_pic] 获取回复消息失败:", error);
        }
      }
       
      if (!targetMsg.media || !(targetMsg.media instanceof Api.MessageMediaDocument)) {
        await msg.edit({
          text: "❌ <b>请回复一个贴纸消息</b>",
          parseMode: "html"
        });
        return;
      }

      const document = targetMsg.media.document;
      if (!(document instanceof Api.Document)) {
        await msg.edit({
          text: "❌ <b>无效的文档类型</b>",
          parseMode: "html"
        });
        return;
      }

      const isSticker = document.attributes?.some(attr => 
        attr instanceof Api.DocumentAttributeSticker
      );
      
      if (!isSticker) {
        await msg.edit({
          text: "❌ <b>这不是一个贴纸文件</b>",
          parseMode: "html"
        });
        return;
      }

      await msg.edit({
        text: "📥 正在下载贴纸...",
        parseMode: "html"
      });

      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = Date.now();
      const stickerPath = path.join(tempDir, `sticker_${timestamp}.webp`);
      const outputPath = path.join(tempDir, `pic_${timestamp}.${outputFormat}`);

      try {
        const buffer = await client.downloadMedia(targetMsg.media, {
          outputFile: stickerPath
        });

        if (!buffer || !fs.existsSync(stickerPath)) {
          await msg.edit({
            text: "❌ <b>贴纸下载失败</b>",
            parseMode: "html"
          });
          return;
        }

        await msg.edit({
          text: `🔄 正在转换为${outputFormat.toUpperCase()}格式...`,
          parseMode: "html"
        });

        const imageMagickCommand = getImageMagickCommand();
        if (!imageMagickCommand) {
          await msg.edit({ text: imageMagickMissingText(), parseMode: "html" });
          return;
        }

        try {
          let convertArgs: string[];

          if (outputFormat === 'png') {
            if (keepTransparency) {
              convertArgs = [stickerPath, outputPath];
            } else {
              convertArgs = [stickerPath, "-background", "white", "-alpha", "remove", outputPath];
            }
          } else {
            convertArgs = [stickerPath, "-background", "white", "-alpha", "remove", "-alpha", "off", outputPath];
          }

          execFileSync(imageMagickCommand, convertArgs, { stdio: 'ignore' });
          
          if (!fs.existsSync(outputPath)) {
            throw new Error('转换失败：输出文件未生成');
          }
          
        } catch (convertError: any) {
          console.error('[sticker_to_pic] ImageMagick转换失败:', convertError);
          await msg.edit({
            text: `❌ <b>贴纸转换失败</b>\n\n<b>错误详情:</b> ${htmlEscape(convertError.message)}\n\n💡 请确保贴纸格式正确`,
            parseMode: "html"
          });
          return;
        }

        await msg.edit({
          text: "📤 正在发送图片...",
          parseMode: "html"
        });

        if (sendAsDocument) {
          // 发送为文档（原图）
          await client.sendFile(msg.peerId!, {
            file: outputPath,
            caption: `📄 <b>贴纸已转换为${outputFormat.toUpperCase()}格式（原图）</b>`,
            replyTo: msg.id,
            forceDocument: true,
            parseMode: "html"
          });
        } else {
          // 发送为图片
          await client.sendFile(msg.peerId!, {
            file: outputPath,
            caption: `🖼️ <b>贴纸已转换为${outputFormat.toUpperCase()}格式</b>${keepTransparency ? '（透明背景）' : ''}`,
            replyTo: msg.id,
            parseMode: "html"
          });
        }

        await msg.delete();
        
      } finally {
        try {
          if (fs.existsSync(stickerPath)) {
            fs.unlinkSync(stickerPath);
          }
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch (cleanupError) {
          console.error('[sticker_to_pic] 清理临时文件失败:', cleanupError);
        }
      }
    } catch (error: any) {
      console.error("[sticker_to_pic] 处理贴纸转换失败:", error);
      
      let errorMsg = "❌ <b>转换贴纸为图片时出现错误</b>";
      
      if (error.message.includes('MEDIA_INVALID')) {
        errorMsg = "❌ <b>无效的媒体文件</b>";
      } else if (error.message.includes('FILE_PARTS_INVALID')) {
        errorMsg = "❌ <b>文件损坏或格式不支持</b>";
      } else if (error.message.includes('DOCUMENT_INVALID')) {
        errorMsg = "❌ <b>无效的文档文件</b>";
      } else {
        errorMsg += `\n\n<b>错误详情:</b> ${htmlEscape(error.message)}`;
      }
      
      await msg.edit({
        text: errorMsg,
        parseMode: "html"
      });
    }
  };
}

export default new StickerToPicPlugin();
