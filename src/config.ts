import { homedir } from "os";
import type { Config } from "./types.ts";

export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

function loadConfig(): Config {
  const discordBotToken = process.env["DISCORD_BOT_TOKEN"];
  const discordChannelId = process.env["DISCORD_CHANNEL_ID"];

  if (!discordBotToken) {
    console.error("DISCORD_BOT_TOKEN is required but not set.");
    process.exit(1);
  }

  if (!discordChannelId) {
    console.error("DISCORD_CHANNEL_ID is required but not set.");
    process.exit(1);
  }

  const discordUserId = process.env["DISCORD_USER_ID"] || undefined;
  const defaultCwd = expandTilde(
    process.env["DEFAULT_CWD"] || "~/Desktop"
  );
  const allowedToolsRaw = process.env["ALLOWED_TOOLS"] || "";
  const allowedTools = allowedToolsRaw
    ? allowedToolsRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    discordBotToken,
    discordChannelId,
    discordUserId,
    defaultCwd,
    allowedTools,
  };
}

export const config = loadConfig();

/**
 * ユーザーが操作を許可されているか確認する。
 * DISCORD_USER_ID 未設定時は全員許可。
 */
export function isAuthorizedUser(userId: string): boolean {
  if (!config.discordUserId) return true;
  return userId === config.discordUserId;
}
