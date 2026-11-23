import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, CONFIG_FILE } from '../core/config.js';
import { SfpipeError } from '../core/errors.js';
import type { Io } from '../io.js';

/** Same relative location from `src/commands` and `dist/commands`. */
const TEMPLATE = fileURLToPath(new URL('../../templates/config.yml', import.meta.url));

export async function initCommand(options: { cwd: string; force: boolean }, io: Io): Promise<void> {
  const configDir = path.join(options.cwd, CONFIG_DIR);
  const configFile = path.join(configDir, CONFIG_FILE);
  const workItemsDir = path.join(configDir, 'work-items');

  if (existsSync(configFile) && !options.force) {
    throw new SfpipeError(`${CONFIG_DIR}/${CONFIG_FILE} już istnieje`, 'Użyj --force, aby nadpisać');
  }
  if (!existsSync(path.join(options.cwd, 'sfdx-project.json')) && !options.force) {
    throw new SfpipeError(
      `W ${options.cwd} nie ma sfdx-project.json`,
      'Uruchom w katalogu głównym projektu Salesforce albo dodaj --force',
    );
  }

  await mkdir(workItemsDir, { recursive: true });
  await copyFile(TEMPLATE, configFile);
  const keep = path.join(workItemsDir, '.gitkeep');
  if (!existsSync(keep)) await writeFile(keep, '');

  io.out(
    [
      'Utworzono:',
      `  ${CONFIG_DIR}/${CONFIG_FILE}`,
      `  ${CONFIG_DIR}/work-items/`,
      '',
      'Dalej:',
      '  1. Uzupełnij listę mirror.types i mapowanie users',
      '  2. sfpipe config validate',
      '  3. sfpipe doctor',
    ].join('\n'),
  );
}
