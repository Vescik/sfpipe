import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { formatTable } from '../format.js';
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
  io.out(`✔ ${path.relative(options.cwd, loaded.file) || loaded.file} jest poprawny\n`);
  io.out(formatTable(['Środowisko', 'Rola', 'Gałąź', 'Org / Environment', 'Promocja', 'Testy', 'Okno deployu'], rows));
}
