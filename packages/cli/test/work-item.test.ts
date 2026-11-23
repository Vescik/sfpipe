import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMITS, parseConfig, type WorkItemConfig } from '../src/core/config.js';
import {
  commitTemplateError,
  findDuplicateWorkItemFolders,
  formatCommitSubject,
  manifestBaseDir,
  manifestTemplateError,
  parseWorkItemBranch,
  resolveManifestPath,
  workItemBranch,
  workItemReference,
  workItemUrl,
} from '../src/core/work-item.js';
import { readTemplate, tempDir } from './helpers.js';

const { workItem } = parseConfig(await readTemplate());
const MANIFEST = workItem.manifest;

/** Port of message_error() from the harness scripts/git_workflow_policy.py (commit-msg hook). */
function harnessAccepts(subject: string): boolean {
  if (/^\[(?:chore|docs)\] \S.*$/.test(subject)) return true;
  const match = /^\[(WI|FEATURE)-([1-9][0-9]*)\] \S.*$/.exec(subject);
  if (!match) return false;
  const references = new Set([...subject.matchAll(/\bAB#([0-9]+)\b/g)].map((m) => m[1]));
  return references.size === 1 && references.has(match[2]);
}

describe('work-item branches', () => {
  it('parses work-item and feature branches with and without a description', () => {
    expect(parseWorkItemBranch('work-item/5001-rabat-na-opportunity', workItem)).toEqual({
      kind: 'work-item',
      id: 5001,
      slug: 'rabat-na-opportunity',
    });
    expect(parseWorkItemBranch('feature/5000-faktury', workItem)).toEqual({ kind: 'feature', id: 5000, slug: 'faktury' });
    expect(parseWorkItemBranch('work-item/42', workItem)).toEqual({ kind: 'work-item', id: 42, slug: undefined });
  });

  it('ignores other branches and malformed IDs', () => {
    for (const branch of ['main', 'chore/cleanup', 'work-item/abc', 'work-item/0123-x', 'work-item/5001-a/b', 'promote/5001/uat']) {
      expect(parseWorkItemBranch(branch, workItem)).toBeUndefined();
    }
  });

  it('builds branch names back from a reference', () => {
    expect(workItemBranch({ kind: 'work-item', id: 5001, slug: 'rabat' }, workItem)).toBe('work-item/5001-rabat');
    expect(workItemBranch({ kind: 'feature', id: 5000 }, workItem)).toBe('feature/5000');
  });

  it('links Azure Boards items by AB# and URL', () => {
    const ado: WorkItemConfig = { ...workItem, provider: 'azure-boards', organization: 'contoso', project: 'Sales Force' };
    expect(workItemReference(5001, ado)).toBe('AB#5001');
    expect(workItemUrl(5001, ado)).toBe('https://dev.azure.com/contoso/Sales%20Force/_workitems/edit/5001');
    expect(workItemUrl(5001, workItem)).toBeUndefined();
  });
});

describe('commit subjects', () => {
  const templates = DEFAULT_COMMITS['azure-boards'];

  it('default Azure Boards subjects pass the harness commit-msg hook', () => {
    const subjects = [
      formatCommitSubject(templates, 'workItem', 'add ApexClass:DiscountService from dev', 5001),
      formatCommitSubject(templates, 'feature', 'merge main', 5000),
      formatCommitSubject(templates, 'maintenance', 'dev mirror: 3 components by Jan Kowalski'),
    ];
    expect(subjects).toEqual([
      '[WI-5001] add ApexClass:DiscountService from dev — AB#5001',
      '[FEATURE-5000] merge main — AB#5000',
      '[chore] dev mirror: 3 components by Jan Kowalski',
    ]);
    expect(subjects.every(harnessAccepts)).toBe(true);
  });

  it('keeps the message on one line and placeholders in the message literal', () => {
    expect(formatCommitSubject(templates, 'workItem', '  fix\n  {id} handling ', 7)).toBe('[WI-7] fix {id} handling — AB#7');
    expect(() => formatCommitSubject(templates, 'workItem', 'x')).toThrow(/wymaga ID/);
    expect(() => formatCommitSubject(templates, 'maintenance', '   ')).toThrow(/pusty/);
  });

  it('validates templates', () => {
    expect(commitTemplateError('[WI-{id}] {message}', 'workItem')).toBeUndefined();
    expect(commitTemplateError('{message}', 'workItem')).toMatch(/\{id\}/);
    expect(commitTemplateError('[chore] {message} {id}', 'maintenance')).toMatch(/nie może zawierać \{id\}/);
    expect(commitTemplateError('{id} {title}', 'feature')).toMatch(/\{title\}/);
    expect(commitTemplateError('{message}\n{id}', 'workItem')).toMatch(/jedną linią/);
  });
});

describe('manifest location', () => {
  it('validates the path template', () => {
    expect(manifestTemplateError(MANIFEST)).toBeUndefined();
    expect(manifestTemplateError('.sfpipe/work-items/{id}.yml')).toBeUndefined();
    expect(manifestTemplateError('/work-items/{id}.yml')).toMatch(/względna/);
    expect(manifestTemplateError('work-items\\{id}.yml')).toMatch(/względna/);
    expect(manifestTemplateError('work-items/../{id}.yml')).toMatch(/"\."/);
    expect(manifestTemplateError('work-items/{id}.json')).toMatch(/\.yml/);
    expect(manifestTemplateError('work-items/sfpipe.yml')).toMatch(/dokładnie jedno \{id\}/);
    expect(manifestTemplateError('work-items/{slug}/{id}.yml')).toMatch(/\{id\}-\{slug\}/);
    expect(manifestTemplateError('work-items/{id}-{title}/sfpipe.yml')).toMatch(/\{title\}/);
  });

  it('creates a folder from the branch description when none exists', () => {
    const root = tempDir();
    expect(resolveManifestPath(root, MANIFEST, { id: 5001, slug: 'rabat' })).toEqual({
      path: 'work-items/5001-rabat/sfpipe.yml',
      exists: false,
    });
    expect(() => resolveManifestPath(root, MANIFEST, { id: 5001 })).toThrow(/nie ma opisu/);
  });

  it('reuses the existing folder of the ID even when its description differs', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'work-items', '5001-approval-notifications'), { recursive: true });
    mkdirSync(path.join(root, 'work-items', '50012-other'), { recursive: true });
    writeFileSync(path.join(root, 'work-items', '5001-approval-notifications', 'sfpipe.yml'), 'id: 5001\n');
    expect(resolveManifestPath(root, MANIFEST, { id: 5001, slug: 'rabat' })).toEqual({
      path: 'work-items/5001-approval-notifications/sfpipe.yml',
      exists: true,
    });
    expect(resolveManifestPath(root, MANIFEST, { id: 50012 }).path).toBe('work-items/50012-other/sfpipe.yml');
  });

  it('stops on duplicate folders for one ID and reports them', () => {
    const root = tempDir();
    for (const name of ['5001-a', '5001-b', '5002-c']) mkdirSync(path.join(root, 'work-items', name), { recursive: true });
    expect(() => resolveManifestPath(root, MANIFEST, { id: 5001, slug: 'a' })).toThrow(/5001-a, work-items\/5001-b/);
    expect(findDuplicateWorkItemFolders(root, MANIFEST)).toEqual(new Map([[5001, ['5001-a', '5001-b']]]));
    expect(findDuplicateWorkItemFolders(root, '.sfpipe/work-items/{id}.yml').size).toBe(0);
  });

  it('knows the directory that holds work-item folders', () => {
    expect(manifestBaseDir(MANIFEST)).toBe('work-items');
    expect(manifestBaseDir('{id}-{slug}.yml')).toBe('');
  });
});
