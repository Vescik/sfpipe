import { compareVersions, Git } from '../../core/git.js';
import { SfCli } from '../../core/sf.js';
import type { CheckGroup, CheckResult } from '../types.js';

const MIN_NODE = '22.0.0';
/** `git merge-tree --write-tree` is needed for package previews. */
const MIN_GIT = '2.38.0';

export const toolsCheck: CheckGroup = {
  id: 'tools',
  title: 'Narzędzia',
  async run(ctx) {
    const group = 'tools';
    const results: CheckResult[] = [];
    const sf = new SfCli(ctx.exec, ctx.cwd);

    const node = process.versions.node;
    results.push(
      compareVersions(node, MIN_NODE) >= 0
        ? { group, title: 'Node.js', status: 'ok', detail: node }
        : { group, title: 'Node.js', status: 'error', detail: `${node}, wymagane ${MIN_NODE}+`, hint: 'Zainstaluj Node.js 24 LTS' },
    );

    const [gitVersion, sfVersion, plugins] = await Promise.all([new Git(ctx.exec, ctx.cwd).version(), sf.version(), sf.plugins()]);

    if (!gitVersion) {
      results.push({ group, title: 'git', status: 'error', detail: 'nie znaleziono', hint: 'Zainstaluj git 2.38 lub nowszy' });
    } else if (compareVersions(gitVersion, MIN_GIT) < 0) {
      results.push({ group, title: 'git', status: 'error', detail: `${gitVersion}, wymagane ${MIN_GIT}+`, hint: 'Zaktualizuj git' });
    } else {
      results.push({ group, title: 'git', status: 'ok', detail: gitVersion });
    }

    if (!sfVersion) {
      results.push({
        group,
        title: 'Salesforce CLI',
        status: 'error',
        detail: 'nie znaleziono',
        hint: 'npm install --global @salesforce/cli',
      });
      results.push({ group, title: 'sfdx-git-delta', status: 'skip', detail: 'wymaga Salesforce CLI' });
      return results;
    }
    results.push({ group, title: 'Salesforce CLI', status: 'ok', detail: sfVersion });

    const sgd = plugins?.get('sfdx-git-delta');
    results.push(
      sgd
        ? { group, title: 'sfdx-git-delta', status: 'ok', detail: sgd }
        : {
            group,
            title: 'sfdx-git-delta',
            status: 'error',
            detail: 'plugin nie jest zainstalowany',
            hint: 'echo y | sf plugins install sfdx-git-delta',
          },
    );
    return results;
  },
};
