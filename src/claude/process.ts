import { EventEmitter } from "events";
import { createLogger } from "../logger.ts";

const logger = createLogger("claude:process");

// stream-json イベント型（内部用）
interface SystemEvent {
  type: "system";
  subtype?: string;
  session_id?: string;
}

interface AssistantEvent {
  type: "assistant";
  message: {
    content: ContentBlock[];
  };
}

interface UserEvent {
  type: "user";
  message: {
    content: ContentBlock[];
  };
}

interface ResultEvent {
  type: "result";
  result: string;
  usage?: { input_tokens: number; output_tokens: number };
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type StreamEvent = SystemEvent | AssistantEvent | UserEvent | ResultEvent;

export interface ClaudeProcessEvents {
  system: [sessionId: string];
  text: [text: string];
  toolUse: [name: string, input: Record<string, unknown>, id: string];
  toolBlocked: [toolName: string, toolInput: Record<string, unknown>, errorContent: string];
  askUser: [question: string, options: string[], toolUseId: string];
  result: [fullText: string, usage: { inputTokens: number; outputTokens: number }];
  error: [message: string];
  exit: [exitCode: number];
}

export interface ClaudeProcessOptions {
  cwd: string;
  sessionId?: string;
  allowedTools?: string[];
}

/**
 * claude -p プロセスの起動、stream-json stdout パース、イベント発火を行う。
 */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private proc: ReturnType<typeof Bun.spawn> | null = null;

  constructor(private readonly options: ClaudeProcessOptions) {
    super();
  }

  private buildArgs(): string[] {
    const args = [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
    ];

    if (this.options.sessionId) {
      args.push("--resume", this.options.sessionId);
    }

    if (this.options.allowedTools) {
      for (const tool of this.options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    return args;
  }

  /**
   * プロセスを起動し、プロンプトを送信する。
   * result または exit イベントで完了を通知する。
   */
  run(prompt: string): void {
    const args = this.buildArgs();
    logger.info(`Spawning: ${args.join(" ")} (cwd: ${this.options.cwd})`);
    logger.debug(`Prompt: ${prompt.substring(0, 100)}`);

    this.proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.options.cwd,
      env: { ...process.env },
    });

    // プロンプトを stdin 経由で送信
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(prompt);
    stdin.end();

    // stdout/stderr のパースを開始
    const stdoutDone = this.readStdout();
    const stderrDone = this.readStderr();

    // stdout/stderr の読み取り完了を待ってから exit を通知（レースコンディション防止）
    void this.proc.exited.then(async (exitCode) => {
      await stdoutDone;
      await stderrDone;
      this.emit("exit", exitCode);
    });
  }

  /**
   * 実行中のプロセスを強制終了する。
   */
  kill(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private async readStdout(): Promise<void> {
    if (!this.proc?.stdout) return;

    const decoder = new TextDecoder();
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    // result 到着前までの全テキストを蓄積
    let fullText = "";
    // 直近の tool_use を記憶（toolBlocked 検出用）
    let lastToolUse: { name: string; input: Record<string, unknown>; id: string } | null = null;
    // system イベントの重複発火防止
    let systemEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(line) as StreamEvent;
          } catch {
            logger.warn(`Failed to parse stream-json line: ${line.substring(0, 100)}`);
            continue;
          }

          // system イベントは最初の1回だけ emit する（--verbose で複数回発火するため）
          if (event.type === "system" && event.session_id) {
            if (!systemEmitted) {
              systemEmitted = true;
              this.emit("system", event.session_id);
            }
            continue;
          }

          this.handleEvent(event, { fullText, lastToolUse }, (updates) => {
            if (updates.fullText !== undefined) fullText = updates.fullText;
            if (updates.lastToolUse !== undefined) lastToolUse = updates.lastToolUse;
          });
        }
      }
    } catch (error) {
      logger.error(`stdout read error: ${String(error)}`);
    }
  }

  private handleEvent(
    event: StreamEvent,
    state: { fullText: string; lastToolUse: { name: string; input: Record<string, unknown>; id: string } | null },
    update: (updates: { fullText?: string; lastToolUse?: { name: string; input: Record<string, unknown>; id: string } | null }) => void,
  ): void {
    switch (event.type) {
      case "system": {
        if (event.session_id) {
          this.emit("system", event.session_id);
        }
        break;
      }

      case "assistant": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === "text") {
            this.emit("text", block.text);
            update({ fullText: state.fullText + block.text });
          } else if (block.type === "tool_use") {
            if (block.name === "AskUserQuestion") {
              const input = block.input as { question?: string; options?: Array<{ label: string }> };
              const question = input.question ?? "";
              const options = (input.options ?? []).map((o) => o.label);
              this.emit("askUser", question, options, block.id);
            } else {
              this.emit("toolUse", block.name, block.input, block.id);
              update({ lastToolUse: { name: block.name, input: block.input, id: block.id } });
            }
          }
        }
        break;
      }

      case "user": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === "tool_result" && block.is_error) {
            const toolName = state.lastToolUse?.name ?? "unknown";
            const toolInput = state.lastToolUse?.input ?? {};
            this.emit("toolBlocked", toolName, toolInput, block.content);
            update({ lastToolUse: null });
          }
        }
        break;
      }

      case "result": {
        const usage = event.usage ?? { input_tokens: 0, output_tokens: 0 };
        this.emit("result", state.fullText, {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        });
        break;
      }
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.proc?.stderr) return;

    const decoder = new TextDecoder();
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim()) {
            logger.debug(`[stderr] ${line}`);
          }
        }
      }
    } catch (error) {
      logger.error(`stderr read error: ${String(error)}`);
    }
  }
}
