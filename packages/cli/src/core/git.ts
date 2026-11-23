import type { Exec } from './exec.js';

export class Git {
  constructor(
    private readonly exec: Exec,
    readonly cwd: string,
  ) {}

  private run(args: string[]) {
    return this.exec('git', args, { cwd: this.cwd });
  }

  async version(): Promise<string | undefined> {
    const result = await this.run(['--version']);
    return result.code === 0 ? /(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)?.[1] : undefined;
  }

  async root(): Promise<string | undefined> {
    const result = await this.run(['rev-parse', '--show-toplevel']);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async remoteUrl(remote = 'origin'): Promise<string | undefined> {
    const result = await this.run(['remote', 'get-url', remote]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /** Branch names on the remote, or undefined when the remote cannot be reached. */
  async remoteBranches(remote = 'origin'): Promise<Set<string> | undefined> {
    const result = await this.run(['ls-remote', '--heads', remote]);
    if (result.code !== 0) return undefined;
    const names = result.stdout
      .split('\n')
      .map((line) => line.split('\t')[1]?.trim())
      .filter((ref): ref is string => !!ref && ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length));
    return new Set(names);
  }

  async refExists(ref: string): Promise<boolean> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return result.code === 0;
  }

  /** True when `ancestor` is reachable from `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.run(['merge-base', '--is-ancestor', ancestor, descendant]);
    return result.code === 0;
  }
}

/** Compares dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
