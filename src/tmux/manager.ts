import { createLogger } from "../logger.ts";

const logger = createLogger("tmux");

const SESSION_PREFIX = "ccbot-";

async function runTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`tmux ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  return stdout;
}

export async function createSession(name: string, cwd: string): Promise<void> {
  const sessionName = `${SESSION_PREFIX}${name}`;
  logger.info(`Creating tmux session: ${sessionName} (cwd: ${cwd})`);
  await runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    cwd,
    "--",
    "claude",
  ]);
}

export async function killSession(name: string): Promise<void> {
  const sessionName = `${SESSION_PREFIX}${name}`;
  logger.info(`Killing tmux session: ${sessionName}`);
  try {
    await runTmux(["kill-session", "-t", sessionName]);
  } catch (error) {
    logger.warn(`Failed to kill session ${sessionName}: ${error}`);
  }
}

export async function sendInput(name: string, text: string): Promise<void> {
  const sessionName = `${SESSION_PREFIX}${name}`;
  await runTmux(["send-keys", "-t", sessionName, "-l", "--", text]);
  await runTmux(["send-keys", "-t", sessionName, "Enter"]);
}

export async function sendKeys(name: string, keys: string): Promise<void> {
  const sessionName = `${SESSION_PREFIX}${name}`;
  await runTmux(["send-keys", "-t", sessionName, keys]);
}

export async function capturePane(
  name: string,
  lines: number = 200,
): Promise<string> {
  const sessionName = `${SESSION_PREFIX}${name}`;
  return await runTmux([
    "capture-pane",
    "-p",
    "-t",
    sessionName,
    "-S",
    `-${lines}`,
  ]);
}

export async function hasSession(name: string): Promise<boolean> {
  const sessionName = `${SESSION_PREFIX}${name}`;
  try {
    await runTmux(["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function listSessions(): Promise<string[]> {
  try {
    const output = await runTmux([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    return output
      .trim()
      .split("\n")
      .filter((name) => name.startsWith(SESSION_PREFIX));
  } catch {
    return [];
  }
}
