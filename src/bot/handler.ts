import { statSync } from "fs";
import { resolve } from "path";
import type { Message, ThreadChannel } from "discord.js";
import { config, expandTilde } from "../config.ts";
import { createLogger } from "../logger.ts";
import { createSession, hasSession, sendInput } from "../tmux/manager.ts";
import { sessionStore } from "../sessions/store.ts";
import type { OutputWatcher } from "../tmux/watcher.ts";

const logger = createLogger("bot:handler");

const MAIN_SESSION_NAME = "main";

export async function handleMessage(message: Message): Promise<void> {
  // Bot 自身のメッセージは無視
  if (message.author.bot) return;

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

  // メインセッションが存在しなければ作成
  const sessionExists = await hasSession(MAIN_SESSION_NAME);
  if (!sessionExists) {
    logger.info("Main session not found, creating...");
    await createSession(MAIN_SESSION_NAME, config.defaultCwd);
  }

  // Claude CLI にメッセージを送信
  await sendInput(MAIN_SESSION_NAME, text);
}

/**
 * スレッド内メッセージを対応する tmux セッションに振り分ける。
 */
async function handleThreadMessage(message: Message): Promise<void> {
  const thread = message.channel;
  if (!thread.isThread()) return;

  // 対象チャンネルの子スレッドかどうかを確認
  if (thread.parentId !== config.discordChannelId) return;

  const text = message.content.trim();
  if (!text) return;

  const threadId = thread.id;
  const session = sessionStore.getSession(threadId);

  if (!session) {
    logger.warn(`No session found for thread: ${threadId}`);
    await thread.send(
      "エラー: このスレッドに対応するセッションが見つかりません。",
    );
    return;
  }

  // セッション起動完了を待機（createSession 中のレースコンディション防止）
  if (session.readyPromise) {
    try {
      await session.readyPromise;
    } catch {
      logger.warn(`Session failed to start for thread: ${threadId}`);
      await thread.send(
        "エラー: セッションの起動に失敗しました。",
      );
      return;
    }
  }

  logger.info(
    `Thread message from ${message.author.tag} in ${threadId}: ${text.substring(0, 80)}`,
  );

  // 対応する tmux セッションにメッセージを送信
  await sendInput(session.name, text);
}

/**
 * スレッド作成イベントのハンドラ。
 * スレッドタイトルを cwd として新規 tmux セッションを起動する。
 */
export async function handleThreadCreate(
  thread: ThreadChannel,
  newlyCreated: boolean,
  watcher: OutputWatcher,
): Promise<void> {
  // 新規作成でない場合は無視（Bot 再起動時のキャッシュ読み込み等）
  if (!newlyCreated) return;

  // 対象チャンネルの子スレッドかどうかを確認
  if (thread.parentId !== config.discordChannelId) return;

  const threadId = thread.id;
  const rawPath = thread.name;

  logger.info(`Thread created: ${threadId} (title: "${rawPath}")`);

  // スレッドタイトルをパスとして解釈
  const expandedPath = expandTilde(rawPath);
  const resolvedPath = resolve(expandedPath);

  // パスの存在・ディレクトリチェック
  try {
    const stat = statSync(resolvedPath);
    if (!stat.isDirectory()) {
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

  // セッション名: ccbot-{threadId}
  const sessionName = threadId;

  // readyPromise: createSession 完了で resolve される
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  // SessionStore に先行登録（メッセージ到着時のレースコンディション防止）
  sessionStore.registerSession(threadId, {
    name: sessionName,
    cwd: resolvedPath,
    threadId,
    isMain: false,
    readyPromise,
  });

  // tmux セッション作成
  try {
    await createSession(sessionName, resolvedPath);
    resolveReady();
  } catch (error) {
    rejectReady(error);
    // 作成失敗時は先行登録を取り消す
    sessionStore.removeSession(threadId);
    logger.error(`Failed to create session for thread ${threadId}: ${String(error)}`);
    await thread.send(
      `エラー: セッションの作成に失敗しました。\n\`${String(error)}\``,
    );
    return;
  }

  // OutputWatcher で監視開始
  watcher.watch(sessionName);

  // 起動完了メッセージ
  await thread.send(
    `セッションを起動しました。\n作業ディレクトリ: \`${resolvedPath}\``,
  );

  logger.info(`Thread session started: ${sessionName} (cwd: ${resolvedPath})`);
}
