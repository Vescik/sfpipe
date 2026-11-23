import { exec, type Exec } from './core/exec.js';

/** Everything a command touches outside its arguments, so tests can replace it. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  setExitCode(code: number): void;
  color: boolean;
  env: NodeJS.ProcessEnv;
  exec: Exec;
  fetch: typeof fetch;
}

export function defaultIo(): Io {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    env: process.env,
    exec,
    fetch: globalThis.fetch,
  };
}
