import { branchesCheck } from './checks/branches.js';
import { githubCheck } from './checks/github.js';
import { orgsCheck } from './checks/orgs.js';
import { repoCheck } from './checks/repo.js';
import { toolsCheck } from './checks/tools.js';
import type { CheckGroup, CheckResult, DoctorContext, GroupId, Status } from './types.js';

export const CHECK_GROUPS: CheckGroup[] = [toolsCheck, repoCheck, branchesCheck, orgsCheck, githubCheck];

export interface DoctorReport {
  ok: boolean;
  summary: Record<Status, number>;
  groups: Array<{ id: GroupId; title: string; results: CheckResult[] }>;
}

export async function runDoctor(ctx: DoctorContext, only?: GroupId[]): Promise<DoctorReport> {
  const groups = CHECK_GROUPS.filter((g) => !only || only.includes(g.id));
  const ran = await Promise.all(
    groups.map(async (group) => {
      try {
        return { id: group.id, title: group.title, results: await group.run(ctx) };
      } catch (error) {
        const result: CheckResult = {
          group: group.id,
          title: group.title,
          status: 'error',
          detail: `nieoczekiwany błąd: ${(error as Error).message}`,
        };
        return { id: group.id, title: group.title, results: [result] };
      }
    }),
  );
  const summary: Record<Status, number> = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const result of ran.flatMap((g) => g.results)) summary[result.status]++;
  return { ok: summary.error === 0, summary, groups: ran };
}
