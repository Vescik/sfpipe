import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';
import { captureIo, readTemplate, tempDir } from './helpers.js';

async function run(args: string[], io = captureIo()) {
  await buildProgram(io).parseAsync(['node', 'sfpipe', ...args]);
  return io;
}

function sfProject(): string {
  const root = tempDir();
  writeFileSync(path.join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
  return root;
}

describe('sfpipe init', () => {
  it('creates the config from the template and refuses to overwrite it', async () => {
    const root = sfProject();
    const io = await run(['init', '--cwd', root]);
    expect(readFileSync(path.join(root, '.sfpipe', 'config.yml'), 'utf8')).toBe(await readTemplate());
    // Manifests live next to the work item's design files, not under .sfpipe/.
    expect(existsSync(path.join(root, '.sfpipe', 'work-items'))).toBe(false);
    expect(io.stdout.join('\n')).toContain('sfpipe config validate');

    await expect(run(['init', '--cwd', root])).rejects.toMatchObject({ hint: 'Użyj --force, aby nadpisać' });
    await run(['init', '--cwd', root, '--force']);
  });

  it('refuses to run outside a Salesforce project', async () => {
    await expect(run(['init', '--cwd', tempDir()])).rejects.toMatchObject({ message: expect.stringContaining('sfdx-project.json') });
  });
});

describe('sfpipe config validate', () => {
  it('prints the environments table', async () => {
    const root = sfProject();
    await run(['init', '--cwd', root]);
    const io = await run(['config', 'validate', '--cwd', root]);
    const output = io.stdout.join('\n');
    expect(output).toContain('✔ .sfpipe/config.yml jest poprawny');
    expect(output).toMatch(/Work itemy\s+Azure Boards, link AB#<id>/);
    expect(output).toMatch(/Gałęzie\s+work-item\/<id>-<opis>, feature\/<id>-<opis>/);
    expect(output).toMatch(/Manifest\s+work-items\/\{id\}-\{slug\}\/sfpipe\.yml/);
    expect(output).toMatch(/dev\s+źródło \(lustro\)\s+dev\s+sf-dev/);
    expect(output).toMatch(/prod\s+produkcja\s+main\s+sf-prod\s+release\s+RunLocalTests\s+Tue,Thu 18:00-21:00 Europe\/Warsaw/);
  });

  it('prints resolved config as JSON', async () => {
    const root = sfProject();
    await run(['init', '--cwd', root]);
    const io = await run(['config', 'validate', '--json', '--cwd', root]);
    const parsed = JSON.parse(io.stdout.join('\n'));
    expect(parsed.config.environments.map((e: { orgAlias: string }) => e.orgAlias)).toEqual(['sf-dev', 'sf-uat', 'sf-stage', 'sf-prod']);
  });
});

describe('sfpipe doctor', () => {
  it('sets a failing exit code and prints JSON', async () => {
    const root = sfProject();
    await run(['init', '--cwd', root]);
    const io = await run(['doctor', '--only', 'repo', '--json', '--cwd', root]);
    const report = JSON.parse(io.stdout.join('\n'));
    expect(report.groups.map((g: { id: string }) => g.id)).toEqual(['repo']);
    expect(io.exitCode).toBe(1); // not a git repository
  });

  it('rejects unknown environments', async () => {
    const root = sfProject();
    await run(['init', '--cwd', root]);
    await expect(run(['doctor', '--only', 'orgs', '--env', 'qa', '--cwd', root])).rejects.toMatchObject({
      message: 'Nieznane środowisko: qa',
    });
  });
});
