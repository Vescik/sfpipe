import { describe, expect, it } from 'vitest';
import { GitHubClient, parseGitHubRemote, resolveRepo, type BranchRule } from '../src/adapters/github/client.js';
import { evaluateEnvironments, evaluateSourceRules, evaluateTargetRules } from '../src/adapters/github/rules.js';
import { parseConfig, type SourceEnv, type TargetEnv } from '../src/core/config.js';
import { jsonResponse, readTemplate } from './helpers.js';

const config = parseConfig(await readTemplate());
const [dev, uat, stage, prod] = config.environments as [SourceEnv, TargetEnv, TargetEnv, TargetEnv];

const protection: BranchRule[] = [{ type: 'deletion' }, { type: 'non_fast_forward' }];
const statusChecks = (strict = true): BranchRule => ({
  type: 'required_status_checks',
  parameters: { strict_required_status_checks_policy: strict, required_status_checks: [{ context: 'sfpipe-pr / deploy' }] },
});
const pullRequest = (parameters: Record<string, unknown>): BranchRule => ({ type: 'pull_request', parameters });

const statusOf = (results: { title: string; status: string }[]) =>
  Object.fromEntries(results.map((r) => [r.title.split(': ')[1], r.status]));

describe('parseGitHubRemote', () => {
  it.each([
    ['git@github.com:acme/salesforce.git', 'github.com'],
    ['https://github.com/acme/salesforce', 'github.com'],
    ['https://x-access-token:abc@github.com/acme/salesforce.git', 'github.com'],
    ['ssh://git@ghe.acme.com/acme/salesforce.git', 'ghe.acme.com'],
  ])('%s', (url, host) => {
    expect(parseGitHubRemote(url)).toEqual({ host, owner: 'acme', repo: 'salesforce' });
  });

  it('prefers GITHUB_REPOSITORY over the remote', () => {
    expect(resolveRepo({ GITHUB_REPOSITORY: 'acme/sf' }, 'git@github.com:other/x.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'sf',
    });
  });
});

describe('evaluateTargetRules', () => {
  it('passes a uat branch configured as in the plan', () => {
    const results = evaluateTargetRules(uat, [
      ...protection,
      statusChecks(),
      pullRequest({ allowed_merge_methods: ['merge'], required_approving_review_count: 1, required_review_thread_resolution: true }),
    ]);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('flags squash, linear history, missing up-to-date and missing protection', () => {
    const results = statusOf(
      evaluateTargetRules(stage, [
        statusChecks(false),
        { type: 'required_linear_history' },
        { type: 'merge_queue' },
        pullRequest({ allowed_merge_methods: ['merge', 'squash'] }),
      ]),
    );
    expect(results).toMatchObject({
      'metody merge': 'error',
      'liniowa historia': 'error',
      'check deployu': 'error',
      'merge queue': 'warn',
      'ochrona gałęzi': 'error',
    });
  });

  it('requires a review only on work-item environments', () => {
    const rules = [...protection, statusChecks(), pullRequest({ allowed_merge_methods: ['merge'], required_approving_review_count: 0 })];
    expect(statusOf(evaluateTargetRules(uat, rules))['code review']).toBe('error');
    expect(statusOf(evaluateTargetRules(prod, rules))['code review']).toBeUndefined();
  });

  it('reports a missing pull request rule and deploy check', () => {
    expect(statusOf(evaluateTargetRules(prod, protection))).toMatchObject({ 'wymagany PR': 'error', 'check deployu': 'error' });
  });
});

describe('evaluateSourceRules', () => {
  it('warns when anyone can push to the mirror branch', () => {
    expect(statusOf(evaluateSourceRules(dev, protection))['push tylko z workflowu']).toBe('warn');
    expect(statusOf(evaluateSourceRules(dev, [...protection, { type: 'update' }]))['push tylko z workflowu']).toBe('ok');
  });
});

describe('evaluateEnvironments', () => {
  const allSecrets = new Set(['SF_CLIENT_ID', 'SF_USERNAME', 'SF_INSTANCE_URL', 'SF_JWT_KEY']);

  it('checks presence, reviewers and secrets per environment', () => {
    const results = evaluateEnvironments(
      config.environments,
      [
        { name: 'sf-dev' },
        { name: 'sf-uat', protection_rules: [{ type: 'required_reviewers' }] },
        { name: 'sf-prod', protection_rules: [{ type: 'required_reviewers', prevent_self_review: false }] },
      ],
      new Map([
        ['sf-dev', allSecrets],
        ['sf-uat', new Set(['SF_CLIENT_ID'])],
        ['sf-prod', undefined],
      ]),
    );
    const byTitle = Object.fromEntries(results.map((r) => [r.title, r.status]));
    expect(byTitle).toMatchObject({
      'Environment sf-dev: reviewerzy': 'ok',
      'Environment sf-dev: sekrety': 'ok',
      'Environment sf-uat: reviewerzy': 'ok',
      'Environment sf-uat: sekrety': 'error',
      'Environment sf-stage: istnieje': 'error',
      'Environment sf-prod: reviewerzy': 'warn',
      'Environment sf-prod: sekrety': 'skip',
    });
  });
});

describe('GitHubClient', () => {
  it('sends the token, paginates rules and maps 404 to undefined', async () => {
    const requests: Array<{ url: string; auth: string | null }> = [];
    const page1 = Array.from({ length: 100 }, () => ({ type: 'deletion' }));
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.includes('/rules/branches/uat?per_page=100&page=1')) return jsonResponse(page1);
      if (url.includes('/rules/branches/uat?per_page=100&page=2')) return jsonResponse([{ type: 'update' }]);
      return jsonResponse({ message: 'Not Found' }, 404);
    }) as typeof fetch;

    const client = new GitHubClient('https://api.github.com', 'secret-token', fetchStub);
    const ref = { host: 'github.com', owner: 'acme', repo: 'salesforce' };
    expect(await client.branchRules(ref, 'uat')).toHaveLength(101);
    expect(await client.getRepo(ref)).toBeUndefined();
    expect(requests[0]).toEqual({
      url: 'https://api.github.com/repos/acme/salesforce/rules/branches/uat?per_page=100&page=1',
      auth: 'Bearer secret-token',
    });
  });

  it('turns 401 into an error with a hint', async () => {
    const client = new GitHubClient('https://api.github.com', 't', (async () => jsonResponse({}, 401)) as typeof fetch);
    await expect(client.getRepo({ host: 'github.com', owner: 'a', repo: 'b' })).rejects.toMatchObject({
      message: 'GitHub odrzucił token',
    });
  });
});
