import { createRequire } from 'node:module';
import path from 'node:path';
import { Command, Option } from 'commander';
import { configValidateCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { GROUP_IDS, type GroupId } from './doctor/types.js';
import { defaultIo, type Io } from './io.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export function buildProgram(io: Io = defaultIo()): Command {
  const program = new Command('sfpipe')
    .description('Pipeline wdrożeń Salesforce oparty na work-itemach (GitHub)')
    .version(version, '-v, --version', 'pokazuje wersję')
    .helpOption('-h, --help', 'pokazuje pomoc')
    .option('-C, --cwd <katalog>', 'katalog projektu Salesforce', process.cwd())
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => io.out(text.trimEnd()),
      writeErr: (text) => io.err(text.trimEnd()),
    });

  const cwdOf = (command: Command) => path.resolve(String(command.optsWithGlobals().cwd));

  program
    .command('init')
    .description('tworzy .sfpipe/config.yml w projekcie Salesforce')
    .option('--force', 'nadpisuje istniejącą konfigurację')
    .action(async (opts: { force?: boolean }, command: Command) => {
      await initCommand({ cwd: cwdOf(command), force: !!opts.force }, io);
    });

  program
    .command('config')
    .description('konfiguracja sfpipe')
    .command('validate')
    .description('sprawdza .sfpipe/config.yml i pokazuje środowiska')
    .option('--json', 'wynik w JSON')
    .action(async (opts: { json?: boolean }, command: Command) => {
      await configValidateCommand({ cwd: cwdOf(command), json: !!opts.json }, io);
    });

  program
    .command('doctor')
    .description('sprawdza narzędzia, repo, gałęzie, orgi oraz rulesety i Environments na GitHubie')
    .addOption(new Option('--only <grupy...>', 'tylko wybrane grupy sprawdzeń').choices([...GROUP_IDS]))
    .option('--env <środowiska...>', 'tylko wybrane środowiska (sprawdzenia orgów)')
    .option('--json', 'wynik w JSON')
    .action(async (opts: { only?: GroupId[]; env?: string[]; json?: boolean }, command: Command) => {
      const code = await doctorCommand({ cwd: cwdOf(command), only: opts.only, env: opts.env, json: !!opts.json }, io);
      io.setExitCode(code);
    });

  return program;
}
