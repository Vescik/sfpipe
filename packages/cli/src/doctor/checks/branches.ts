import { Git } from '../../core/git.js';
import type { CheckGroup, CheckResult } from '../types.js';

export const branchesCheck: CheckGroup = {
  id: 'branches',
  title: 'Gałęzie środowisk',
  async run(ctx) {
    const group = 'branches';
    if (!ctx.loaded) return [{ group, title: 'gałęzie', status: 'skip', detail: 'wymaga poprawnej konfiguracji' }];
    const git = new Git(ctx.exec, ctx.loaded.root);
    if (!(await git.root())) return [{ group, title: 'gałęzie', status: 'skip', detail: 'wymaga repozytorium git' }];

    const { config } = ctx.loaded;
    const remote = await git.remoteBranches();
    const results: CheckResult[] = [];

    if (!remote) {
      results.push({
        group,
        title: 'origin',
        status: 'warn',
        detail: 'nie udało się odczytać gałęzi z origin, sprawdzam lokalne referencje',
      });
    }

    /** Best ref to inspect history of a branch: the remote-tracking ref when present. */
    const resolveRef = async (branch: string) => {
      for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
        if (await git.refExists(ref)) return ref;
      }
      return undefined;
    };

    const baseRef = await resolveRef(config.baseBranch);

    for (const env of config.environments) {
      const title = `${env.name} → ${env.branch}`;
      const exists = remote ? remote.has(env.branch) : (await resolveRef(env.branch)) !== undefined;
      if (!exists) {
        results.push({
          group,
          title,
          status: 'error',
          detail: remote ? 'brak gałęzi w origin' : 'brak gałęzi',
          hint:
            env.role === 'source'
              ? 'Gałąź lustra tworzy baseline dev: docs/runbooks/faza-0.md, krok 8'
              : env.isProduction
                ? `git push -u origin ${env.branch}`
                : `git push origin ${config.baseBranch}:refs/heads/${env.branch}`,
        });
        continue;
      }
      results.push({ group, title, status: 'ok', detail: remote ? 'origin' : 'lokalnie' });

      if (env.role !== 'target' || env.isProduction || !baseRef) continue;
      const envRef = await resolveRef(env.branch);
      if (!envRef) continue;
      if (await git.isAncestor(baseRef, envRef)) {
        results.push({ group, title: `${env.branch} zawiera ${config.baseBranch}`, status: 'ok' });
      } else {
        results.push({
          group,
          title: `${env.branch} zawiera ${config.baseBranch}`,
          status: 'warn',
          detail: `w ${env.branch} brakuje commitów z ${config.baseBranch} (brak back-sync)`,
          hint: `Zmerguj ${config.baseBranch} do ${env.branch} przez PR`,
        });
      }
    }
    return results;
  },
};
