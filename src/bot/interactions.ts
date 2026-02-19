import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type TextChannel,
  type ThreadChannel,
  type Interaction,
  type ButtonInteraction,
} from "discord.js";
import type { SessionManager } from "../claude/session.ts";
import { createLogger } from "../logger.ts";
import { isAuthorizedUser } from "../config.ts";

const logger = createLogger("bot:interactions");

/** SessionManager への参照（index.ts から設定） */
let sessionManager: SessionManager | null = null;

export function setInteractionSessionManager(sm: SessionManager): void {
  sessionManager = sm;
}

interface PendingState {
  type: "tool_blocked" | "ask_user";
  messageId: string;
  /** toolBlocked 時のツール名 */
  toolName?: string;
  /** toolBlocked 時のツール入力（パターン生成用） */
  toolInput?: Record<string, unknown>;
}

/** セッションごとの待機中インタラクション状態 */
const pendingInteractions = new Map<string, PendingState>();

/**
 * セッションの待機中インタラクション種別を取得する
 */
export function getPendingInteraction(sessionName: string): "tool_blocked" | "ask_user" | undefined {
  return pendingInteractions.get(sessionName)?.type;
}

/**
 * セッションの待機中インタラクション状態をクリアする
 */
export function clearPendingInteraction(sessionName: string): void {
  pendingInteractions.delete(sessionName);
}

/**
 * ツールブロック通知を Discord Embed + Approve/Deny ボタンで送信する
 */
export async function sendToolBlockedNotification(
  channel: TextChannel | ThreadChannel,
  sessionName: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<void> {
  // 既にこのセッションで pending がある場合はスキップ（通知の重複抑制）
  if (pendingInteractions.has(sessionName)) {
    logger.debug(`Skipping duplicate toolBlocked notification for session ${sessionName}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Tool Blocked: ${toolName}`)
    .setColor(0xf59e0b);

  const inputPreview = JSON.stringify(toolInput, null, 2);
  if (inputPreview.length > 0 && inputPreview !== "{}") {
    embed.setDescription("```json\n" + inputPreview.substring(0, 1000) + "\n```");
  }

  embed.setFooter({ text: "Approve で次回以降このツールを許可します" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tool_approve:${sessionName}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`tool_deny:${sessionName}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await channel.send({ embeds: [embed], components: [row] });
  pendingInteractions.set(sessionName, { type: "tool_blocked", messageId: sent.id, toolName, toolInput });
}

/**
 * AskUserQuestion を Discord Embed で通知する（ボタンなし、テキスト返答案内のみ）。
 * -p モードでは stdin 応答不可のため、ユーザーが次メッセージで回答 → --resume で継続する。
 */
export async function sendAskUser(
  channel: TextChannel | ThreadChannel,
  sessionName: string,
  question: string,
  options: string[],
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Question")
    .setDescription(question)
    .setColor(0x3b82f6);

  if (options.length > 0) {
    embed.addFields({
      name: "Options",
      value: options.map((opt, i) => `${i + 1}. ${opt}`).join("\n"),
    });
  }

  embed.setFooter({ text: "テキストメッセージで回答してください。回答は次のメッセージとして送信されます。" });

  const sent = await channel.send({ embeds: [embed] });
  pendingInteractions.set(sessionName, { type: "ask_user", messageId: sent.id });
}

/**
 * AskUser のテキスト返答を処理する。
 * pendingInteraction のクリアのみ行う（次メッセージは通常の sendMessage で --resume 経由）。
 */
export function handleAskUserTextResponse(sessionName: string): void {
  pendingInteractions.delete(sessionName);
  logger.info(`AskUser pending cleared for session ${sessionName} (text response via --resume)`);
}

/**
 * pending 状態を原子的に消費する。
 */
function consumePending(sessionName: string, messageId: string, expectedType: PendingState["type"]): PendingState | null {
  const pending = pendingInteractions.get(sessionName);
  if (!pending || pending.type !== expectedType || pending.messageId !== messageId) {
    return null;
  }
  pendingInteractions.delete(sessionName);
  return pending;
}

/**
 * toolName + toolInput から --allowedTools 用の許可パターンを生成する。
 * Bash の場合はコマンドの先頭語に絞る（例: "mkdir -p foo" → "Bash(mkdir:*)"）。
 */
function buildAllowedToolPattern(toolName: string, toolInput?: Record<string, unknown>): string {
  if (toolName === "Bash" && toolInput && typeof toolInput.command === "string") {
    const command = toolInput.command.trim();
    const firstWord = command.split(/\s+/)[0];
    if (firstWord) {
      return `Bash(${firstWord}:*)`;
    }
  }
  return toolName;
}

/**
 * Approve/Deny 共通: ボタン無効化した ActionRow を生成する
 */
function buildDisabledRow(sessionName: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tool_approve:${sessionName}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`tool_deny:${sessionName}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
  );
}

/**
 * ボタン応答後に Claude セッションへ自動再送信する
 */
async function autoResendToSession(sessionName: string, text: string): Promise<void> {
  if (!sessionManager) return;

  if (sessionManager.isBusy(sessionName)) {
    logger.warn(`Session is busy, skipping auto-resend: ${sessionName}`);
    return;
  }

  try {
    await sessionManager.sendMessage(sessionName, text);
  } catch (error) {
    logger.error(`Failed to auto-resend after button action: ${String(error)}`);
  }
}

/**
 * ToolBlocked の Approve ボタン応答を処理する
 */
async function handleToolApproveButton(
  interaction: ButtonInteraction,
  sessionName: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
): Promise<void> {
  if (!sessionManager) {
    await interaction.reply({ content: "エラー: SessionManager が初期化されていません。", flags: 64 });
    return;
  }

  // コマンド単位の許可パターンを生成して追加
  const pattern = buildAllowedToolPattern(toolName, toolInput);
  sessionManager.addAllowedTool(sessionName, pattern);
  logger.info(`Tool approved: ${pattern} for session ${sessionName}`);

  const disabledRow = buildDisabledRow(sessionName);

  await interaction.update({
    content: `**Approved: ${pattern}** by ${interaction.user.tag}`,
    components: [disabledRow],
  });

  // Claude に自動再送信してリトライ
  await autoResendToSession(sessionName, `Approved: ${pattern}`);
}

/**
 * ToolBlocked の Deny ボタン応答を処理する
 */
async function handleToolDenyButton(
  interaction: ButtonInteraction,
  sessionName: string,
  toolName: string,
): Promise<void> {
  const disabledRow = buildDisabledRow(sessionName);

  await interaction.update({
    content: `**Denied: ${toolName}** by ${interaction.user.tag}`,
    components: [disabledRow],
  });

  // Claude に deny を通知して続行させる
  await autoResendToSession(sessionName, `Denied: ${toolName}`);
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  // Application Command（スラッシュコマンド）は handler.ts で処理
  if (interaction.isChatInputCommand()) {
    const { handleCommandInteraction } = await import("./handler.ts");
    await handleCommandInteraction(interaction);
    return;
  }

  if (!interaction.isButton()) return;

  if (!isAuthorizedUser(interaction.user.id)) {
    await interaction.reply({
      content: "この操作を行う権限がありません。",
      flags: 64,
    });
    return;
  }

  const customId = interaction.customId;
  const messageId = interaction.message.id;

  // Approve ボタン
  if (customId.startsWith("tool_approve:")) {
    const sessionName = customId.slice("tool_approve:".length);
    const pending = consumePending(sessionName, messageId, "tool_blocked");
    if (!pending) {
      await interaction.reply({ content: "この操作は既に処理済みです。", flags: 64 });
      return;
    }
    await handleToolApproveButton(interaction, sessionName, pending.toolName ?? "unknown", pending.toolInput);
    return;
  }

  // Deny ボタン
  if (customId.startsWith("tool_deny:")) {
    const sessionName = customId.slice("tool_deny:".length);
    const pending = consumePending(sessionName, messageId, "tool_blocked");
    if (!pending) {
      await interaction.reply({ content: "この操作は既に処理済みです。", flags: 64 });
      return;
    }
    await handleToolDenyButton(interaction, sessionName, pending.toolName ?? "unknown");
    return;
  }
}
