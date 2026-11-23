import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** Runs a command without a shell. Never rejects: failures are reported through `code`. */
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const isWindows = process.platform === 'win32';

/** npm-installed CLIs are `.cmd` shims on Windows and need a shell to run. */
const WINDOWS_SHIMS = new Set(['sf', 'npm', 'npx']);

function quoteForCmd(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const useShell = isWindows && WINDOWS_SHIMS.has(command);
    const file = useShell ? `${command}.cmd` : command;
    const finalArgs = useShell ? args.map(quoteForCmd) : args;
    execFile(
      file,
      finalArgs,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 256 * 1024 * 1024,
        shell: useShell,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: `Nie znaleziono polecenia: ${command}` });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || error.message });
      },
    );
  });
