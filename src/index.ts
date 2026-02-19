import { type TextChannel, type ThreadChannel } from "discord.js";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { sessionStore } from "./sessions/store.ts";
import { createDiscordClient } from "./bot/client.ts";
import { handleMessage, handleThreadCreate, setWatcher } from "./bot/handler.ts";
import { sendToDiscord } from "./bot/responder.ts";
import { handleInteraction, sendToolApproval } from "./bot/interactions.ts";
import type { ToolApprovalInfo } from "./types.ts";
import { createSession, hasSession, killSession } from "./tmux/manager.ts";
import { OutputWatcher } from "./tmux/watcher.ts";
import type { OutputEvent } from "./types.ts";

const logger = createLogger("main");

const MAIN_SESSION_NAME = "main";

async function main(): Promise<void> {
  logger.info("Starting discord-agent-bot...");

  // 1. Discord クライアント初期化
  const discord = createDiscordClient();

  // 2. メインセッション作成（既存セッションがあれば再作成）
  const sessionExists = await hasSession(MAIN_SESSION_NAME);
  if (sessionExists) {
    logger.warn("Existing main session found, killing and recreating...");
    await killSession(MAIN_SESSION_NAME);
  }
  logger.info(`Creating main session (cwd: ${config.defaultCwd})`);
  await createSession(MAIN_SESSION_NAME, config.defaultCwd);

  // 3. SessionStore にメインセッションを登録
  // メインセッションは await createSession() 後に登録するため readyPromise は不要
  sessionStore.registerSession(null, {
    name: MAIN_SESSION_NAME,
    cwd: config.defaultCwd,
    threadId: null,
    isMain: true,
  });

  // 4. OutputWatcher を作成（ログイン後に監視開始）
  const watcher = new OutputWatcher();

  // handler.ts から watcher を利用できるよう設定
  setWatcher(watcher);

  // 5. messageCreate で handler を呼ぶ
  discord.onMessage((message) => {
    void handleMessage(message);
  });

  // 6. threadCreate でスレッドセッションを起動
  discord.onThreadCreate((thread, newlyCreated) => {
    void handleThreadCreate(thread, newlyCreated, watcher);
  });

  // 6.5. interactionCreate でボタン応答を処理
  discord.onInteraction((interaction) => {
    void handleInteraction(interaction);
  });

  // 7. Discord クライアントにログイン
  await discord.login();

  // 8. OutputWatcher の "output" イベントで Discord に投稿
  //    ログイン後に登録し、チャンネルキャッシュが利用可能な状態で動作させる
  watcher.on("output", (sessionName: string, events: OutputEvent[]) => {
    void (async () => {
      let target: TextChannel | ThreadChannel | undefined;

      if (sessionName === MAIN_SESSION_NAME) {
        // メインセッション → メインチャンネル
        target = discord.client.channels.cache.get(
          config.discordChannelId,
        ) as TextChannel | undefined;
      } else {
        // スレッドセッション → sessionName から threadId を特定
        const session = sessionStore.getSessionByName(sessionName);
        if (session?.threadId) {
          target = discord.client.channels.cache.get(
            session.threadId,
          ) as ThreadChannel | undefined;
        }
      }

      if (!target) {
        logger.error(`Target channel not found for session: ${sessionName}`);
        return;
      }

      for (const event of events) {
        if (event.type === "text" && event.content) {
          await sendToDiscord(target, event.content);
        } else if (event.type === "tool_approval" && event.metadata) {
          await sendToolApproval(target, sessionName, event.metadata as ToolApprovalInfo);
        }
        // TODO(M3): ask_user → 質問 + 選択肢で通知・応答処理
        // TODO(M3): session_end → セッション終了通知
        // TODO(M3): error → エラー通知
      }
    })();
  });

  // 9. メインセッションの監視開始（ログイン完了後に開始）
  watcher.watch(MAIN_SESSION_NAME);

  logger.info("Bot is ready");
}

main().catch((error: unknown) => {
  logger.error(`Fatal error: ${String(error)}`);
  process.exit(1);
});
