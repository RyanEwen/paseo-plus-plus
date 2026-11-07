import { execFileSync } from "node:child_process";

/**
 * Choose how to start npm on a platform.
 *
 * Windows ships npm as `npm.cmd`, which child_process can start only through a shell. Shell mode
 * concatenates argv without escaping, so callers must pass literal arguments only.
 */
export function npmInvocation(platform = process.platform) {
  const isWindows = platform === "win32";
  return { command: isWindows ? "npm.cmd" : "npm", shell: isWindows };
}

/**
 * Run npm synchronously with execFileSync on this platform.
 * `options` are passed to execFileSync unchanged; the platform's shell setting is applied first.
 * Returns execFileSync's result and throws when npm exits with a failure.
 */
export function runNpm(args, options = {}) {
  const { command, shell } = npmInvocation();
  return execFileSync(command, args, { shell, ...options });
}
