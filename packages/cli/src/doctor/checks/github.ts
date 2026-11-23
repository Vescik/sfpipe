import { apiUrlFor, GitHubClient, resolveRepo, tokenFromEnv } from '../../adapters/github/client.js';
import { evaluateEnvironments, evaluateSourceRules, evaluateTargetRules } from '../../adapters/github/rules.js';
import { SfpipeError } from '../../core/errors.js';
import { Git } from '../../core/git.js';
import type { CheckGroup, CheckResult } from '../types.js';

export const githubCheck: CheckGroup = {
  id: 'github',
  title: 'GitHub: rulesety i Environments',
  async run(ctx) {
    const group = 'github';
    if (!ctx.loaded) return [{ group, title: 'GitHub', status: 'skip', detail: 'wymaga poprawnej konfiguracji' }];

    const ref = resolveRepo(ctx.env, await new Git(ctx.exec, ctx.loaded.root).remoteUrl());
    if (!ref) {
      return [{ group, title: 'GitHub', status: 'skip', detail: 'nie rozpoznano repo GitHub z remote origin' }];
    }
    const token = tokenFromEnv(ctx.env);
    if (!token) {
      return [
        {
          group,
          title: 'GitHub',
          status: 'skip',
          detail: 'brak tokenu GitHub',
          hint: 'Lokalnie: GH_TOKEN="$(gh auth token)" sfpipe doctor; w Actions przekaż GITHUB_TOKEN',
        },
      ];
    }

    const client = new GitHubClient(apiUrlFor(ref, ctx.env), token, ctx.fetch);
    const { config } = ctx.loaded;
    try {
      const repo = await client.getRepo(ref);
      if (!repo) {
        return [
          {
            group,
            title: 'repozytorium',
            status: 'error',
            detail: `nie znaleziono ${ref.owner}/${ref.repo} albo token nie ma dostępu`,
          },
        ];
      }
      const results: CheckResult[] = [{ group, title: 'repozytorium', status: 'ok', detail: repo.full_name }];

      for (const env of config.environments) {
        const rules = await client.branchRules(ref, env.branch);
        if (!rules) {
          results.push({ group, title: `${env.branch}: rulesety`, status: 'skip', detail: 'token nie ma dostępu do reguł' });
          continue;
        }
        results.push(...(env.role === 'target' ? evaluateTargetRules(env, rules) : evaluateSourceRules(env, rules)));
      }

      const environments = await client.environments(ref);
      if (!environments) {
        results.push({ group, title: 'Environments', status: 'skip', detail: 'token nie ma dostępu do Environments' });
      } else {
        const secrets = new Map(
          await Promise.all(
            config.environments.map(async (env) => [env.orgAlias, await client.environmentSecretNames(ref, env.orgAlias)] as const),
          ),
        );
        results.push(...evaluateEnvironments(config.environments, environments, secrets));
      }
      return results;
    } catch (error) {
      const err = error instanceof SfpipeError ? error : new SfpipeError(`Błąd połączenia z GitHub: ${(error as Error).message}`);
      return [{ group, title: 'GitHub', status: 'error', detail: err.message, hint: err.hint }];
    }
  },
};
