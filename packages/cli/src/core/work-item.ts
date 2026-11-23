import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { CommitTemplates, WorkItemConfig } from './config.js';
import { SfpipeError } from './errors.js';

/** `work-item` = one User Story or Bug; `feature` = several work items delivered together. */
export type WorkItemKind = 'work-item' | 'feature';

export interface WorkItemRef {
  kind: WorkItemKind;
  id: number;
  /** Description part of the branch name, e.g. `rabat-na-opportunity`. */
  slug?: string;
}

export type CommitKind = keyof CommitTemplates;

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const BRANCH_REST_RE = /^([1-9][0-9]*)(?:-([^/]+))?$/;

const placeholders = (template: string) => [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1] ?? '');

/** Reads `<prefix><id>[-<slug>]`; undefined for branches that are not work-item or feature branches. */
export function parseWorkItemBranch(branch: string, workItem: WorkItemConfig): WorkItemRef | undefined {
  const prefixes = [
    ['work-item', workItem.branchPrefix],
    ['feature', workItem.featurePrefix],
  ] as const;
  for (const [kind, prefix] of prefixes) {
    if (!branch.startsWith(prefix)) continue;
    const match = BRANCH_REST_RE.exec(branch.slice(prefix.length));
    if (!match) return undefined;
    return { kind, id: Number(match[1]), slug: match[2] };
  }
  return undefined;
}

export function workItemBranch(ref: WorkItemRef, workItem: WorkItemConfig): string {
  const prefix = ref.kind === 'feature' ? workItem.featurePrefix : workItem.branchPrefix;
  return `${prefix}${ref.id}${ref.slug ? `-${ref.slug}` : ''}`;
}

/** Text that links a commit or PR to the work item: `AB#123` (Azure Boards) or `#123` (GitHub Issues). */
export function workItemReference(id: number, workItem: WorkItemConfig): string {
  return workItem.provider === 'azure-boards' ? `AB#${id}` : `#${id}`;
}

export function workItemUrl(id: number, workItem: WorkItemConfig): string | undefined {
  if (workItem.provider !== 'azure-boards' || !workItem.organization || !workItem.project) return undefined;
  const org = encodeURIComponent(workItem.organization);
  const project = encodeURIComponent(workItem.project);
  return `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`;
}

export const commitKindOf = (ref: WorkItemRef): CommitKind => (ref.kind === 'feature' ? 'feature' : 'workItem');

/** Builds a one-line commit subject from the configured template. */
export function formatCommitSubject(templates: CommitTemplates, kind: CommitKind, message: string, id?: number): string {
  const text = message.trim().replace(/\s+/g, ' ');
  if (!text) throw new SfpipeError('Opis commitu nie może być pusty');
  if (kind !== 'maintenance' && id === undefined) throw new SfpipeError(`Commit typu ${kind} wymaga ID work itemu`);
  // One pass, so "{id}" typed inside the message stays literal.
  return templates[kind].replace(PLACEHOLDER_RE, (whole, name: string) =>
    name === 'id' ? String(id) : name === 'message' ? text : whole,
  );
}

export function commitTemplateError(template: string, kind: CommitKind): string | undefined {
  if (/[\r\n]/.test(template)) return 'Szablon commitu musi być jedną linią';
  const names = placeholders(template);
  const unknown = names.find((name) => name !== 'id' && name !== 'message');
  if (unknown !== undefined) return `Nieznany znacznik {${unknown}}; dozwolone: {id}, {message}`;
  if (!names.includes('message')) return 'Szablon commitu musi zawierać {message}';
  if (kind === 'maintenance') {
    return names.includes('id') ? 'Szablon commitu bez work itemu nie może zawierać {id}' : undefined;
  }
  return names.includes('id') ? undefined : 'Szablon commitu work itemu musi zawierać {id}';
}

export function manifestTemplateError(template: string): string | undefined {
  if (template.includes('\\') || template.startsWith('/') || /^[A-Za-z]:/.test(template)) {
    return 'Ścieżka manifestu musi być względna, z "/" jako separatorem, np. "work-items/{id}-{slug}/sfpipe.yml"';
  }
  const segments = template.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'Ścieżka manifestu nie może zawierać pustych segmentów ani "." i ".."';
  }
  if (!/\.ya?ml$/.test(template)) return 'Manifest musi mieć rozszerzenie .yml lub .yaml';
  const names = placeholders(template);
  const unknown = names.find((name) => name !== 'id' && name !== 'slug');
  if (unknown !== undefined) return `Nieznany znacznik {${unknown}}; dozwolone: {id}, {slug}`;
  if (names.filter((name) => name === 'id').length !== 1) return 'Ścieżka manifestu musi zawierać dokładnie jedno {id}';
  const slugs = names.filter((name) => name === 'slug').length;
  if (slugs > 1 || (slugs === 1 && !segments.some((segment) => segment.includes('{id}-{slug}')))) {
    return '"{slug}" można użyć tylko raz, jako "{id}-{slug}", np. "work-items/{id}-{slug}/sfpipe.yml"';
  }
  return undefined;
}

export interface ManifestLocation {
  /** Path relative to the project root, with "/" separators. */
  path: string;
  exists: boolean;
}

/**
 * Resolves the manifest path for a work item. A `{id}-{slug}` segment reuses the existing
 * folder of that ID even when its description differs from the branch (folders are stable by
 * ID); it stops on duplicates instead of guessing.
 */
export function resolveManifestPath(root: string, template: string, ref: { id: number; slug?: string }): ManifestLocation {
  const resolved: string[] = [];
  for (const segment of template.split('/')) {
    if (!segment.includes('{slug}')) {
      resolved.push(segment.replace('{id}', String(ref.id)));
      continue;
    }
    const matcher = segmentMatcher(segment, String(ref.id));
    const matches = entries(path.join(root, ...resolved)).filter((name) => matcher.test(name));
    if (matches.length > 1) {
      throw new SfpipeError(
        `Work item ${ref.id} ma kilka folderów: ${matches.map((name) => [...resolved, name].join('/')).join(', ')}`,
        'Zostaw jeden folder na work item; sfpipe nie wybiera za Ciebie',
      );
    }
    if (matches[0] !== undefined) {
      resolved.push(matches[0]);
      continue;
    }
    if (!ref.slug) {
      throw new SfpipeError(
        `Brak folderu dla work itemu ${ref.id}, a gałąź nie ma opisu, z którego można go nazwać`,
        'Użyj gałęzi w postaci <prefiks><id>-<opis>, np. work-item/5001-rabat',
      );
    }
    resolved.push(segment.replace('{id}', String(ref.id)).replace('{slug}', ref.slug));
  }
  const relative = resolved.join('/');
  return { path: relative, exists: existsSync(path.join(root, ...resolved)) };
}

/** Directory scanned for work-item folders: the static part of the template before `{id}`. */
export function manifestBaseDir(template: string): string {
  const segments = template.split('/');
  return segments.slice(0, segments.findIndex((segment) => segment.includes('{id}'))).join('/');
}

/** IDs that have more than one `{id}-{slug}` folder or file. */
export function findDuplicateWorkItemFolders(root: string, template: string): Map<number, string[]> {
  const duplicates = new Map<number, string[]>();
  const segments = template.split('/');
  const index = segments.findIndex((segment) => segment.includes('{slug}'));
  const segment = segments[index];
  if (segment === undefined) return duplicates;

  const matcher = segmentMatcher(segment, '([1-9][0-9]*)');
  const byId = new Map<number, string[]>();
  for (const name of entries(path.join(root, ...segments.slice(0, index)))) {
    const id = matcher.exec(name)?.[1];
    if (id) byId.set(Number(id), [...(byId.get(Number(id)) ?? []), name]);
  }
  for (const [id, names] of byId) if (names.length > 1) duplicates.set(id, names.sort());
  return duplicates;
}

/** Regex for one template segment; `idPattern` is a literal ID or a capturing group. */
function segmentMatcher(segment: string, idPattern: string): RegExp {
  const source = segment
    .split(/(\{id\}|\{slug\})/)
    .map((part) => (part === '{id}' ? idPattern : part === '{slug}' ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
