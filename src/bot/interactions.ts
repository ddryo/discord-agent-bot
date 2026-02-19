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

/** セッションごとの待機中インタラクション状態 */
const pendingInteractions = new Map<string, "tool_approval" | "ask_user">();

/**
 * セッションの待機中インタラクション状態を取得する
 */
export function getPendingInteraction(sessionName: string): "tool_approval" | "ask_user" | undefined {
  return pendingInteractions.get(sessionName);
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

  pendingInteractions.set(sessionName, "tool_approval");

  await channel.send({ embeds: [embed], components: [row] });
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
    // 選択肢をボタンで表示（最大5個/行、ActionRow は最大5行）
    const buttons: ButtonBuilder[] = info.options.map((opt, i) =>
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

  pendingInteractions.set(sessionName, "ask_user");

  await channel.send({
    embeds: [embed],
    ...(components.length > 0 ? { components } : {}),
  });
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
  }

  pendingInteractions.delete(sessionName);
}

/**
 * interactionCreate イベントのハンドラ
 */
export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // ツール許可ボタンの処理
  if (customId.startsWith("tool_approve:")) {
    const sessionName = customId.slice("tool_approve:".length);
    await handleToolApprovalButton(interaction, sessionName, "approve");
    return;
  }
  if (customId.startsWith("tool_always:")) {
    const sessionName = customId.slice("tool_always:".length);
    await handleToolApprovalButton(interaction, sessionName, "always");
    return;
  }
  if (customId.startsWith("tool_deny:")) {
    const sessionName = customId.slice("tool_deny:".length);
    await handleToolApprovalButton(interaction, sessionName, "deny");
    return;
  }

  // AskUser ボタンの処理
  const askUserMatch = customId.match(/^askuser_(\d+):(.+)$/);
  if (askUserMatch) {
    const optionIndex = parseInt(askUserMatch[1]!, 10);
    const sessionName = askUserMatch[2]!;
    await handleAskUserButton(interaction, sessionName, optionIndex);
    return;
  }
}
