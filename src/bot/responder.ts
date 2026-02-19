import type { TextChannel, ThreadChannel } from "discord.js";
import { createLogger } from "../logger.ts";

const logger = createLogger("bot:responder");

const DISCORD_MAX_LENGTH = 2000;
const CODE_FENCE_RESERVE = 5; // コードブロック閉じ補正の余裕分（"\n```\n" 等）
const RATE_LIMIT_DELAY_MS = 500; // 連続投稿時の遅延

/**
 * Discord チャンネルまたはスレッドにテキストを投稿する。
 * 2000 文字を超える場合は分割して投稿する。
 */
export async function sendToDiscord(
  channel: TextChannel | ThreadChannel,
  content: string,
): Promise<void> {
  if (!content.trim()) {
    return;
  }

  const chunks = splitMessage(content);

  for (let i = 0; i < chunks.length; i++) {
    try {
      await channel.send(chunks[i]!);
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryAfter = extractRetryAfter(error) ?? 2000;
        logger.warn(`Rate limited, retrying after ${retryAfter}ms`);
        await sleep(retryAfter);
        try {
          await channel.send(chunks[i]!);
        } catch (retryError) {
          logger.error(`Failed to send message after retry: ${String(retryError)}`);
        }
      } else {
        logger.error(`Failed to send message: ${String(error)}`);
      }
    }
    // 2チャンク以上の場合、連続投稿間に遅延を挿入
    if (i < chunks.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    return (error as { status: number }).status === 429;
  }
  return false;
}

function extractRetryAfter(error: unknown): number | null {
  if (error && typeof error === "object" && "retryAfter" in error) {
    const val = (error as { retryAfter: unknown }).retryAfter;
    if (typeof val === "number") return val * 1000; // 秒をmsに変換
  }
  return null;
}

/**
 * メッセージを Discord の 2000 文字制限に合わせて分割する。
 * コードブロックが途中で切れないよう考慮する。
 */
export function splitMessage(content: string): string[] {
  if (content.length <= DISCORD_MAX_LENGTH) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // コードブロック補正分を見込んで上限を縮小
    const openFences = countCodeFences(remaining.slice(0, DISCORD_MAX_LENGTH));
    const effectiveMax = openFences % 2 !== 0
      ? DISCORD_MAX_LENGTH - CODE_FENCE_RESERVE
      : DISCORD_MAX_LENGTH;

    let splitIndex = findSplitIndex(remaining, effectiveMax);
    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    // コードブロックの整合性を処理
    const result = fixCodeBlocks(chunk, remaining);
    chunk = result.chunk;
    remaining = result.remaining;

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * 分割位置を決定する。
 * 改行位置で分割し、コードブロック途中の分割を可能な限り回避する。
 */
function findSplitIndex(text: string, maxLen: number = DISCORD_MAX_LENGTH): number {
  // 改行位置で分割を試みる（後方から探す）
  const searchRange = text.slice(0, maxLen);
  const lastNewline = searchRange.lastIndexOf("\n");

  if (lastNewline > maxLen * 0.5) {
    return lastNewline + 1;
  }

  // 改行が見つからない、または極端に前方の場合は maxLen で切る
  return maxLen;
}

/**
 * コードブロック（```）が途中で切れている場合の補正。
 * - 開いたままのコードブロックには閉じタグを付加
 * - 次のチャンクにはそのコードブロックの開きタグを付加
 */
function fixCodeBlocks(
  chunk: string,
  remaining: string,
): { chunk: string; remaining: string } {
  const openCount = countCodeFences(chunk);

  // 奇数個 = コードブロックが開いたまま
  if (openCount % 2 !== 0) {
    // 最後に開いたコードブロックの言語指定を取得
    const lang = findLastOpenFenceLang(chunk);
    const fence = "```";

    chunk = chunk + "\n" + fence;
    remaining = fence + lang + "\n" + remaining;
  }

  return { chunk, remaining };
}

/**
 * テキスト内のコードフェンス（```）の数を数える。
 */
function countCodeFences(text: string): number {
  const matches = text.match(/^\s*```/gm);
  return matches ? matches.length : 0;
}

/**
 * 最後に開かれたコードフェンスの言語指定を返す。
 */
function findLastOpenFenceLang(text: string): string {
  const lines = text.split("\n");
  let openLang = "";
  let isOpen = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!isOpen) {
        // 開きフェンス: 言語指定を抽出
        const langMatch = line.match(/^\s*```(\S*)/);
        openLang = langMatch?.[1] ?? "";
        isOpen = true;
      } else {
        // 閉じフェンス
        openLang = "";
        isOpen = false;
      }
    }
  }

  return openLang;
}
