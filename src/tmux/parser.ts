import type { OutputEvent, OutputEventType } from "../types.ts";

/**
 * ANSI エスケープシーケンスを除去する
 */
export function stripAnsi(text: string): string {
  // ESC[ ... m (SGR), ESC[ ... letter (CSI全般), ESC] ... BEL/ST (OSC), ESC( (文字セット)
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\(./g,
    "",
  );
}

/**
 * Claude CLI の入力待ちプロンプトを検出する
 *
 * Claude CLI は入力待ち状態のとき、行末に `>` や `> ` のプロンプトを表示する。
 */
function detectIdlePrompt(cleanText: string): boolean {
  const lines = cleanText.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // 典型的なプロンプトパターン:
  // - ">" 単体
  // - "> " (末尾スペース含む)
  // - "╰─ >" や類似のボックスドロー文字付きプロンプト
  if (/^[╰└\-─]*\s*>\s*$/.test(lastLine)) {
    return true;
  }

  return false;
}

/**
 * セッション終了パターンを検出する
 *
 * Claude CLI 固有の終了メッセージのみを行全体一致で検出する（誤検知を防ぐため部分一致は使わない）
 */
function detectSessionEnd(cleanText: string): boolean {
  const lines = cleanText.trimEnd().split("\n");
  // 末尾数行を対象に検出
  const tailLines = lines.slice(-5);

  for (const line of tailLines) {
    const trimmed = line.trim();
    // Claude CLI が終了時に表示する定型メッセージ（行全体一致）
    if (/^(Goodbye!|Session ended\.|Exiting\.\.\.)$/i.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * raw テキストを OutputEvent 配列に変換する
 *
 * M1 では以下のパターンのみ検出:
 * - idle: 入力待ちプロンプト
 * - session_end: セッション終了
 * - text: 上記以外の通常テキスト
 */
export function parseOutput(rawText: string): OutputEvent[] {
  const cleanText = stripAnsi(rawText);
  const now = new Date();
  const events: OutputEvent[] = [];

  if (!cleanText.trim()) {
    return events;
  }

  // 本文テキストと状態を分離して複数イベントを返す
  const isSessionEnd = detectSessionEnd(cleanText);
  const isIdle = detectIdlePrompt(cleanText);

  // 本文抽出: 状態行（プロンプト行等）を除いたテキスト部分
  if (isIdle || isSessionEnd) {
    const lines = cleanText.trimEnd().split("\n");
    // 末尾のプロンプト/状態行を除いた本文
    const bodyLines: string[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      bodyLines.push(lines[i]!);
    }
    const bodyText = bodyLines.join("\n").trim();

    if (bodyText) {
      events.push({
        type: "text",
        content: bodyText,
        raw: rawText,
        timestamp: now,
      });
    }

    events.push({
      type: isSessionEnd ? "session_end" : "idle",
      content: lines[lines.length - 1] ?? "",
      raw: rawText,
      timestamp: now,
    });
  } else {
    events.push({
      type: "text",
      content: cleanText,
      raw: rawText,
      timestamp: now,
    });
  }

  return events;
}
