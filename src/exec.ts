import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export const run: Run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });

export async function runOk(
  runner: Run,
  command: string,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  const result = await runner(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}
