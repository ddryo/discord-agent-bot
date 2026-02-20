import type { TextChannel, ThreadChannel } from "discord.js";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createDiscordClient } from "./bot/client.ts";
import { handleMessage, handleThreadCreate, handleCommandInteraction, setSessionManager } from "./bot/handler.ts";
import { registerCommands } from "./bot/commands.ts";
import { sendToDiscord, sendSessionStartNotification, sendSessionEndNotification } from "./bot/responder.ts";
import { handleInteraction, sendToolBlockedNotification, sendAskUser, clearPendingInteraction, setInteractionSessionManager } from "./bot/interactions.ts";
import { SessionManager } from "./claude/session.ts";
import type { ClaudeSessionInfo } from "./types.ts";

const logger = createLogger("main");

const MAIN_SESSION_NAME = "main";

async function main(): Promise<void> {
  logger.info("Starting discord-agent-bot...");

  // 0. シグナルハンドラを早期登録
  let isShuttingDown = false;
  let sessionMgr: SessionManager | undefined;
  let discord: ReturnType<typeof createDiscordClient> | undefined;

  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down...`);

    try {
      sessionMgr?.killAll();

      if (discord) {
        await discord.destroy();
      }
    } catch (error) {
      logger.error(`Error during shutdown: ${String(error)}`);
    }

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  // 0.5. 起動時ヘルスチェック（claude のみ確認、tmux 不要）
  const claudeVersion = await SessionManager.checkDependencies();
  logger.info(`Dependencies: claude=${claudeVersion}`);

  // 1. Discord クライアント初期化
  discord = createDiscordClient();

  // 2. SessionManager 作成
  sessionMgr = new SessionManager();

  // handler / interactions に SessionManager を設定
  setSessionManager(sessionMgr);
  setInteractionSessionManager(sessionMgr);

  // 3. メインセッション登録（プロセスは起動しない、最初のメッセージで起動）
  const mainSessionInfo: ClaudeSessionInfo = {
    name: MAIN_SESSION_NAME,
    cwd: config.defaultCwd,
    threadId: null,
    isMain: true,
    claudeSessionId: null,
    state: "idle",
    usage: { inputTokens: 0, outputTokens: 0 },
    additionalAllowedTools: new Set(),
  };
  sessionMgr.registerSession(mainSessionInfo);

  // 4. イベントハンドラ登録
  discord.onReady(async () => {
    await registerCommands(discord!.client);
  });

  discord.onMessage((message) => {
    void handleMessage(message);
  });

  discord.onThreadCreate((thread, newlyCreated) => {
    void handleThreadCreate(thread, newlyCreated);
  });

  discord.onInteraction((interaction) => {
    void handleInteraction(interaction);
  });

  // 5. Discord クライアントにログイン
  await discord.login();

  // 6. SessionManager のイベントに基づく Discord 投稿
  const resolveChannel = (sessionName: string): TextChannel | ThreadChannel | undefined => {
    if (sessionName === MAIN_SESSION_NAME) {
      return discord!.client.channels.cache.get(
        config.discordChannelId,
      ) as TextChannel | undefined;
    }
    const session = sessionMgr!.getSessionByThreadId(sessionName);
    if (session?.threadId) {
      return discord!.client.channels.cache.get(
        session.threadId,
      ) as ThreadChannel | undefined;
    }
    // sessionName が threadId そのもののケース
    return discord!.client.channels.cache.get(
      sessionName,
    ) as ThreadChannel | undefined;
  };

  // Typing indicator 管理
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  const startTyping = (sessionName: string) => {
    stopTyping(sessionName);
    const channel = resolveChannel(sessionName);
    if (!channel) return;
    channel.sendTyping().catch(() => {});
    const interval = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 8_000);
    typingIntervals.set(sessionName, interval);
  };

  const stopTyping = (sessionName: string) => {
    const interval = typingIntervals.get(sessionName);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(sessionName);
    }
  };

  sessionMgr.on("processing", (sessionName) => {
    startTyping(sessionName);
  });

  sessionMgr.on("idle", (sessionName) => {
    stopTyping(sessionName);
  });

  sessionMgr.on("response", (sessionName, text, usage) => {
    void (async () => {
      const channel = resolveChannel(sessionName);
      if (!channel) {
        logger.error(`Target channel not found for session: ${sessionName}`);
        return;
      }
      if (text.trim()) {
        await sendToDiscord(channel, text);
      }
      const preview = text.length > 300 ? text.substring(0, 300) + "..." : text;
      logger.info(`Claude response: session=${sessionName}\n${preview}`);
      logger.info(`Token usage: input=${usage.inputTokens}, output=${usage.outputTokens}`);
    })();
  });

  sessionMgr.on("toolUse", (sessionName, toolName, toolInput) => {
    // ツール実行はログのみ（Discord 通知は toolBlocked / result で行う）
    const inputSummary = JSON.stringify(toolInput).substring(0, 200);
    logger.info(`Tool use: session=${sessionName}, tool=${toolName}, input=${inputSummary}`);
  });

  sessionMgr.on("toolBlocked", (sessionName, toolName, toolInput, _errorContent, bufferedText) => {
    void (async () => {
      const channel = resolveChannel(sessionName);
      if (!channel) return;
      // toolBlocked 前の蓄積テキストがあれば先に配信
      if (bufferedText.trim()) {
        await sendToDiscord(channel, bufferedText);
      }
      await sendToolBlockedNotification(channel, sessionName, toolName, toolInput);
    })();
  });

  sessionMgr.on("askUser", (sessionName, question, options) => {
    void (async () => {
      const channel = resolveChannel(sessionName);
      if (!channel) return;
      await sendAskUser(channel, sessionName, question, options);
    })();
  });

  sessionMgr.on("error", (sessionName, message) => {
    void (async () => {
      const channel = resolveChannel(sessionName);
      if (!channel) {
        logger.error(`Error for session ${sessionName}: ${message}`);
        return;
      }
      await sendToDiscord(channel, `**Error:** ${message}`);
    })();
  });

  // 7. メインセッション起動通知
  const mainChannel = discord.client.channels.cache.get(
    config.discordChannelId,
  ) as TextChannel | undefined;
  if (mainChannel) {
    await sendSessionStartNotification(mainChannel, MAIN_SESSION_NAME, config.defaultCwd);
  }

  logger.info("Bot is ready");
}

// Bot 全体のクラッシュ防止
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(`Unhandled rejection: ${String(reason)}`);
});

process.on("uncaughtException", (error: Error) => {
  logger.error(`Uncaught exception: ${error.message}\n${error.stack ?? ""}`);
});

main().catch((error: unknown) => {
  logger.error(`Fatal error: ${String(error)}`);
  process.exit(1);
});
