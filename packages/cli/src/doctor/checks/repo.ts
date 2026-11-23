import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseGitHubRemote } from '../../adapters/github/client.js';
import { Git } from '../../core/git.js';
import type { CheckGroup, CheckResult } from '../types.js';

export const repoCheck: CheckGroup = {
  id: 'repo',
  title: 'Repo i konfiguracja',
  async run(ctx) {
    const group = 'repo';
    const results: CheckResult[] = [];
    const git = new Git(ctx.exec, ctx.cwd);
    const gitRoot = await git.root();

    results.push(
      gitRoot
        ? { group, title: 'repozytorium git', status: 'ok', detail: gitRoot }
        : { group, title: 'repozytorium git', status: 'error', detail: `${ctx.cwd} nie jest w repozytorium git` },
    );

    if (ctx.loaded) {
      const names = ctx.loaded.config.environments.map((e) => e.name).join(' → ');
      results.push({ group, title: 'konfiguracja', status: 'ok', detail: `${path.relative(ctx.cwd, ctx.loaded.file) || ctx.loaded.file} · ${names}` });
    } else {
      results.push({
        group,
        title: 'konfiguracja',
        status: 'error',
        detail: ctx.configError?.message ?? 'brak konfiguracji',
        hint: ctx.configError ? ctx.configError.hint : 'Uruchom "sfpipe init" w katalogu głównym projektu Salesforce',
      });
    }

    const projectRoot = ctx.loaded?.root ?? gitRoot ?? ctx.cwd;
    results.push(await checkSfdxProject(projectRoot));

    results.push(
      existsSync(path.join(projectRoot, '.forceignore'))
        ? { group, title: '.forceignore', status: 'ok' }
        : { group, title: '.forceignore', status: 'warn', detail: 'brak pliku', hint: 'Dodaj .forceignore, żeby lustro i retrieve pomijały zbędne metadane' },
    );

    if (gitRoot) {
      const url = await git.remoteUrl();
      const github = url ? parseGitHubRemote(url) : undefined;
      if (!url) {
        results.push({ group, title: 'remote origin', status: 'warn', detail: 'brak remote "origin"' });
      } else if (github) {
        results.push({ group, title: 'remote origin', status: 'ok', detail: `${github.host}/${github.owner}/${github.repo}` });
      } else {
        results.push({
          group,
          title: 'remote origin',
          status: 'warn',
          detail: 'nie rozpoznano adresu repo GitHub',
          hint: 'Sprawdzenia rulesetów wymagają repo na GitHubie',
        });
      }
    }
    return results;
  },
};

async function checkSfdxProject(root: string): Promise<CheckResult> {
  const group = 'repo';
  const title = 'sfdx-project.json';
  const file = path.join(root, 'sfdx-project.json');
  if (!existsSync(file)) {
    const mdapi = existsSync(path.join(root, 'src', 'package.xml'));
    return {
      group,
      title,
      status: 'error',
      detail: mdapi ? 'repo jest w formacie Metadata API (src/package.xml)' : `brak pliku w ${root}`,
      hint: mdapi ? 'Przekonwertuj: sf project convert mdapi --root-dir src --output-dir force-app' : undefined,
    };
  }
  let parsed: { packageDirectories?: Array<{ path?: string }> };
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return { group, title, status: 'error', detail: `nieprawidłowy JSON: ${(error as Error).message}` };
  }
  const dirs = (parsed.packageDirectories ?? []).map((d) => d.path).filter((p): p is string => !!p);
  if (dirs.length === 0) return { group, title, status: 'error', detail: 'brak packageDirectories' };
  const missing = dirs.filter((dir) => !existsSync(path.join(root, dir)));
  if (missing.length > 0) return { group, title, status: 'error', detail: `brak katalogów: ${missing.join(', ')}` };
  return { group, title, status: 'ok', detail: `format source · ${dirs.join(', ')}` };
}
