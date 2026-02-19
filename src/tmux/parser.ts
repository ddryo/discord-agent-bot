import type { OutputEvent, ToolApprovalInfo, AskUserInfo } from "../types.ts";

/**
 * ANSI エスケープシーケンスを除去する
 */
export function stripAnsi(text: string): string {
  // ESC[ ... m (SGR), ESC[ ... letter (CSI全般), ESC] ... BEL/ST (OSC), ESC( (文字セット)
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\(./g,
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
 * ツール許可待ちパターンを検出する
 *
 * Claude CLI のツール許可待ち出力パターン:
 * ```
 * ─── Tool Use ──────────────────
 * Tool: Bash
 *   command: npm install
 *
 * Do you want to proceed?
 *   1. Yes
 *   2. Yes, and don't ask again for this tool
 *   3. No
 *
 * (Use arrow keys or type your choice)
 * >
 * ```
 */
export function detectToolApproval(cleanText: string): ToolApprovalInfo | null {
  // "Do you want to proceed?" が含まれているか確認
  if (!/Do you want to proceed\?/i.test(cleanText)) {
    return null;
  }

  const lines = cleanText.split("\n");

  // ツール名を抽出（"Tool: XXX" パターン）
  let tool = "";
  const descriptionLines: string[] = [];
  let foundTool = false;

  for (const line of lines) {
    const toolMatch = line.match(/^\s*Tool:\s*(.+)$/);
    if (toolMatch) {
      tool = toolMatch[1]!.trim();
      foundTool = true;
      continue;
    }
    // Tool行の後、空行またはDo you want行までを説明として取得
    if (foundTool && !/Do you want to proceed\?/i.test(line)) {
      const trimmed = line.trim();
      if (trimmed) {
        descriptionLines.push(trimmed);
      } else if (descriptionLines.length > 0) {
        // 空行が来たら説明の収集を終了
        break;
      }
    }
    if (/Do you want to proceed\?/i.test(line)) {
      break;
    }
  }

  if (!tool) {
    return null;
  }

  // 選択肢を抽出（"Do you want to proceed?" より後の番号付き行のみ）
  const options: string[] = [];
  const optionRegex = /^\s*(\d+)\.\s+(.+)$/;
  let afterPrompt = false;
  for (const line of lines) {
    if (/Do you want to proceed\?/i.test(line)) {
      afterPrompt = true;
      continue;
    }
    if (afterPrompt) {
      const optMatch = line.match(optionRegex);
      if (optMatch) {
        options.push(optMatch[2]!.trim());
      }
    }
  }

  return {
    tool,
    description: descriptionLines.length > 0 ? descriptionLines.join("\n") : undefined,
    options,
  };
}

/**
 * AskUserQuestion パターンを検出する
 *
 * Claude CLI の AskUserQuestion 出力パターン:
 * ```
 *   ? Which option do you prefer?
 *     1. Option A
 *     2. Option B
 *     3. Other
 *
 * (Use arrow keys or type your choice)
 * >
 * ```
 */
export function detectAskUser(cleanText: string): AskUserInfo | null {
  const lines = cleanText.split("\n");

  // "?" で始まる質問行を検出
  let question = "";
  for (const line of lines) {
    const questionMatch = line.match(/^\s*\?\s+(.+)$/);
    if (questionMatch) {
      question = questionMatch[1]!.trim();
      break;
    }
  }

  if (!question) {
    return null;
  }

  // "(Use arrow keys or type your choice)" が含まれているか確認
  // これがないと通常のテキスト出力と誤検知する可能性がある
  if (!/\(Use arrow keys or type your choice\)/i.test(cleanText)) {
    return null;
  }

  // 選択肢を抽出（番号付き行）
  const options: string[] = [];
  const optionRegex = /^\s*(\d+)\.\s+(.+)$/;
  let foundQuestion = false;
  for (const line of lines) {
    if (/^\s*\?\s+/.test(line)) {
      foundQuestion = true;
      continue;
    }
    if (foundQuestion) {
      const optMatch = line.match(optionRegex);
      if (optMatch) {
        options.push(optMatch[2]!.trim());
      }
    }
  }

  return {
    question,
    options: options.length > 0 ? options : undefined,
  };
}

/**
 * raw テキストを OutputEvent 配列に変換する
 *
 * 検出パターン:
 * - tool_approval: ツール許可待ち（最優先）
 * - ask_user: AskUserQuestion
 * - session_end: セッション終了
 * - idle: 入力待ちプロンプト
 * - text: 上記以外の通常テキスト
 */
export function parseOutput(rawText: string): OutputEvent[] {
  const cleanText = stripAnsi(rawText);
  const now = new Date();
  const events: OutputEvent[] = [];

  if (!cleanText.trim()) {
    return events;
  }

  // 優先順位: tool_approval > ask_user > session_end > idle > text
  const toolApproval = detectToolApproval(cleanText);
  if (toolApproval) {
    events.push({
      type: "tool_approval",
      content: cleanText,
      raw: rawText,
      timestamp: now,
      metadata: toolApproval,
    });
    return events;
  }

  const askUser = detectAskUser(cleanText);
  if (askUser) {
    events.push({
      type: "ask_user",
      content: cleanText,
      raw: rawText,
      timestamp: now,
      metadata: askUser,
    });
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

    // session_end を idle より優先（同時検出時はセッション終了として扱う）
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
