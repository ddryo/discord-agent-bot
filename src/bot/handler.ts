import { stat } from "fs/promises";
import { resolve } from "path";
import type { Message, TextChannel, ThreadChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { config, expandTilde, isAuthorizedUser } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { SessionManager } from "../claude/session.ts";
import type { ClaudeSessionInfo } from "../types.ts";
import { getPendingInteraction, clearPendingInteraction, handleAskUserTextResponse } from "./interactions.ts";
import { sendSessionStartNotification, sendSessionEndNotification } from "./responder.ts";

const logger = createLogger("bot:handler");

const MAIN_SESSION_NAME = "main";

/** 対応するコマンド一覧 */
const SUPPORTED_COMMANDS = ["clear", "cost", "status"];

/** SessionManager への参照（index.ts から setSessionManager で設定） */
let sessionManager: SessionManager | null = null;

/**
 * SessionManager の参照を設定する。
 */
export function setSessionManager(sm: SessionManager): void {
  sessionManager = sm;
}

/** パストラバーサル防止: システムディレクトリへのセッション作成をブロック */
const BLOCKED_PATHS = ["/", "/etc", "/sys", "/proc", "/dev", "/boot", "/sbin", "/bin", "/usr/sbin", "/usr/bin"];

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!isAuthorizedUser(message.author.id)) {
    logger.debug(`Unauthorized user: ${message.author.tag} (${message.author.id})`);
    return;
  }

  // スレッド内メッセージの振り分け
  if (message.channel.isThread()) {
    await handleThreadMessage(message);
    return;
  }

  // 対象チャンネル以外は無視
  if (message.channelId !== config.discordChannelId) return;

  const text = message.content.trim();
  if (!text) return;

  logger.info(`Message from ${message.author.tag}: ${text.substring(0, 80)}`);

  if (!sessionManager) {
    logger.error("SessionManager not initialized");
    return;
  }

  // メインセッションが存在しなければ再登録
  if (!sessionManager.hasSession(MAIN_SESSION_NAME)) {
    logger.info("Main session not found, re-registering...");
    const info: ClaudeSessionInfo = {
      name: MAIN_SESSION_NAME,
      cwd: config.defaultCwd,
      threadId: null,
      isMain: true,
      claudeSessionId: null,
      state: "idle",
      usage: { inputTokens: 0, outputTokens: 0 },
      additionalAllowedTools: new Set(),
    };
    sessionManager.registerSession(info);
  }

  // コマンド判定
  if (text.startsWith("/")) {
    await handleCommand(message, MAIN_SESSION_NAME, null, text);
    return;
  }

  // AskUser 待ちの場合はテキスト返答として処理
  if (getPendingInteraction(MAIN_SESSION_NAME) === "ask_user") {
    handleAskUserTextResponse(MAIN_SESSION_NAME);
    // 次メッセージは通常の sendMessage で --resume 経由
  }

  // busy ガード
  if (sessionManager.isBusy(MAIN_SESSION_NAME)) {
    await message.reply("処理中です。完了までお待ちください。");
    return;
  }

  // SessionManager 経由でメッセージ送信
  try {
    await sessionManager.sendMessage(MAIN_SESSION_NAME, text);
  } catch (error) {
    logger.error(`Failed to send message: ${String(error)}`);
    await message.reply("エラー: メッセージの送信に失敗しました。");
  }
}

/**
 * スレッド内メッセージを対応するセッションに振り分ける。
 */
async function handleThreadMessage(message: Message): Promise<void> {
  const thread = message.channel;
  if (!thread.isThread()) return;
  if (thread.parentId !== config.discordChannelId) return;
  if (!isAuthorizedUser(message.author.id)) return;

  const text = message.content.trim();
  if (!text) return;

  if (!sessionManager) {
    logger.error("SessionManager not initialized");
    return;
  }

  const threadId = thread.id;
  const session = sessionManager.getSessionByThreadId(threadId);

  if (!session) {
    logger.warn(`No session found for thread: ${threadId}`);
    await thread.send(
      "エラー: このスレッドに対応するセッションが見つかりません。",
    );
    return;
  }

  logger.info(
    `Thread message from ${message.author.tag} in ${threadId}: ${text.substring(0, 80)}`,
  );

  // コマンド判定
  if (text.startsWith("/")) {
    await handleCommand(message, session.name, threadId, text);
    return;
  }

  // AskUser 待ちの場合はテキスト返答として処理
  if (getPendingInteraction(session.name) === "ask_user") {
    handleAskUserTextResponse(session.name);
    // 次メッセージは通常の sendMessage で --resume 経由
  }

  // busy ガード
  if (sessionManager.isBusy(session.name)) {
    await message.reply("処理中です。完了までお待ちください。");
    return;
  }

  // SessionManager 経由でメッセージ送信
  try {
    await sessionManager.sendMessage(session.name, text);
  } catch (error) {
    logger.error(`Failed to send message: ${String(error)}`);
    await message.reply("エラー: メッセージの送信に失敗しました。");
  }
}

/**
 * コマンドを解析し、対応する処理を実行する。
 */
async function handleCommand(
  message: Message,
  sessionName: string,
  threadId: string | null,
  text: string,
): Promise<void> {
  const spaceIndex = text.indexOf(" ");
  const commandName = (spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)).toLowerCase();

  // /exit は特別処理
  if (commandName === "exit") {
    await handleExitCommand(message, sessionName, threadId);
    return;
  }

  if (!SUPPORTED_COMMANDS.includes(commandName)) {
    await message.reply(`未対応のコマンドです: \`/${commandName}\``);
    return;
  }

  if (!sessionManager) return;

  logger.info(`Command: /${commandName} (session: ${sessionName})`);

  if (commandName === "clear") {
    sessionManager.clearSession(sessionName);

    const embed = new EmbedBuilder()
      .setDescription("--- Context Cleared ---")
      .setColor(0x5865f2)
      .setTimestamp();

    await message.reply({ embeds: [embed] });
    return;
  }

  if (commandName === "cost") {
    const usage = sessionManager.getUsage(sessionName);
    const embed = new EmbedBuilder()
      .setTitle("Token Usage")
      .setColor(0x5865f2)
      .setTimestamp();

    if (usage) {
      embed.addFields(
        { name: "Input Tokens", value: `${usage.inputTokens.toLocaleString()}`, inline: true },
        { name: "Output Tokens", value: `${usage.outputTokens.toLocaleString()}`, inline: true },
      );
    } else {
      embed.setDescription("セッションが見つかりません。");
    }

    await message.reply({ embeds: [embed] });
    return;
  }

  if (commandName === "status") {
    const session = sessionManager.getSession(sessionName);
    const embed = new EmbedBuilder()
      .setTitle("Session Status")
      .setColor(0x5865f2)
      .setTimestamp();

    if (session) {
      embed.addFields(
        { name: "Session", value: session.name, inline: true },
        { name: "State", value: session.state, inline: true },
        { name: "CWD", value: `\`${session.cwd}\``, inline: false },
        { name: "Claude Session ID", value: session.claudeSessionId ?? "(none)", inline: false },
      );
    } else {
      embed.setDescription("セッションが見つかりません。");
    }

    await message.reply({ embeds: [embed] });
    return;
  }
}

/**
 * /exit コマンドの処理。セッションを終了し、関連リソースをクリーンアップする。
 */
async function handleExitCommand(
  message: Message,
  sessionName: string,
  _threadId: string | null,
): Promise<void> {
  logger.info(`Exit command: session=${sessionName}`);

  if (!sessionManager) return;

  clearPendingInteraction(sessionName);
  sessionManager.removeSession(sessionName);

  await sendSessionEndNotification(message.channel as TextChannel | ThreadChannel, "exit");
}

/**
 * スレッド作成イベントのハンドラ。
 * スレッドタイトルを cwd として新規セッションを登録する。
 */
export async function handleThreadCreate(
  thread: ThreadChannel,
  newlyCreated: boolean,
): Promise<void> {
  if (!newlyCreated) return;
  if (thread.parentId !== config.discordChannelId) return;
  if (!isAuthorizedUser(thread.ownerId ?? "")) return;

  if (!sessionManager) {
    logger.error("SessionManager not initialized");
    return;
  }

  const threadId = thread.id;

  // 重複セッション作成を防止
  if (sessionManager.getSessionByThreadId(threadId)) {
    logger.warn(`Session already exists for thread: ${threadId}`);
    return;
  }

  const rawPath = thread.name;
  logger.info(`Thread created: ${threadId} (title: "${rawPath}")`);

  const expandedPath = expandTilde(rawPath);
  const resolvedPath = resolve(expandedPath);

  // システムディレクトリへのアクセスをブロック
  if (BLOCKED_PATHS.includes(resolvedPath)) {
    logger.warn(`Blocked system path: ${resolvedPath}`);
    await thread.send(
      `エラー: システムディレクトリ \`${resolvedPath}\` は使用できません。`,
    );
    return;
  }

  // パスの存在・ディレクトリチェック
  try {
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      logger.warn(`Path is not a directory: ${resolvedPath}`);
      await thread.send(
        `エラー: パス \`${rawPath}\` はディレクトリではありません。有効なディレクトリパスをスレッドタイトルに指定してください。`,
      );
      return;
    }
  } catch {
    logger.warn(`Path does not exist: ${resolvedPath}`);
    await thread.send(
      `エラー: パス \`${rawPath}\` は存在しません。有効なディレクトリパスをスレッドタイトルに指定してください。`,
    );
    return;
  }

  const sessionName = threadId;

  const info: ClaudeSessionInfo = {
    name: sessionName,
    cwd: resolvedPath,
    threadId,
    isMain: false,
    claudeSessionId: null,
    state: "idle",
    usage: { inputTokens: 0, outputTokens: 0 },
    additionalAllowedTools: new Set(),
  };

  sessionManager.registerSession(info);

  // 起動完了通知
  await sendSessionStartNotification(thread, sessionName, resolvedPath);

  logger.info(`Thread session registered: ${sessionName} (cwd: ${resolvedPath})`);
}
