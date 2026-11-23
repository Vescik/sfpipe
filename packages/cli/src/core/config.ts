import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { parseDeployWindow } from './deploy-window.js';
import { SfpipeError } from './errors.js';
import { commitTemplateError, manifestTemplateError, type CommitKind } from './work-item.js';

z.config(z.locales.pl());

export const CONFIG_DIR = '.sfpipe';
export const CONFIG_FILE = 'config.yml';

export const TEST_LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'] as const;

const ENV_NAME_RE = /^[a-z][a-z0-9_]*$/;
const METADATA_TYPE_RE = /^[A-Z][A-Za-z0-9]*$/;
const COMPONENT_RE = /^[A-Z][A-Za-z0-9]*:\S.*$/;
const BRANCH_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<!\/)$/;

const branchName = z.string().regex(BRANCH_RE, 'Nieprawidłowa nazwa gałęzi');

const cron = z.string().refine(
  (value) => {
    const fields = value.trim().split(/\s+/);
    return fields.length === 5 && fields.every((field) => /^[\w*,/-]+$/.test(field));
  },
  { message: 'Oczekiwano wyrażenia cron z 5 polami, np. "0 6-16 * * 1-5"' },
);

const componentName = z
  .string()
  .regex(COMPONENT_RE, 'Oczekiwano komponentu w postaci Typ:Nazwa, np. ApexClass:AccountService');

const mirrorSchema = z.strictObject({
  incremental: cron,
  full: cron,
  types: z
    .array(z.string().regex(METADATA_TYPE_RE, 'Oczekiwano nazwy typu metadanych, np. ApexClass'))
    .min(1),
});

const sourceEnvSchema = z.strictObject({
  role: z.literal('source'),
  branch: branchName,
  org: z.string().min(1).optional(),
  mirror: mirrorSchema,
  users: z.record(z.string().includes('@'), z.email()).default({}),
});

const deployWindow = z.string().superRefine((value, ctx) => {
  const parsed = parseDeployWindow(value);
  if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.message });
});

const targetEnvSchema = z.strictObject({
  role: z.literal('target'),
  branch: branchName,
  org: z.string().min(1).optional(),
  promotion: z.enum(['work-item', 'release']),
  testLevel: z.enum(TEST_LEVELS),
  deployWindow: deployWindow.optional(),
  ignore: z.array(componentName).default([]),
});

const envSchema = z.preprocess(
  (value) =>
    value !== null && typeof value === 'object' && !('role' in value) ? { ...value, role: 'target' } : value,
  z.discriminatedUnion('role', [sourceEnvSchema, targetEnvSchema]),
);

const DEFAULT_TEST_NAMING = ['{name}Test', '{name}_Test'];

/** Branch prefixes sfpipe creates itself; work-item prefixes and env branches must not use them. */
export const RESERVED_PREFIXES = ['promote/', 'release/', 'hotfix/', 'sync/'] as const;

const branchPrefix = z
  .string()
  .regex(/^[a-z0-9-]+\/$/, 'Oczekiwano prefiksu zakończonego "/", np. "work-item/"')
  .refine((value) => !(RESERVED_PREFIXES as readonly string[]).includes(value), {
    message: `Prefiks zarezerwowany przez sfpipe (${RESERVED_PREFIXES.join(', ')})`,
  });

const manifestTemplate = z.string().superRefine((value, ctx) => {
  const message = manifestTemplateError(value);
  if (message) ctx.addIssue({ code: 'custom', message });
});

const commitTemplate = (kind: CommitKind) =>
  z.string().superRefine((value, ctx) => {
    const message = commitTemplateError(value, kind);
    if (message) ctx.addIssue({ code: 'custom', message });
  });

const workItemCommon = {
  branchPrefix: branchPrefix.default('work-item/'),
  featurePrefix: branchPrefix.default('feature/'),
  manifest: manifestTemplate.default('work-items/{id}-{slug}/sfpipe.yml'),
};

const azureBoardsSchema = z.strictObject({
  provider: z.literal('azure-boards'),
  organization: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'Oczekiwano nazwy organizacji ADO bez adresu URL, np. "contoso"')
    .optional(),
  project: z
    .string()
    .min(1)
    .refine((value) => !/[/\\]/.test(value), { message: 'Oczekiwano nazwy projektu, nie adresu URL ani ścieżki' })
    .optional(),
  ...workItemCommon,
});

const githubIssuesSchema = z.strictObject({
  provider: z.literal('github-issues'),
  label: z.string().min(1).default('user-story'),
  ...workItemCommon,
});

const commitsSchema = z
  .strictObject({
    workItem: commitTemplate('workItem').optional(),
    feature: commitTemplate('feature').optional(),
    maintenance: commitTemplate('maintenance').optional(),
  })
  .default({});

const configSchema = z
  .strictObject({
    workItem: z.discriminatedUnion('provider', [azureBoardsSchema, githubIssuesSchema]),
    commits: commitsSchema,
    baseBranch: branchName.default('main'),
    environments: z.record(
      z.string().regex(ENV_NAME_RE, 'Nazwa środowiska: małe litery, cyfry i "_", np. "uat"'),
      envSchema,
    ),
    tests: z
      .strictObject({
        naming: z.array(z.string().includes('{name}')).min(1).default(DEFAULT_TEST_NAMING),
      })
      .default({ naming: DEFAULT_TEST_NAMING }),
  })
  .superRefine((config, ctx) => {
    const entries = Object.entries(config.environments);
    const issue = (message: string, envName?: string) =>
      ctx.addIssue({ code: 'custom', message, path: envName ? ['environments', envName] : ['environments'] });

    const { workItem } = config;
    if (workItem.branchPrefix === workItem.featurePrefix) {
      ctx.addIssue({ code: 'custom', message: 'featurePrefix musi różnić się od branchPrefix', path: ['workItem', 'featurePrefix'] });
    }
    if (workItem.provider === 'azure-boards' && !workItem.organization !== !workItem.project) {
      ctx.addIssue({ code: 'custom', message: 'Podaj organization i project razem albo żadne z nich', path: ['workItem'] });
    }
    const prefixes = [workItem.branchPrefix, workItem.featurePrefix, ...RESERVED_PREFIXES];
    for (const [name, env] of entries) {
      const prefix = prefixes.find((candidate) => env.branch.startsWith(candidate));
      if (prefix) issue(`Gałąź środowiska nie może zaczynać się od "${prefix}" (prefiks gałęzi work itemów lub sfpipe)`, name);
    }

    if (entries.length < 2) {
      issue('Wymagane są co najmniej dwa środowiska');
      return;
    }

    const sources = entries.filter(([, env]) => env.role === 'source');
    if (sources.length > 1) issue(`Dozwolone jest jedno środowisko źródłowe, są: ${sources.map(([n]) => n).join(', ')}`);
    const firstSource = sources[0];
    if (firstSource && entries[0]?.[0] !== firstSource[0]) {
      issue('Środowisko źródłowe (role: source) musi być pierwsze na liście', firstSource[0]);
    }

    const baseEnvs = entries.filter(([, env]) => env.branch === config.baseBranch);
    if (baseEnvs.length !== 1) {
      issue(`Dokładnie jedno środowisko musi używać gałęzi bazowej "${config.baseBranch}" (produkcja)`);
    } else {
      const [baseName, baseEnv] = baseEnvs[0]!;
      if (entries.at(-1)?.[0] !== baseName) issue('Środowisko na gałęzi bazowej (produkcja) musi być ostatnie', baseName);
      if (baseEnv.role === 'source') issue('Produkcja nie może być środowiskiem źródłowym', baseName);
    }

    const seen = new Map<string, string>();
    const unique = (kind: string, value: string, envName: string) => {
      const owner = seen.get(`${kind}:${value}`);
      if (owner) issue(`${kind} "${value}" jest już użyty w środowisku "${owner}"`, envName);
      else seen.set(`${kind}:${value}`, envName);
    };

    let releaseSeen = false;
    for (const [name, env] of entries) {
      unique('Gałąź', env.branch, name);
      unique('Alias orga', env.org ?? defaultAlias(name), name);
      if (env.role !== 'target') continue;
      if (env.promotion === 'release') releaseSeen = true;
      else if (releaseSeen) issue('Środowiska z promotion: work-item muszą być przed środowiskami z promotion: release', name);
    }
  });

export type RawConfig = z.output<typeof configSchema>;

export type WorkItemConfig = RawConfig['workItem'];
export type WorkItemProvider = WorkItemConfig['provider'];

export interface CommitTemplates {
  /** Commit on a work-item branch, e.g. `[WI-{id}] {message} — AB#{id}`. */
  workItem: string;
  /** Commit on a feature branch (several work items delivered together). */
  feature: string;
  /** Commit without a work item: dev mirror, back-sync, baseline. */
  maintenance: string;
}

/**
 * Azure Boards defaults match the commit-msg hook of the harness repo:
 * `[chore|docs] …` or `[WI-<id>|FEATURE-<id>] … AB#<id>` with the same ID.
 */
export const DEFAULT_COMMITS: Record<WorkItemProvider, CommitTemplates> = {
  'azure-boards': {
    workItem: '[WI-{id}] {message} — AB#{id}',
    feature: '[FEATURE-{id}] {message} — AB#{id}',
    maintenance: '[chore] {message}',
  },
  'github-issues': {
    workItem: '{message} (#{id})',
    feature: '{message} (#{id})',
    maintenance: '{message}',
  },
};

interface ResolvedEnvBase {
  name: string;
  index: number;
  branch: string;
  /** sf CLI alias; also the name of the GitHub Environment holding the org's secrets. */
  orgAlias: string;
  isProduction: boolean;
}

export interface SourceEnv extends ResolvedEnvBase {
  role: 'source';
  mirror: z.output<typeof mirrorSchema>;
  users: Record<string, string>;
}

export interface TargetEnv extends ResolvedEnvBase {
  role: 'target';
  promotion: 'work-item' | 'release';
  testLevel: (typeof TEST_LEVELS)[number];
  deployWindow?: string;
  ignore: string[];
}

export type ResolvedEnv = SourceEnv | TargetEnv;

export interface ResolvedConfig {
  workItem: WorkItemConfig;
  /** Commit subject templates with provider defaults filled in. */
  commits: CommitTemplates;
  baseBranch: string;
  tests: RawConfig['tests'];
  /** Environments in promotion order (as declared in the file). */
  environments: ResolvedEnv[];
}

export interface LoadedConfig {
  /** Absolute path to `.sfpipe/config.yml`. */
  file: string;
  /** Directory that contains `.sfpipe/` (the Salesforce project root). */
  root: string;
  config: ResolvedConfig;
}

/** The org alias (and GitHub Environment name) defaults to `sf-<env>`, matching the workflows. */
export function defaultAlias(envName: string): string {
  return `sf-${envName}`;
}

export function parseConfig(source: string, file = CONFIG_FILE): ResolvedConfig {
  const doc = parseDocument(source, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new SfpipeError(
      `Błąd składni YAML w ${file}:\n${doc.errors.map((e) => `  ${e.message}`).join('\n')}`,
    );
  }
  const result = configSchema.safeParse(doc.toJS());
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      // Record key errors wrap the key schema's own (more specific) message.
      const nested = issue.code === 'invalid_key' ? issue.issues[0]?.message : undefined;
      return `  ${issue.path.length ? issue.path.join('.') : '(plik)'}: ${nested ?? issue.message}`;
    });
    throw new SfpipeError(`Nieprawidłowa konfiguracja w ${file}:\n${lines.join('\n')}`);
  }
  return resolve(result.data);
}

function resolve(raw: RawConfig): ResolvedConfig {
  const environments = Object.entries(raw.environments).map(([name, env], index): ResolvedEnv => {
    const base = {
      name,
      index,
      branch: env.branch,
      orgAlias: env.org ?? defaultAlias(name),
      isProduction: env.branch === raw.baseBranch,
    };
    if (env.role === 'source') return { ...base, role: 'source', mirror: env.mirror, users: env.users };
    return {
      ...base,
      role: 'target',
      promotion: env.promotion,
      testLevel: env.testLevel,
      deployWindow: env.deployWindow,
      ignore: env.ignore,
    };
  });
  return {
    workItem: raw.workItem,
    commits: { ...DEFAULT_COMMITS[raw.workItem.provider], ...definedOnly(raw.commits) },
    baseBranch: raw.baseBranch,
    tests: raw.tests,
    environments,
  };
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Walks up from `startDir` to the nearest directory containing `.sfpipe/config.yml`. */
export function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(startDir: string): Promise<LoadedConfig> {
  const file = findConfigFile(startDir);
  if (!file) {
    throw new SfpipeError(
      `Nie znaleziono ${CONFIG_DIR}/${CONFIG_FILE} w ${path.resolve(startDir)} ani w katalogach nadrzędnych`,
      'Uruchom "sfpipe init" w katalogu głównym projektu Salesforce',
    );
  }
  const config = parseConfig(await readFile(file, 'utf8'), file);
  return { file, root: path.dirname(path.dirname(file)), config };
}
