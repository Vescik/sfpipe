import { loadConfig, type LoadedConfig } from '../core/config.js';
import { SfpipeError } from '../core/errors.js';
import { formatActionsAnnotations, formatReport } from '../doctor/report.js';
import { runDoctor } from '../doctor/run.js';
import type { GroupId } from '../doctor/types.js';
import type { Io } from '../io.js';

export interface DoctorOptions {
  cwd: string;
  only?: GroupId[];
  env?: string[];
  json: boolean;
}

export async function doctorCommand(options: DoctorOptions, io: Io): Promise<number> {
  let loaded: LoadedConfig | undefined;
  let configError: SfpipeError | undefined;
  try {
    loaded = await loadConfig(options.cwd);
  } catch (error) {
    if (!(error instanceof SfpipeError)) throw error;
    configError = error;
  }

  if (options.env && loaded) {
    const known = loaded.config.environments.map((e) => e.name);
    const unknown = options.env.filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      throw new SfpipeError(`Nieznane środowisko: ${unknown.join(', ')}`, `Dostępne: ${known.join(', ')}`);
    }
  }

  const report = await runDoctor(
    { cwd: options.cwd, exec: io.exec, fetch: io.fetch, env: io.env, loaded, configError, envFilter: options.env },
    options.only,
  );

  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatReport(report, { color: io.color }));
    if (io.env.GITHUB_ACTIONS === 'true') for (const line of formatActionsAnnotations(report)) io.out(line);
  }
  return report.ok ? 0 : 1;
}
