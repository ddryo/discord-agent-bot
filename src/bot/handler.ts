import { stat } from "fs/promises";
import { resolve } from "path";
import type { Message, ThreadChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { config, expandTilde } from "../config.ts";
import { createLogger } from "../logger.ts";
import { createSession, hasSession, killSession, sendInput } from "../tmux/manager.ts";
import { sessionStore } from "../sessions/store.ts";
import type { OutputWatcher } from "../tmux/watcher.ts";
import { getPendingInteraction, clearPendingInteraction, handleAskUserTextResponse } from "./interactions.ts";

const logger = createLogger("bot:handler");

const MAIN_SESSION_NAME = "main";

/** 対応する CLI コマンド一覧 */
const SUPPORTED_COMMANDS = ["clear", "compact", "cost", "context", "status", "model"];

/** watcher への参照（index.ts から setWatcher で設定） */
let watcher: OutputWatcher | null = null;

/**
 * OutputWatcher の参照を設定する。
 * index.ts から呼び出し、handler 内で watcher.unwatch() 等を利用可能にする。
 */
export function setWatcher(w: OutputWatcher): void {
  watcher = w;
}

/**
 * ユーザーが操作を許可されているか確認する。
 * DISCORD_USER_ID 未設定時は全員許可。
 */
export function isAuthorizedUser(userId: string): boolean {
  if (!config.discordUserId) return true;
  return userId === config.discordUserId;
}

/** パストラバーサル防止: システムディレクトリへのセッション作成をブロック */
const BLOCKED_PATHS = ["/", "/etc", "/sys", "/proc", "/dev", "/boot", "/sbin", "/bin", "/usr/sbin", "/usr/bin"];

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

  // メインセッションが存在しなければ再作成・再登録
  const sessionExists = await hasSession(MAIN_SESSION_NAME);
  if (!sessionExists) {
    logger.info("Main session not found, creating...");
    await createSession(MAIN_SESSION_NAME, config.defaultCwd);
    sessionStore.registerSession(null, {
      name: MAIN_SESSION_NAME,
      cwd: config.defaultCwd,
      threadId: null,
      isMain: true,
    });
  }

  // コマンド判定
  if (text.startsWith("/")) {
    await handleCommand(message, MAIN_SESSION_NAME, null, text);
    return;
  }

  // AskUser 待ちの場合はテキスト返答として処理
  if (getPendingInteraction(MAIN_SESSION_NAME) === "ask_user") {
    try {
      await handleAskUserTextResponse(MAIN_SESSION_NAME, text);
    } catch {
      await message.reply("エラー: 回答の送信に失敗しました。再度メッセージを送信してください。");
    }
    return;
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

  // コマンド判定
  if (text.startsWith("/")) {
    await handleCommand(message, session.name, threadId, text);
    return;
  }

  // AskUser 待ちの場合はテキスト返答として処理
  if (getPendingInteraction(session.name) === "ask_user") {
    try {
      await handleAskUserTextResponse(session.name, text);
    } catch {
      await message.reply("エラー: 回答の送信に失敗しました。再度メッセージを送信してください。");
    }
    return;
  }

  // 対応する tmux セッションにメッセージを送信
  await sendInput(session.name, text);
}

/**
 * コマンドを解析し、対応する処理を実行する。
 * @param message - Discord メッセージ
 * @param sessionName - 対象の tmux セッション名
 * @param threadId - スレッドID（メインセッションの場合は null）
 * @param text - メッセージ全文（"/" から始まる）
 */
async function handleCommand(
  message: Message,
  sessionName: string,
  threadId: string | null,
  text: string,
): Promise<void> {
  // コマンド名と引数を分離
  const spaceIndex = text.indexOf(" ");
  const commandName = (spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)).toLowerCase();

  // /exit は特別処理（T-M3-5）
  if (commandName === "exit") {
    await handleExitCommand(message, sessionName, threadId);
    return;
  }

  // 対応コマンドチェック
  if (!SUPPORTED_COMMANDS.includes(commandName)) {
    await message.reply(`未対応のコマンドです: \`/${commandName}\``);
    return;
  }

  logger.info(`Command: /${commandName} (session: ${sessionName})`);

  // CLI にそのまま送信（Claude CLI がスラッシュコマンドとして認識する）
  await sendInput(sessionName, text);

  // /clear の特別処理: 区切り Embed を投稿
  if (commandName === "clear") {
    const embed = new EmbedBuilder()
      .setDescription("--- Context Cleared ---")
      .setColor(0x5865f2)
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  }
}

/**
 * /exit コマンドの処理。tmux セッションを終了し、関連リソースをクリーンアップする。
 */
async function handleExitCommand(
  message: Message,
  sessionName: string,
  threadId: string | null,
): Promise<void> {
  logger.info(`Exit command: session=${sessionName}, threadId=${threadId ?? "main"}`);

  // 待機中インタラクションをクリア
  clearPendingInteraction(sessionName);

  // tmux セッション終了
  await killSession(sessionName);

  // SessionStore からセッション情報を削除
  sessionStore.removeSession(threadId);

  // OutputWatcher の監視を停止
  if (watcher) {
    watcher.unwatch(sessionName);
  }

  // 終了メッセージを Discord に投稿
  const embed = new EmbedBuilder()
    .setDescription("セッションを終了しました。")
    .setColor(0xed4245)
    .setTimestamp();

  await message.reply({ embeds: [embed] });
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

  // 重複セッション作成を防止
  if (sessionStore.getSession(threadId)) {
    logger.warn(`Session already exists for thread: ${threadId}`);
    return;
  }

  const rawPath = thread.name;

  logger.info(`Thread created: ${threadId} (title: "${rawPath}")`);

  // スレッドタイトルをパスとして解釈
  const expandedPath = expandTilde(rawPath);
  const resolvedPath = resolve(expandedPath);

  // システムディレクトリへのアクセスをブロック
  if (BLOCKED_PATHS.includes(resolvedPath)) {
    logger.warn(`Blocked system path: ${resolvedPath}`);
    await thread.send(
      `エラー: システムディレクトリ \`${resolvedPath}\` は使用できません。`,
    );
    return;
  }

  // パスの存在・ディレクトリチェック
  try {
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
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
  // unhandled rejection 防止（handleThreadMessage 側で別途 catch する）
  void readyPromise.catch(() => undefined);

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
