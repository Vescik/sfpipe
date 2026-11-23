import { SfCli } from '../../core/sf.js';
import type { CheckGroup, CheckResult } from '../types.js';

export const orgsCheck: CheckGroup = {
  id: 'orgs',
  title: 'Orgi Salesforce',
  async run(ctx) {
    const group = 'orgs';
    if (!ctx.loaded) return [{ group, title: 'orgi', status: 'skip', detail: 'wymaga poprawnej konfiguracji' }];
    const sf = new SfCli(ctx.exec, ctx.loaded.root);
    const envs = ctx.loaded.config.environments.filter((e) => !ctx.envFilter || ctx.envFilter.includes(e.name));

    return Promise.all(
      envs.map(async (env): Promise<CheckResult> => {
        const title = `${env.name} (${env.orgAlias})`;
        const display = await sf.orgDisplay(env.orgAlias);
        if (!display.ok) {
          return {
            group,
            title,
            status: 'error',
            detail: display.message,
            hint: `Zaloguj: sf org login jwt ... --alias ${env.orgAlias} (docs/runbooks/faza-0.md, krok 3)`,
          };
        }
        const { org } = display;
        if (org.connectedStatus && org.connectedStatus !== 'Connected') {
          return { group, title, status: 'error', detail: `${org.username}: ${org.connectedStatus}` };
        }

        const isSandbox = await sf.isSandbox(env.orgAlias);
        const where = `${org.username} · ${org.instanceUrl}`;
        if (isSandbox === undefined) {
          return { group, title, status: 'warn', detail: `${where} · nie udało się sprawdzić typu orga` };
        }
        if (env.isProduction && isSandbox) {
          return { group, title, status: 'error', detail: `${where} · to sandbox, a środowisko jest produkcją` };
        }
        if (!env.isProduction && !isSandbox) {
          return {
            group,
            title,
            status: 'error',
            detail: `${where} · to org PRODUKCYJNY, a środowisko "${env.name}" powinno być sandboxem`,
            hint: `Przeloguj alias ${env.orgAlias} na właściwy sandbox`,
          };
        }
        return { group, title, status: 'ok', detail: `${where} · ${isSandbox ? 'sandbox' : 'produkcja'}` };
      }),
    );
  },
};
