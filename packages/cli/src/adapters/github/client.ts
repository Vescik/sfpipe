import { SfpipeError } from '../../core/errors.js';

export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

/** Recognises https, ssh and scp-style GitHub remotes. */
export function parseGitHubRemote(url: string): RepoRef | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) return undefined;
  const [, host, owner, repo] = match as unknown as [string, string, string, string];
  return { host, owner, repo };
}

/** `GITHUB_REPOSITORY` (set in Actions) wins over the origin remote. */
export function resolveRepo(env: NodeJS.ProcessEnv, remoteUrl: string | undefined): RepoRef | undefined {
  if (env.GITHUB_REPOSITORY?.includes('/')) {
    const [owner, repo] = env.GITHUB_REPOSITORY.split('/') as [string, string];
    const host = env.GITHUB_SERVER_URL ? new URL(env.GITHUB_SERVER_URL).host : 'github.com';
    return { host, owner, repo };
  }
  return remoteUrl ? parseGitHubRemote(remoteUrl) : undefined;
}

export function apiUrlFor(ref: RepoRef, env: NodeJS.ProcessEnv): string {
  if (env.GITHUB_API_URL) return env.GITHUB_API_URL.replace(/\/+$/, '');
  return ref.host === 'github.com' ? 'https://api.github.com' : `https://${ref.host}/api/v3`;
}

export function tokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
}

export interface RepoInfo {
  full_name: string;
  default_branch: string;
}

/** One entry of `GET /repos/{owner}/{repo}/rules/branches/{branch}`. */
export interface BranchRule {
  type: string;
  parameters?: Record<string, unknown>;
  ruleset_id?: number;
}

export interface EnvironmentInfo {
  name: string;
  protection_rules?: Array<{ type: string; prevent_self_review?: boolean; reviewers?: unknown[] }>;
  deployment_branch_policy?: { protected_branches: boolean; custom_branch_policies: boolean } | null;
}

export class GitHubClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Returns undefined for 403/404 so callers can report "no access" instead of failing. */
  private async get<T>(apiPath: string): Promise<T | undefined> {
    const response = await this.fetchFn(`${this.apiUrl}${apiPath}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sfpipe-cli',
      },
    });
    if (response.status === 401) {
      throw new SfpipeError('GitHub odrzucił token', 'Sprawdź GH_TOKEN / GITHUB_TOKEN: token musi być ważny');
    }
    if (response.status === 403 || response.status === 404) return undefined;
    if (!response.ok) throw new SfpipeError(`GitHub zwrócił HTTP ${response.status} dla ${apiPath}`);
    return (await response.json()) as T;
  }

  private repoPath(ref: RepoRef) {
    return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  }

  getRepo(ref: RepoRef): Promise<RepoInfo | undefined> {
    return this.get<RepoInfo>(this.repoPath(ref));
  }

  async branchRules(ref: RepoRef, branch: string): Promise<BranchRule[] | undefined> {
    const all: BranchRule[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.get<BranchRule[]>(
        `${this.repoPath(ref)}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`,
      );
      if (!batch) return page === 1 ? undefined : all;
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  async environments(ref: RepoRef): Promise<EnvironmentInfo[] | undefined> {
    const all: EnvironmentInfo[] = [];
    for (let page = 1; ; page++) {
      const body = await this.get<{ environments: EnvironmentInfo[] }>(
        `${this.repoPath(ref)}/environments?per_page=100&page=${page}`,
      );
      if (!body) return page === 1 ? undefined : all;
      all.push(...body.environments);
      if (body.environments.length < 100) return all;
    }
  }

  /** Secret names only; values are never readable through the API. */
  async environmentSecretNames(ref: RepoRef, environment: string): Promise<Set<string> | undefined> {
    const body = await this.get<{ secrets: Array<{ name: string }> }>(
      `${this.repoPath(ref)}/environments/${encodeURIComponent(environment)}/secrets?per_page=100`,
    );
    return body ? new Set(body.secrets.map((s) => s.name)) : undefined;
  }
}
