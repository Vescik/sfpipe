import { loadConfig, type ResolvedConfig } from '../core/config.js';
import { displayPath, formatTable } from '../format.js';
import type { Io } from '../io.js';

export async function configValidateCommand(options: { cwd: string; json: boolean }, io: Io): Promise<void> {
  const loaded = await loadConfig(options.cwd);
  if (options.json) {
    io.out(JSON.stringify(loaded, null, 2));
    return;
  }
  const rows = loaded.config.environments.map((env) =>
    env.role === 'source'
      ? [env.name, 'źródło (lustro)', env.branch, env.orgAlias, '—', '—', '—']
      : [
          env.name,
          env.isProduction ? 'produkcja' : 'cel',
          env.branch,
          env.orgAlias,
          env.promotion,
          env.testLevel,
          env.deployWindow ?? '—',
        ],
  );
  io.out(`✔ ${displayPath(options.cwd, loaded.file)} jest poprawny\n`);
  io.out(`${workItemSummary(loaded.config)}\n`);
  io.out(formatTable(['Środowisko', 'Rola', 'Gałąź', 'Org / Environment', 'Promocja', 'Testy', 'Okno deployu'], rows));
}

function workItemSummary(config: ResolvedConfig): string {
  const { workItem, commits } = config;
  const source =
    workItem.provider === 'azure-boards'
      ? 'Azure Boards, link AB#<id>' + (workItem.organization ? ` · ${workItem.organization} / ${workItem.project}` : '')
      : `GitHub Issues z labelem ${workItem.label}, link #<id>`;
  return formatTable(
    ['Work itemy', source],
    [
      ['Gałęzie', `${workItem.branchPrefix}<id>-<opis>, ${workItem.featurePrefix}<id>-<opis>`],
      ['Manifest', workItem.manifest],
      ['Commity', [commits.workItem, commits.feature, commits.maintenance].join(' · ')],
    ],
  );
}
