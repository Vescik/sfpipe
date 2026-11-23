import type { ResolvedEnv, SourceEnv, TargetEnv } from '../../core/config.js';
import type { CheckResult, Status } from '../../doctor/types.js';
import type { BranchRule, EnvironmentInfo } from './client.js';

/** Secrets every `sf-<env>` GitHub Environment must hold for the sf-login action. */
export const ORG_SECRETS = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_INSTANCE_URL', 'SF_JWT_KEY'] as const;

/** Part of the required status check name produced by the sfpipe-pr workflow. */
export const DEPLOY_CHECK = 'sfpipe-pr';

type Add = (title: string, status: Status, detail?: string, hint?: string) => void;

function collector(prefix: string, results: CheckResult[]): Add {
  return (title, status, detail, hint) => results.push({ group: 'github', title: `${prefix}: ${title}`, status, detail, hint });
}

const find = (rules: BranchRule[], type: string) => rules.filter((r) => r.type === type);

/** Rules required on uat/stage/main by docs/PLAN.md §11.2. */
export function evaluateTargetRules(env: TargetEnv, rules: BranchRule[]): CheckResult[] {
  const results: CheckResult[] = [];
  const add = collector(env.branch, results);

  const pr = find(rules, 'pull_request')[0];
  if (!pr) {
    add('wymagany PR', 'error', 'brak reguły', 'Ruleset: Require a pull request before merging');
  } else {
    const p = pr.parameters ?? {};
    const methods = Array.isArray(p.allowed_merge_methods) ? (p.allowed_merge_methods as string[]) : undefined;
    if (!methods) {
      add('metody merge', 'warn', 'ruleset nie ogranicza metod merge', 'Allowed merge methods: tylko Merge');
    } else if (methods.some((m) => m !== 'merge') || !methods.includes('merge')) {
      add('metody merge', 'error', `dozwolone: ${methods.join(', ')}`, 'Allowed merge methods: tylko Merge (bez squash i rebase)');
    } else {
      add('metody merge', 'ok', 'tylko merge commit');
    }

    if (env.promotion === 'work-item') {
      const approvals = Number(p.required_approving_review_count ?? 0);
      if (approvals < 1) add('code review', 'error', 'brak wymaganego approve', 'Required approvals: 1');
      else add('code review', 'ok', `min. ${approvals} approve`);
      if (p.required_review_thread_resolution !== true) {
        add('rozwiązane wątki', 'warn', 'nie są wymagane', 'Require conversation resolution before merging');
      } else {
        add('rozwiązane wątki', 'ok');
      }
    } else {
      add('wymagany PR', 'ok');
    }
  }

  if (find(rules, 'required_linear_history').length > 0) {
    add('liniowa historia', 'error', 'reguła blokuje merge commity, na których opiera się model', 'Usuń Require linear history');
  }

  const checks = find(rules, 'required_status_checks');
  const contexts = checks.flatMap((r) =>
    ((r.parameters?.required_status_checks as Array<{ context?: string }> | undefined) ?? []).map((c) => c.context ?? ''),
  );
  if (!contexts.some((c) => c.includes(DEPLOY_CHECK))) {
    add('check deployu', 'error', `brak wymaganego checku ${DEPLOY_CHECK}`, `Require status checks: check z workflowu ${DEPLOY_CHECK}`);
  } else if (!checks.some((r) => r.parameters?.strict_required_status_checks_policy === true)) {
    add('check deployu', 'error', 'PR nie musi być aktualny względem gałęzi', 'Włącz Require branches to be up to date before merging');
  } else {
    add('check deployu', 'ok', 'wymagany, PR musi być aktualny');
  }

  if (find(rules, 'merge_queue').length > 0) {
    add('merge queue', 'warn', 'merge queue ponownie uruchomi deploy', 'Wyłącz merge queue na gałęziach środowisk');
  }

  addProtection(add, rules);
  return results;
}

/** The mirror branch takes pushes only from the mirror workflow. */
export function evaluateSourceRules(env: SourceEnv, rules: BranchRule[]): CheckResult[] {
  const results: CheckResult[] = [];
  const add = collector(env.branch, results);
  if (find(rules, 'update').length === 0) {
    add('push tylko z workflowu', 'warn', 'każdy z prawem zapisu może pushować do lustra', 'Ruleset: Restrict updates, bypass tylko dla GitHub App lustra');
  } else {
    add('push tylko z workflowu', 'ok');
  }
  addProtection(add, rules);
  return results;
}

function addProtection(add: Add, rules: BranchRule[]) {
  const missing = [
    find(rules, 'non_fast_forward').length === 0 ? 'force push' : undefined,
    find(rules, 'deletion').length === 0 ? 'usuwanie' : undefined,
  ].filter(Boolean);
  if (missing.length > 0) add('ochrona gałęzi', 'error', `niezablokowane: ${missing.join(', ')}`, 'Ruleset: Block force pushes i Restrict deletions');
  else add('ochrona gałęzi', 'ok', 'force push i usuwanie zablokowane');
}

/** Environments from docs/PLAN.md §11.4; `secrets` is undefined where the token cannot list them. */
export function evaluateEnvironments(
  envs: ResolvedEnv[],
  environments: EnvironmentInfo[],
  secrets: Map<string, Set<string> | undefined>,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const env of envs) {
    const add = collector(`Environment ${env.orgAlias}`, results);
    const info = environments.find((e) => e.name === env.orgAlias);
    if (!info) {
      add('istnieje', 'error', 'brak Environment', `Settings → Environments → New environment: ${env.orgAlias}`);
      continue;
    }

    const reviewers = info.protection_rules?.find((r) => r.type === 'required_reviewers');
    if (env.role === 'source') {
      add('reviewerzy', 'ok', 'bez akceptacji (lustro)');
    } else if (!reviewers) {
      add('reviewerzy', 'error', 'brak required reviewers', env.isProduction ? 'Required reviewers: Product Owner' : 'Required reviewers: zespół Developers');
    } else if (env.isProduction && reviewers.prevent_self_review !== true) {
      add('reviewerzy', 'warn', 'osoba uruchamiająca może sama zatwierdzić', 'Włącz Prevent self-review');
    } else {
      add('reviewerzy', 'ok');
    }

    const names = secrets.get(env.orgAlias);
    if (!names) {
      add('sekrety', 'skip', 'token nie ma dostępu do listy sekretów');
    } else {
      const missing = ORG_SECRETS.filter((s) => !names.has(s));
      if (missing.length > 0) add('sekrety', 'error', `brak: ${missing.join(', ')}`, 'docs/runbooks/faza-0.md, krok 4');
      else add('sekrety', 'ok', ORG_SECRETS.join(', '));
    }
  }
  return results;
}
