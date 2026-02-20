import { SlashCommandBuilder, type Client } from "discord.js";
import { createLogger } from "../logger.ts";

const logger = createLogger("bot:commands");

const commands = [
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("セッションのコンテキストをクリア"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("セッションの状態を表示"),

  new SlashCommandBuilder()
    .setName("tools")
    .setDescription("許可されたツール一覧を表示")
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("動的ツール許可をクリア"),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("許可されたツール一覧を表示"),
    ),

  new SlashCommandBuilder()
    .setName("new")
    .setDescription("新しいスレッドとセッションを作成")
    .addStringOption((option) =>
      option.setName("title").setDescription("スレッドタイトル").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("path").setDescription("セッションの作業ディレクトリ（省略時はデフォルト）").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("cwd")
    .setDescription("作業ディレクトリを表示・変更")
    .addStringOption((option) =>
      option.setName("path").setDescription("変更先のパス（省略時は現在のパスを表示）").setRequired(false),
    ),
];

export async function registerCommands(client: Client): Promise<void> {
  if (!client.application) {
    logger.error("client.application is null — cannot register commands");
    return;
  }

  await client.application.commands.set(commands);
  logger.info(`Registered ${commands.length} application commands`);
}
