import type { Message } from "discord.js";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { createSession, hasSession, sendInput } from "../tmux/manager.ts";

const logger = createLogger("bot:handler");

const MAIN_SESSION_NAME = "main";

export async function handleMessage(message: Message): Promise<void> {
  // Bot 自身のメッセージは無視
  if (message.author.bot) return;

  // 対象チャンネル以外は無視
  if (message.channelId !== config.discordChannelId) return;

  // スレッド内メッセージは M1 では無視（M2 で対応）
  if (message.channel.isThread()) return;

  const text = message.content.trim();
  if (!text) return;

  logger.info(`Message from ${message.author.tag}: ${text.substring(0, 80)}`);

  // メインセッションが存在しなければ作成
  const sessionExists = await hasSession(MAIN_SESSION_NAME);
  if (!sessionExists) {
    logger.info("Main session not found, creating...");
    await createSession(MAIN_SESSION_NAME, config.defaultCwd);
  }

  // Claude CLI にメッセージを送信
  await sendInput(MAIN_SESSION_NAME, text);
}
