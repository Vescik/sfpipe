import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findConfigFile, loadConfig, parseConfig } from '../src/core/config.js';
import { SfpipeError } from '../src/core/errors.js';
import { readTemplate, tempDir } from './helpers.js';

const minimal = (environments: string, extra = '') => `
workItem:
  provider: github-issues
${extra}
environments:
${environments}
`;

const UAT_PROD = `
  uat:
    branch: uat
    promotion: work-item
    testLevel: RunSpecifiedTests
  prod:
    branch: main
    promotion: release
    testLevel: RunLocalTests
`;

function errorOf(source: string): string {
  try {
    parseConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(SfpipeError);
    return (error as Error).message;
  }
  throw new Error('expected parseConfig to fail');
}

describe('parseConfig', () => {
  it('accepts the init template and resolves environments in declared order', async () => {
    const config = parseConfig(await readTemplate());
    expect(config.workItem).toEqual({ provider: 'github-issues', label: 'user-story', branchPrefix: 'wi/' });
    expect(config.environments.map((e) => [e.name, e.role, e.branch, e.orgAlias])).toEqual([
      ['dev', 'source', 'dev', 'sf-dev'],
      ['uat', 'target', 'uat', 'sf-uat'],
      ['stage', 'target', 'stage', 'sf-stage'],
      ['prod', 'target', 'main', 'sf-prod'],
    ]);
    const prod = config.environments.at(-1)!;
    expect(prod.isProduction).toBe(true);
    expect(prod.role === 'target' && prod.deployWindow).toBe('Tue,Thu 18:00-21:00 Europe/Warsaw');
  });

  it('applies defaults: role target, org alias sf-<env>, base branch main, test naming', () => {
    const config = parseConfig(minimal(UAT_PROD));
    expect(config.baseBranch).toBe('main');
    expect(config.environments[0]).toMatchObject({ role: 'target', orgAlias: 'sf-uat', ignore: [] });
    expect(config.tests.naming).toEqual(['{name}Test', '{name}_Test']);
  });

  it('reports YAML syntax errors', () => {
    expect(errorOf('workItem: [unclosed')).toMatch(/Błąd składni YAML/);
  });

  it('requires exactly one production environment, placed last', () => {
    expect(errorOf(minimal(UAT_PROD.replace('branch: main', 'branch: prod')))).toMatch(/gałęzi bazowej "main"/);
    const prodFirst = `
  prod:
    branch: main
    promotion: release
    testLevel: RunLocalTests
  uat:
    branch: uat
    promotion: work-item
    testLevel: RunSpecifiedTests
`;
    expect(errorOf(minimal(prodFirst))).toMatch(/musi być ostatnie/);
  });

  it('allows one source environment and only as the first one', () => {
    const source = (name: string) => `
  ${name}:
    role: source
    branch: ${name}
    mirror: { incremental: "0 * * * *", full: "0 1 * * *", types: [ApexClass] }
`;
    expect(errorOf(minimal(UAT_PROD.replace('  prod:', `${source('dev').trimEnd()}\n  prod:`)))).toMatch(/musi być pierwsze/);
    expect(errorOf(minimal(source('dev') + source('dev2') + UAT_PROD))).toMatch(/jedno środowisko źródłowe/);
  });

  it('rejects duplicate branches and work-item envs after release envs', () => {
    expect(errorOf(minimal(UAT_PROD.replace('branch: uat', 'branch: main')))).toMatch(/Gałąź "main" jest już użyty|Dokładnie jedno/);
    const wrongOrder = `
  stage:
    branch: stage
    promotion: release
    testLevel: RunLocalTests
${UAT_PROD}`;
    expect(errorOf(minimal(wrongOrder))).toMatch(/promotion: work-item muszą być przed/);
  });

  it('validates field formats with paths', () => {
    const message = errorOf(
      minimal(
        UAT_PROD.replace('testLevel: RunLocalTests', 'testLevel: RunAll\n    ignore: [DebugUtils]\n    deployWindow: "Fri 25:00-26:00 UTC"'),
      ),
    );
    expect(message).toMatch(/environments\.prod\.testLevel/);
    expect(message).toMatch(/environments\.prod\.ignore\.0: Oczekiwano komponentu w postaci Typ:Nazwa/);
    expect(message).toMatch(/environments\.prod\.deployWindow: Nieprawidłowe godziny/);
  });

  it('rejects unknown keys and env names unusable in workflows', () => {
    expect(errorOf(minimal(UAT_PROD.replace('    promotion: work-item', '    promotion: work-item\n    adoEnvironment: x')))).toMatch(
      /adoEnvironment/,
    );
    expect(errorOf(minimal(UAT_PROD.replace('  uat:', '  user-acceptance:')))).toMatch(/Nazwa środowiska/);
  });
});

describe('loadConfig', () => {
  it('finds .sfpipe/config.yml in a parent directory', async () => {
    const root = tempDir();
    mkdirSync(path.join(root, '.sfpipe'));
    writeFileSync(path.join(root, '.sfpipe', 'config.yml'), minimal(UAT_PROD));
    const nested = path.join(root, 'force-app', 'main');
    mkdirSync(nested, { recursive: true });

    expect(findConfigFile(nested)).toBe(path.join(root, '.sfpipe', 'config.yml'));
    const loaded = await loadConfig(nested);
    expect(loaded.root).toBe(root);
  });

  it('explains how to create a missing config', async () => {
    await expect(loadConfig(tempDir())).rejects.toMatchObject({ hint: expect.stringContaining('sfpipe init') });
  });
});
