import type { Exec } from './exec.js';

export interface OrgInfo {
  username: string;
  instanceUrl: string;
  connectedStatus: string;
}

export type OrgDisplayResult = { ok: true; org: OrgInfo } | { ok: false; message: string };

/**
 * sf wraps flag errors as "Parsing --target-org \n\t<real reason>\nSee more help with --help";
 * keep only the real reason.
 */
export function cleanSfMessage(message: string): string {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Parsing --\S+$/.test(line) && !/^See more help with --help/.test(line));
  return lines[0] ?? message.trim();
}

/** Extracts the JSON document from `sf --json` output, tolerating stray lines before it. */
export function parseSfJson(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

export class SfCli {
  constructor(
    private readonly exec: Exec,
    private readonly cwd?: string,
  ) {}

  private run(args: string[], timeoutMs?: number) {
    return this.exec('sf', args, { cwd: this.cwd, timeoutMs });
  }

  async version(): Promise<string | undefined> {
    const result = await this.run(['--version']);
    return result.code === 0 ? /@salesforce\/cli\/(\S+)/.exec(result.stdout)?.[1] : undefined;
  }

  async plugins(): Promise<Map<string, string> | undefined> {
    const result = await this.run(['plugins', '--json']);
    if (result.code !== 0) return undefined;
    const parsed = parseSfJson(result.stdout);
    const list = Array.isArray(parsed) ? parsed : (parsed as { result?: unknown } | undefined)?.result;
    if (!Array.isArray(list)) return undefined;
    const plugins = new Map<string, string>();
    for (const item of list) {
      if (item && typeof item === 'object' && 'name' in item) {
        plugins.set(String(item.name), String((item as { version?: unknown }).version ?? ''));
      }
    }
    return plugins;
  }

  /**
   * Checks the stored authorization for an org alias. The raw output contains an access
   * token, so only the fields below leave this method.
   */
  async orgDisplay(alias: string): Promise<OrgDisplayResult> {
    const result = await this.run(['org', 'display', '--target-org', alias, '--json'], 90_000);
    const parsed = parseSfJson(result.stdout) as
      | { status?: number; message?: string; result?: Record<string, unknown> }
      | undefined;
    if (result.code !== 0 || !parsed || parsed.status !== 0 || !parsed.result) {
      const message = parsed?.message ?? (result.stderr.trim() || 'sf org display zakończył się błędem');
      return { ok: false, message: cleanSfMessage(message) };
    }
    const info = parsed.result;
    return {
      ok: true,
      org: {
        username: String(info.username ?? ''),
        instanceUrl: String(info.instanceUrl ?? ''),
        connectedStatus: String(info.connectedStatus ?? ''),
      },
    };
  }

  /** Reads `Organization.IsSandbox`; undefined when the query fails. */
  async isSandbox(alias: string): Promise<boolean | undefined> {
    const result = await this.run(
      ['data', 'query', '--query', 'SELECT IsSandbox FROM Organization', '--target-org', alias, '--json'],
      90_000,
    );
    const parsed = parseSfJson(result.stdout) as
      | { status?: number; result?: { records?: Array<{ IsSandbox?: unknown }> } }
      | undefined;
    const value = parsed?.status === 0 ? parsed.result?.records?.[0]?.IsSandbox : undefined;
    return typeof value === 'boolean' ? value : undefined;
  }
}
