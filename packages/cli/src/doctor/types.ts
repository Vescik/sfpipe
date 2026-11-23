import type { LoadedConfig } from '../core/config.js';
import type { SfpipeError } from '../core/errors.js';
import type { Exec } from '../core/exec.js';

export type Status = 'ok' | 'warn' | 'error' | 'skip';

export interface CheckResult {
  group: GroupId;
  title: string;
  status: Status;
  detail?: string;
  hint?: string;
}

export const GROUP_IDS = ['tools', 'repo', 'branches', 'orgs', 'github'] as const;
export type GroupId = (typeof GROUP_IDS)[number];

export interface DoctorContext {
  cwd: string;
  exec: Exec;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  loaded?: LoadedConfig;
  configError?: SfpipeError;
  /** Limits org checks to these environment names. */
  envFilter?: string[];
}

export interface CheckGroup {
  id: GroupId;
  title: string;
  run(ctx: DoctorContext): Promise<CheckResult[]>;
}
