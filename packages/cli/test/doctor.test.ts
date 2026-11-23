import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, type LoadedConfig } from '../src/core/config.js';
import { branchesCheck } from '../src/doctor/checks/branches.js';
import { githubCheck } from '../src/doctor/checks/github.js';
import { orgsCheck } from '../src/doctor/checks/orgs.js';
import { repoCheck } from '../src/doctor/checks/repo.js';
import { toolsCheck } from '../src/doctor/checks/tools.js';
import { formatActionsAnnotations, formatReport } from '../src/doctor/report.js';
import { runDoctor } from '../src/doctor/run.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';
import { exec } from '../src/core/exec.js';
import { fail, fakeExec, git, jsonResponse, ok, readTemplate, tempDir } from './helpers.js';

const template = await readTemplate();

function loadedAt(root: string): LoadedConfig {
  return { file: path.join(root, '.sfpipe', 'config.yml'), root, config: parseConfig(template) };
}

function context(overrides: Partial<DoctorContext>): DoctorContext {
  return {
    cwd: process.cwd(),
    exec,
    fetch: (() => Promise.reject(new Error('fetch not stubbed'))) as typeof fetch,
    env: {},
    ...overrides,
  };
}

const byTitle = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.title, r]));

describe('tools check', () => {
  it('reports an old git and a missing sfdx-git-delta plugin', async () => {
    const execStub = fakeExec({
      'git --version': ok('git version 2.30.1'),
      'sf --version': ok('@salesforce/cli/2.159.7 darwin-arm64 node-v24.11.1'),
      'sf plugins --json': ok(JSON.stringify([{ name: '@salesforce/cli', version: '2.159.7' }])),
    });
    const results = byTitle(await toolsCheck.run(context({ exec: execStub })));
    expect(results['git']).toMatchObject({ status: 'error', detail: expect.stringContaining('2.38.0') });
    expect(results['Salesforce CLI']).toMatchObject({ status: 'ok', detail: '2.159.7' });
    expect(results['sfdx-git-delta']).toMatchObject({ status: 'error', hint: expect.stringContaining('sf plugins install') });
  });

  it('skips the plugin check when sf is missing', async () => {
    const execStub = fakeExec({
      'git --version': ok('git version 2.54.0'),
      'sf ': { code: 127, stdout: '', stderr: 'not found' },
    });
    const results = byTitle(await toolsCheck.run(context({ exec: execStub })));
    expect(results['Salesforce CLI']!.status).toBe('error');
    expect(results['sfdx-git-delta']!.status).toBe('skip');
  });
});

describe('repo check', () => {
  it('validates sfdx-project.json and recognises a GitHub remote', async () => {
    const root = tempDir();
    await git(root, 'init');
    await git(root, 'remote', 'add', 'origin', 'git@github.com:acme/salesforce.git');
    writeFileSync(path.join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));

    let results = byTitle(await repoCheck.run(context({ cwd: root, loaded: loadedAt(root) })));
    expect(results['sfdx-project.json']).toMatchObject({ status: 'error', detail: 'brak katalogów: force-app' });
    expect(results['.forceignore']!.status).toBe('warn');
    expect(results['remote origin']).toMatchObject({ status: 'ok', detail: 'github.com/acme/salesforce' });

    mkdirSync(path.join(root, 'force-app'));
    results = byTitle(await repoCheck.run(context({ cwd: root, loaded: loadedAt(root) })));
    expect(results['sfdx-project.json']!.status).toBe('ok');
    expect(results['manifesty work itemów']).toMatchObject({ status: 'ok', detail: expect.stringContaining('powstanie przy pierwszym') });
  });

  it('warns about two work-item folders for one ID', async () => {
    const root = tempDir();
    for (const name of ['5001-approval', '5001-approval-v2', '5002-other']) {
      mkdirSync(path.join(root, 'work-items', name), { recursive: true });
    }
    const results = byTitle(await repoCheck.run(context({ cwd: root, loaded: loadedAt(root) })));
    expect(results['manifesty work itemów']).toMatchObject({
      status: 'warn',
      detail: 'kilka folderów dla jednego ID (5001: 5001-approval, 5001-approval-v2)',
    });
  });

  it('detects a Metadata API format repo', async () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'package.xml'), '<Package/>');
    const results = byTitle(await repoCheck.run(context({ cwd: root })));
    expect(results['sfdx-project.json']).toMatchObject({ status: 'error', hint: expect.stringContaining('convert mdapi') });
    expect(results['konfiguracja']!.status).toBe('error');
  });
});

describe('branches check', () => {
  it('finds missing branches and env branches without back-sync', async () => {
    const origin = tempDir('sfpipe-origin-');
    await git(origin, 'init', '--bare');
    const work = tempDir('sfpipe-work-');
    await git(work, 'init');
    mkdirSync(path.join(work, '.sfpipe'));
    writeFileSync(path.join(work, '.sfpipe', 'config.yml'), template);
    await git(work, 'add', '-A');
    await git(work, 'commit', '-m', 'init');
    await git(work, 'remote', 'add', 'origin', origin);
    await git(work, 'push', '-u', 'origin', 'main');
    await git(work, 'push', 'origin', 'main:refs/heads/uat');
    writeFileSync(path.join(work, 'hotfix.txt'), 'fix');
    await git(work, 'add', '-A');
    await git(work, 'commit', '-m', 'hotfix');
    await git(work, 'push', 'origin', 'main', 'main:refs/heads/stage');
    await git(work, 'fetch', 'origin');

    const results = byTitle(await branchesCheck.run(context({ loaded: loadedAt(work) })));
    expect(results['dev → dev']).toMatchObject({ status: 'error', hint: expect.stringContaining('krok 8') });
    expect(results['uat → uat']!.status).toBe('ok');
    expect(results['uat zawiera main']!.status).toBe('warn');
    expect(results['stage zawiera main']!.status).toBe('ok');
    expect(results['prod → main']!.status).toBe('ok');
    expect(results['main zawiera main']).toBeUndefined();
  });
});

describe('orgs check', () => {
  it('checks auth and sandbox type without leaking the access token', async () => {
    const display = (alias: string) =>
      ok(
        JSON.stringify({
          status: 0,
          result: {
            username: `sfpipe@acme.com.${alias}`,
            instanceUrl: `https://acme--${alias}.sandbox.my.salesforce.com`,
            accessToken: 'SECRET-TOKEN',
            connectedStatus: 'Connected',
          },
        }),
      );
    const sandbox = (value: boolean) => ok(JSON.stringify({ status: 0, result: { records: [{ IsSandbox: value }] } }));
    const execStub = fakeExec({
      'sf org display --target-org sf-dev': display('dev'),
      'sf org display --target-org sf-uat': display('uat'),
      'sf org display --target-org sf-prod': fail(
        JSON.stringify({
          status: 2,
          message: 'Parsing --target-org \n\tNo authorization information found for sf-prod.\nSee more help with --help',
        }),
      ),
      'sf data query --query SELECT IsSandbox FROM Organization --target-org sf-dev': sandbox(true),
      'sf data query --query SELECT IsSandbox FROM Organization --target-org sf-uat': sandbox(false),
    });

    const results = await orgsCheck.run(context({ exec: execStub, loaded: loadedAt(tempDir()), envFilter: ['dev', 'uat', 'prod'] }));
    const map = byTitle(results);
    expect(map['dev (sf-dev)']).toMatchObject({ status: 'ok', detail: expect.stringContaining('sandbox') });
    expect(map['uat (sf-uat)']).toMatchObject({ status: 'error', detail: expect.stringContaining('PRODUKCYJNY') });
    expect(map['prod (sf-prod)']).toMatchObject({ status: 'error', detail: 'No authorization information found for sf-prod.' });
    expect(map['stage (sf-stage)']).toBeUndefined();
    expect(JSON.stringify(results)).not.toContain('SECRET-TOKEN');
  });
});

describe('github check', () => {
  async function repoWithRemote() {
    const root = tempDir();
    await git(root, 'init');
    await git(root, 'remote', 'add', 'origin', 'https://github.com/acme/salesforce.git');
    return loadedAt(root);
  }

  it('skips without a token', async () => {
    const [result] = await githubCheck.run(context({ loaded: await repoWithRemote() }));
    expect(result).toMatchObject({ status: 'skip', hint: expect.stringContaining('gh auth token') });
  });

  it('evaluates rules and environments through the API', async () => {
    const good = [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'sfpipe-pr / deploy' }] },
      },
      {
        type: 'pull_request',
        parameters: { allowed_merge_methods: ['merge'], required_approving_review_count: 1, required_review_thread_resolution: true },
      },
    ];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/repos/acme/salesforce')) return jsonResponse({ full_name: 'acme/salesforce', default_branch: 'main' });
      if (url.includes('/rules/branches/dev')) return jsonResponse([{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }]);
      if (url.includes('/rules/branches/stage')) return jsonResponse([]);
      if (url.includes('/rules/branches/')) return jsonResponse(good);
      if (url.includes('/environments?')) {
        return jsonResponse({
          environments: ['sf-dev', 'sf-uat', 'sf-stage', 'sf-prod'].map((name) => ({
            name,
            protection_rules: name === 'sf-dev' ? [] : [{ type: 'required_reviewers', prevent_self_review: true }],
          })),
        });
      }
      if (url.includes('/secrets')) return jsonResponse({}, 403);
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const results = await githubCheck.run(context({ loaded: await repoWithRemote(), env: { GH_TOKEN: 't' }, fetch: fetchStub }));
    const errors = results.filter((r) => r.status === 'error').map((r) => r.title);
    expect(errors.every((title) => title.startsWith('stage:'))).toBe(true);
    expect(errors).toContain('stage: wymagany PR');
    expect(byTitle(results)['uat: code review']!.status).toBe('ok');
    expect(byTitle(results)['Environment sf-prod: sekrety']!.status).toBe('skip');
  });
});

describe('runDoctor and report', () => {
  it('summarises, filters groups and formats annotations', async () => {
    const report = await runDoctor(context({ cwd: tempDir() }), ['repo', 'github']);
    expect(report.groups.map((g) => g.id)).toEqual(['repo', 'github']);
    expect(report.ok).toBe(false);

    const text = formatReport(report, { color: false });
    expect(text).toMatch(/Repo i konfiguracja/);
    expect(text).toMatch(/Wynik: \d+ ok · \d+ ostrzeże\S* · \d+ błęd\S*|Wynik: \d+ ok · \d+ ostrzeże\S* · 1 błąd/);
    expect(text).toContain('→ Uruchom "sfpipe init"');

    const annotations = formatActionsAnnotations(report);
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations[0]).toMatch(/^::(error|warning) title=repo%3A /);
    expect(annotations.every((line) => !line.includes('\n'))).toBe(true);
  });
});
