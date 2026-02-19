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
 */
function detectSessionEnd(cleanText: string): boolean {
  const lines = cleanText.trimEnd().split("\n");
  // 末尾数行を対象に検出
  const tail = lines.slice(-5).join("\n");

  // セッション終了の典型的なパターン
  if (/session\s+ended|goodbye|exiting/i.test(tail)) {
    return true;
  }

  // シェルプロンプトに戻った場合（claude CLI が終了した兆候）
  if (/\$\s*$/.test(lines[lines.length - 1]?.trim() ?? "")) {
    return true;
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

  // 状態検出（優先度順）
  let type: OutputEventType = "text";

  if (detectSessionEnd(cleanText)) {
    type = "session_end";
  } else if (detectIdlePrompt(cleanText)) {
    type = "idle";
  }

  events.push({
    type,
    content: cleanText,
    raw: rawText,
    timestamp: now,
  });

  return events;
}
