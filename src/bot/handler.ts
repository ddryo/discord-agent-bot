import { stat } from "fs/promises";
import { resolve } from "path";
import type { Message, TextChannel, ThreadChannel, ChatInputCommandInteraction } from "discord.js";
import { ChannelType, EmbedBuilder } from "discord.js";
import { config, expandTilde, isAuthorizedUser } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { SessionManager } from "../claude/session.ts";
import type { ClaudeSessionInfo } from "../types.ts";
import { getPendingInteraction, clearPendingInteraction, handleAskUserTextResponse } from "./interactions.ts";
import { sendSessionStartNotification, sendSessionEndNotification } from "./responder.ts";

const logger = createLogger("bot:handler");

const MAIN_SESSION_NAME = "main";

/** 対応するコマンド一覧 */
const SUPPORTED_COMMANDS = ["clear", "status", "tools"];

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

function isBlockedPath(candidatePath: string): boolean {
  return BLOCKED_PATHS.some(
    (blocked) => candidatePath === blocked || candidatePath.startsWith(`${blocked}/`),
  );
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  // ThreadCreated 等のシステムメッセージを無視（スレッド作成時に親チャンネルへ誤送信される問題の対策）
  // Default, Reply, ChatInputCommand, ContextMenuCommand 以外の全 MessageType が除外される
  if (message.system) return;
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

  // リアクション
  message.react("👀").catch(() => {});

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
  let session = sessionManager.getSessionByThreadId(threadId);

  if (!session) {
    // セッションが見つからない場合、自動復旧を試みる
    logger.info(`No session found for thread: ${threadId}, auto-recovering...`);

    const sessionName = threadId;
    const info: ClaudeSessionInfo = {
      name: sessionName,
      cwd: config.defaultCwd,
      threadId,
      isMain: false,
      claudeSessionId: null,
      state: "idle",
      usage: { inputTokens: 0, outputTokens: 0 },
      additionalAllowedTools: new Set(),
    };

    sessionManager.registerSession(info);
    session = sessionManager.getSession(sessionName)!;
    logger.info(`Session auto-recovered for thread: ${threadId} (new session, no previous context)`);
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

  // リアクション
  message.react("👀").catch(() => {});

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

  if (commandName === "tools") {
    const subcommand = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim().toLowerCase();

    if (subcommand === "clear") {
      sessionManager.clearAllowedTools(sessionName);

      const embed = new EmbedBuilder()
        .setDescription("動的ツール許可をクリアしました。")
        .setColor(0x5865f2)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      return;
    }

    // /tools（サブコマンドなし）: 許可リスト表示
    const staticTools = config.allowedTools;
    const dynamicTools = sessionManager.getAllowedTools(sessionName);

    const embed = new EmbedBuilder()
      .setTitle("Allowed Tools")
      .setColor(0x5865f2)
      .setTimestamp();

    embed.addFields({
      name: ".env (ALLOWED_TOOLS)",
      value: staticTools.length > 0 ? staticTools.map((t) => `\`${t}\``).join(", ") : "(none)",
    });

    embed.addFields({
      name: "This Session",
      value: dynamicTools.length > 0 ? dynamicTools.map((t) => `\`${t}\``).join(", ") : "(none)",
    });

    embed.setFooter({ text: "/tools clear で動的許可をクリア" });

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
 * 手動スレッド作成時に defaultCwd でセッションを起動する。
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

  // /new 経由で既に登録済みの場合はスキップ（二重起動防止）
  if (sessionManager.getSessionByThreadId(threadId)) {
    logger.info(`Session already exists for thread: ${threadId}, skipping`);
    return;
  }

  logger.info(`Thread created: ${threadId} (title: "${thread.name}")`);

  const cwd = config.defaultCwd;
  const sessionName = threadId;

  const info: ClaudeSessionInfo = {
    name: sessionName,
    cwd,
    threadId,
    isMain: false,
    claudeSessionId: null,
    state: "idle",
    usage: { inputTokens: 0, outputTokens: 0 },
    additionalAllowedTools: new Set(),
  };

  sessionManager.registerSession(info);

  await sendSessionStartNotification(thread, sessionName, cwd);

  logger.info(`Thread session registered: ${sessionName} (cwd: ${cwd})`);
}

/**
 * Application Command（スラッシュコマンド）のインタラクションを処理する。
 */
export async function handleCommandInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAuthorizedUser(interaction.user.id)) {
    await interaction.reply({ content: "この操作を行う権限がありません。", flags: 64 });
    return;
  }

  if (!sessionManager) {
    await interaction.reply({ content: "エラー: SessionManager が初期化されていません。", flags: 64 });
    return;
  }

  // セッション解決: スレッド内 → スレッドセッション / メインチャンネル → main
  const channel = interaction.channel;
  let sessionName = MAIN_SESSION_NAME;
  if (channel?.isThread()) {
    const session = sessionManager.getSessionByThreadId(channel.id);
    if (session) {
      sessionName = session.name;
    }
  }

  const commandName = interaction.commandName;
  logger.info(`Slash command: /${commandName} (session: ${sessionName})`);

  if (commandName === "clear") {
    sessionManager.clearSession(sessionName);

    const embed = new EmbedBuilder()
      .setDescription("--- Context Cleared ---")
      .setColor(0x5865f2)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
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

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (commandName === "tools") {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "clear") {
      sessionManager.clearAllowedTools(sessionName);

      const embed = new EmbedBuilder()
        .setDescription("動的ツール許可をクリアしました。")
        .setColor(0x5865f2)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // /tools list: 許可リスト表示
    const staticTools = config.allowedTools;
    const dynamicTools = sessionManager.getAllowedTools(sessionName);

    const embed = new EmbedBuilder()
      .setTitle("Allowed Tools")
      .setColor(0x5865f2)
      .setTimestamp();

    embed.addFields({
      name: "Static (ALLOWED_TOOLS)",
      value: staticTools.length > 0 ? staticTools.map((t) => `\`${t}\``).join(", ") : "(none)",
    });

    embed.addFields({
      name: "Dynamic (session)",
      value: dynamicTools.length > 0 ? dynamicTools.map((t) => `\`${t}\``).join(", ") : "(none)",
    });

    embed.setFooter({ text: "/tools clear で動的許可をクリア" });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (commandName === "new") {
    await handleNewCommand(interaction);
    return;
  }
}

async function handleNewCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!sessionManager) {
    await interaction.reply({ content: "エラー: SessionManager が初期化されていません。", flags: 64 });
    return;
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "このコマンドはテキストチャンネルでのみ使用できます。", flags: 64 });
    return;
  }

  const title = interaction.options.getString("title", true);
  const rawPath = interaction.options.getString("path");

  let cwd: string;

  if (rawPath) {
    const expandedPath = expandTilde(rawPath);
    const candidatePath = resolve(expandedPath);

    if (isBlockedPath(candidatePath)) {
      await interaction.reply({ content: `パスが無効です: \`${candidatePath}\` はブロックされています。`, flags: 64 });
      return;
    }

    try {
      const stats = await stat(candidatePath);
      if (!stats.isDirectory()) {
        await interaction.reply({ content: `パスが無効です: \`${candidatePath}\` はディレクトリではありません。`, flags: 64 });
        return;
      }
    } catch {
      await interaction.reply({ content: `パスが無効です: \`${candidatePath}\` が存在しません。`, flags: 64 });
      return;
    }

    cwd = candidatePath;
  } else {
    cwd = config.defaultCwd;
  }

  try {
    const thread = await channel.threads.create({
      name: title,
      autoArchiveDuration: 1440,
    });

    const threadId = thread.id;
    const sessionName = threadId;

    const info: ClaudeSessionInfo = {
      name: sessionName,
      cwd,
      threadId,
      isMain: false,
      claudeSessionId: null,
      state: "idle",
      usage: { inputTokens: 0, outputTokens: 0 },
      additionalAllowedTools: new Set(),
    };

    sessionManager.registerSession(info);

    await sendSessionStartNotification(thread, sessionName, cwd);

    logger.info(`/new: thread=${threadId}, session=${sessionName}, cwd=${cwd}`);

    await interaction.reply({ content: `スレッド <#${threadId}> を作成しました。`, flags: 64 });
  } catch (error) {
    logger.error(`Failed to create thread: ${String(error)}`);
    if (!interaction.replied) {
      await interaction.reply({ content: "エラー: スレッドの作成に失敗しました。", flags: 64 });
    }
  }
}
