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
import type { ToolApprovalInfo, AskUserInfo } from "../types.ts";
import { sendInput } from "../tmux/manager.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("bot:interactions");

/** Discord コンポーネント制限: 最大 5 ActionRow × 5 ボタン */
const MAX_BUTTONS = 25;

interface PendingState {
  type: "tool_approval" | "ask_user";
  messageId: string;
}

/** セッションごとの待機中インタラクション状態 */
const pendingInteractions = new Map<string, PendingState>();

/**
 * セッションの待機中インタラクション種別を取得する
 */
export function getPendingInteraction(sessionName: string): "tool_approval" | "ask_user" | undefined {
  return pendingInteractions.get(sessionName)?.type;
}

/**
 * セッションの待機中インタラクション状態をクリアする
 */
export function clearPendingInteraction(sessionName: string): void {
  pendingInteractions.delete(sessionName);
}

/**
 * ツール許可待ちを Discord Embed + ボタンで通知する
 */
export async function sendToolApproval(
  channel: TextChannel | ThreadChannel,
  sessionName: string,
  info: ToolApprovalInfo,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(`Tool: ${info.tool}`)
    .setColor(0xf59e0b);

  if (info.description) {
    embed.setDescription("```\n" + info.description + "\n```");
  }

  if (info.options.length > 0) {
    embed.addFields({
      name: "Options",
      value: info.options.map((opt, i) => `${i + 1}. ${opt}`).join("\n"),
    });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tool_approve:${sessionName}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`tool_always:${sessionName}`)
      .setLabel("Always Allow")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`tool_deny:${sessionName}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await channel.send({ embeds: [embed], components: [row] });
  pendingInteractions.set(sessionName, { type: "tool_approval", messageId: sent.id });
}

/**
 * ツール許可ボタンの応答を処理する
 */
async function handleToolApprovalButton(
  interaction: ButtonInteraction,
  sessionName: string,
  action: "approve" | "always" | "deny",
): Promise<void> {
  // 選択肢に応じたテキストを sendInput で送信
  const choiceMap: Record<string, string> = {
    approve: "1",
    always: "2",
    deny: "3",
  };

  const choice = choiceMap[action]!;

  try {
    await sendInput(sessionName, choice);
    logger.info(`Tool approval: ${action} (choice=${choice}) for session ${sessionName}`);
  } catch (error) {
    logger.error(`Failed to send tool approval: ${String(error)}`);
    await interaction.reply({ content: "エラー: CLI への送信に失敗しました。再度お試しください。", flags: 64 });
    return;
  }

  pendingInteractions.delete(sessionName);

  // ボタンを無効化してメッセージを更新
  const actionLabel = action === "approve" ? "Approved" : action === "always" ? "Always Allowed" : "Denied";

  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tool_approve:${sessionName}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`tool_always:${sessionName}`)
      .setLabel("Always Allow")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`tool_deny:${sessionName}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
  );

  await interaction.update({
    content: `**${actionLabel}** by ${interaction.user.tag}`,
    components: [disabledRow],
  });
}

/**
 * AskUserQuestion を Discord Embed + ボタンで通知する
 */
export async function sendAskUser(
  channel: TextChannel | ThreadChannel,
  sessionName: string,
  info: AskUserInfo,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Question")
    .setDescription(info.question)
    .setColor(0x3b82f6);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (info.options && info.options.length > 0) {
    // Discord 制限: 最大 5 ActionRow × 5 ボタン = 25 個
    const displayOptions = info.options.slice(0, MAX_BUTTONS);
    const buttons: ButtonBuilder[] = displayOptions.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`askuser_${i + 1}:${sessionName}`)
        .setLabel(`${i + 1}. ${opt}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );

    // ActionRow ごとに最大5ボタン
    for (let i = 0; i < buttons.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...buttons.slice(i, i + 5),
      );
      components.push(row);
    }

    embed.setFooter({ text: "ボタンで選択するか、テキストメッセージで回答できます" });
  } else {
    embed.setFooter({ text: "テキストメッセージで回答してください" });
  }

  const sent = await channel.send({
    embeds: [embed],
    ...(components.length > 0 ? { components } : {}),
  });
  pendingInteractions.set(sessionName, { type: "ask_user", messageId: sent.id });
}

/**
 * AskUser ボタンの応答を処理する
 */
async function handleAskUserButton(
  interaction: ButtonInteraction,
  sessionName: string,
  optionIndex: number,
): Promise<void> {
  try {
    await sendInput(sessionName, String(optionIndex));
    logger.info(`AskUser: option ${optionIndex} selected for session ${sessionName}`);
  } catch (error) {
    logger.error(`Failed to send AskUser response: ${String(error)}`);
    await interaction.reply({ content: "エラー: CLI への送信に失敗しました。再度お試しください。", flags: 64 });
    return;
  }

  pendingInteractions.delete(sessionName);

  // ボタンを無効化してメッセージを更新
  await interaction.update({
    content: `**Option ${optionIndex} selected** by ${interaction.user.tag}`,
    components: [],
  });
}

/**
 * AskUser のテキスト返答を処理する。
 * handler.ts から呼ばれる。テキスト内容を CLI に送信し、pendingInteraction をクリアする。
 */
export async function handleAskUserTextResponse(
  sessionName: string,
  text: string,
): Promise<void> {
  try {
    await sendInput(sessionName, text);
    logger.info(`AskUser text response for session ${sessionName}: ${text.substring(0, 80)}`);
  } catch (error) {
    logger.error(`Failed to send AskUser text response: ${String(error)}`);
    // テキスト返答は再送可能なため pending を維持
    throw error;
  }

  pendingInteractions.delete(sessionName);
}

/**
 * interactionCreate イベントのハンドラ
 */
/**
 * pending 状態と messageId を検証し、stale なボタン操作を拒否する
 */
function validatePending(sessionName: string, messageId: string, expectedType: PendingState["type"]): boolean {
  const pending = pendingInteractions.get(sessionName);
  return pending !== undefined && pending.type === expectedType && pending.messageId === messageId;
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const messageId = interaction.message.id;

  // ツール許可ボタンの処理
  if (customId.startsWith("tool_approve:")) {
    const sessionName = customId.slice("tool_approve:".length);
    if (!validatePending(sessionName, messageId, "tool_approval")) {
      await interaction.reply({ content: "この操作は既に処理済みです。", flags: 64 });
      return;
    }
    await handleToolApprovalButton(interaction, sessionName, "approve");
    return;
  }
  if (customId.startsWith("tool_always:")) {
    const sessionName = customId.slice("tool_always:".length);
    if (!validatePending(sessionName, messageId, "tool_approval")) {
      await interaction.reply({ content: "この操作は既に処理済みです。", flags: 64 });
      return;
    }
    await handleToolApprovalButton(interaction, sessionName, "always");
    return;
  }
  if (customId.startsWith("tool_deny:")) {
    const sessionName = customId.slice("tool_deny:".length);
    if (!validatePending(sessionName, messageId, "tool_approval")) {
      await interaction.reply({ content: "この操作は既に処理済みです。", flags: 64 });
      return;
    }
    await handleToolApprovalButton(interaction, sessionName, "deny");
    return;
  }

  // AskUser ボタンの処理
  const askUserMatch = customId.match(/^askuser_(\d+):(.+)$/);
  if (askUserMatch) {
    const optionIndex = parseInt(askUserMatch[1]!, 10);
    const sessionName = askUserMatch[2]!;
    if (!validatePending(sessionName, messageId, "ask_user")) {
      await interaction.reply({ content: "この操作は既に処理済みです。", flags: 64 });
      return;
    }
    await handleAskUserButton(interaction, sessionName, optionIndex);
    return;
  }
}
