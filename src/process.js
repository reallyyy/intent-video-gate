import { execFile } from "node:child_process";

export function run(command, args, options = {}) {
  const timeout = options.timeoutMs ?? 30000;
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        stdout,
        stderr,
        error: error?.message ?? null
      });
    });
  });
}

export async function commandExists(command) {
  const result = await run("which", [command], { timeoutMs: 5000, maxBuffer: 64 * 1024 });
  return result.ok && result.stdout.trim().length > 0;
}

