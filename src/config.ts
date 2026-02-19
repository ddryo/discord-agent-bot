import { homedir } from "os";

interface Config {
  discordBotToken: string;
  discordChannelId: string;
  discordUserId: string | undefined;
  defaultCwd: string;
  pollIntervalMs: number;
}

function expandTilde(path: string): string {
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
  const pollIntervalMs = Number(process.env["POLL_INTERVAL_MS"] || "1500");

  return {
    discordBotToken,
    discordChannelId,
    discordUserId,
    defaultCwd,
    pollIntervalMs,
  };
}

export const config = loadConfig();
