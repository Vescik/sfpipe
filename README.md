# sfpipe

Pipeline wdrożeń Salesforce oparty na work-itemach (1 User Story = 1 gałąź), dla czterech środowisk `dev → uat → stage → prod`, na GitHubie (Actions, Environments). User Story w Azure Boards (`AB#<id>`); konwencje gałęzi, manifestów i commitów zgodne z repo w układzie harnessu (docs/PLAN.md §16).

- Plan funkcjonalności: [docs/PLAN.md](docs/PLAN.md)
- Faza 0, kroki do wykonania w GitHubie i Salesforce: [docs/runbooks/faza-0.md](docs/runbooks/faza-0.md)

## Stan

Faza 0: szkielet CLI, konfiguracja i `sfpipe doctor`.

| Komenda | Co robi |
|---|---|
| `sfpipe init` | tworzy `.sfpipe/config.yml` w projekcie Salesforce |
| `sfpipe config validate [--json]` | sprawdza konfigurację i pokazuje środowiska |
| `sfpipe doctor [--only <grupy…>] [--env <środowiska…>] [--json]` | sprawdza narzędzia, repo, gałęzie, orgi oraz rulesety i Environments na GitHubie |

Grupy doctora: `tools`, `repo`, `branches`, `orgs`, `github`. Sprawdzenia GitHuba używają `GH_TOKEN` lub `GITHUB_TOKEN`, np. `GH_TOKEN="$(gh auth token)" sfpipe doctor`.

## Struktura

```
packages/cli/            CLI sfpipe (TypeScript, Node 22+)
  src/core/              konfiguracja, git, sf CLI, okno deployu
  src/adapters/github/   API GitHuba: rulesety, Environments
  src/doctor/            sprawdzenia doctora
  templates/config.yml   szablon dla `sfpipe init`
.github/workflows/       ci, release (GitHub Packages), doctor (reużywalny)
examples/sfdx-project/   przykładowy projekt Salesforce z konfiguracją i workflowem
docs/                    plan i runbooki
scripts/sandbox.sh       lokalna próba fazy 0
```

## Rozwój

```bash
npm install
npm run typecheck
npm test
npm run build
node packages/cli/dist/cli.js --help
npm run sandbox    # próba fazy 0 w .sandbox/ (bez GitHuba i orgów)
```

Wydanie: podbij wersję w `packages/cli/package.json` i wypchnij tag `vX.Y.Z`; workflow `release` opublikuje `@<owner>/sfpipe` do GitHub Packages.
