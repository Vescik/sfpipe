import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as realExec, type Exec, type ExecResult } from '../src/core/exec.js';
import type { Io } from '../src/io.js';

export const TEMPLATE_PATH = fileURLToPath(new URL('../templates/config.yml', import.meta.url));

export const readTemplate = () => readFile(TEMPLATE_PATH, 'utf8');

export function tempDir(prefix = 'sfpipe-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

type Responder = ExecResult | ((args: string[]) => ExecResult);

/** Exec double keyed by "command arg1 arg2 …" prefixes; unmatched commands fall through. */
export function fakeExec(responses: Record<string, Responder>, fallback: Exec = realExec): Exec & { calls: string[] } {
  const calls: string[] = [];
  const fn: Exec = async (command, args, options) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    const match = Object.keys(responses)
      .filter((prefix) => key.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (match === undefined) return fallback(command, args, options);
    const responder = responses[match]!;
    return typeof responder === 'function' ? responder(args) : responder;
  };
  return Object.assign(fn, { calls });
}

export const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
export const fail = (stdout = '', stderr = 'error', code = 1): ExecResult => ({ code, stdout, stderr });

export function captureIo(overrides: Partial<Io> = {}): Io & { stdout: string[]; stderr: string[]; exitCode?: number } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout,
    stderr,
    exitCode: undefined as number | undefined,
    out: (text: string) => void stdout.push(text),
    err: (text: string) => void stderr.push(text),
    setExitCode(code: number) {
      io.exitCode = code;
    },
    color: false,
    env: {},
    exec: realExec,
    fetch: (() => Promise.reject(new Error('fetch not stubbed'))) as typeof fetch,
    ...overrides,
  };
  return io;
}

export function git(cwd: string, ...args: string[]) {
  return realExec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
  }).then((result) => {
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  });
}

/** Minimal JSON response for fetch stubs. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
