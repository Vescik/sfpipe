#!/usr/bin/env bash
# Lokalna próba fazy 0 (docs/runbooks/faza-0.md) bez GitHuba i orgów Salesforce.
#
# Buduje w .sandbox/:
#   sfpipe-<wersja>.tgz      paczka CLI, tak jak publikuje ją workflow release
#   tools/                   CLI zainstalowane z tej paczki (source .sandbox/env.sh)
#   remotes/salesforce.git   bare repo w roli repo salesforce na GitHubie
#   salesforce/              lokalny klon dewelopera
#   doctor.txt               raport końcowy doctora
#
# Użycie: npm run sandbox   albo   scripts/sandbox.sh [katalog]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="${1:-$REPO_ROOT/.sandbox}"
MARKER=.sfpipe-sandbox

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
# Commity piaskownicy nie muszą być podpisane.
g() { git -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }

if [[ -e "$SANDBOX" ]]; then
  if [[ ! -f "$SANDBOX/$MARKER" ]]; then
    echo "✖ $SANDBOX istnieje i nie jest piaskownicą sfpipe; przerywam" >&2
    exit 1
  fi
  rm -rf "$SANDBOX"
fi
mkdir -p "$SANDBOX/remotes" "$SANDBOX/tools"
SANDBOX="$(cd "$SANDBOX" && pwd)"
touch "$SANDBOX/$MARKER"

step "Krok 1: wydanie CLI (npm pack zamiast GitHub Packages)"
(cd "$REPO_ROOT/packages/cli" && npm pack --pack-destination "$SANDBOX" --silent >/dev/null)
TARBALL="$(ls "$SANDBOX"/sfpipe-*.tgz)"
npm install --prefix "$SANDBOX/tools" --no-audit --no-fund --silent "$TARBALL"
export PATH="$SANDBOX/tools/node_modules/.bin:$PATH"
printf 'export PATH="%s/tools/node_modules/.bin:$PATH"\n' "$SANDBOX" > "$SANDBOX/env.sh"
note "$(basename "$TARBALL") → sfpipe $(sfpipe --version)"

step "Krok 2: repo salesforce (bare repo zamiast GitHuba)"
g init --quiet --bare --initial-branch=main "$SANDBOX/remotes/salesforce.git"
WORK="$SANDBOX/salesforce"
g init --quiet --initial-branch=main "$WORK"
cd "$WORK"
git config user.name >/dev/null || git config user.name "sfpipe sandbox"
git config user.email >/dev/null || git config user.email "sandbox@sfpipe.invalid"
git remote add origin "$SANDBOX/remotes/salesforce.git"
EXAMPLE="$REPO_ROOT/examples/sfdx-project"
cp "$EXAMPLE/sfdx-project.json" "$EXAMPLE/.forceignore" .
cp -R "$EXAMPLE/force-app" .
g add -A
g commit --quiet -m "Metadane sprzed sfpipe"
g push --quiet -u origin main
note "sfpipe doctor --only tools repo (przed init błąd konfiguracji jest oczekiwany)"
sfpipe doctor --only tools repo || true

step "Krok 2.4: sfpipe init na gałęzi i merge commit (zamiast PR)"
g switch --quiet -c chore/sfpipe-init
sfpipe init
perl -0pi -e 's/^    users: \{\}$/    users:\n      jan.kowalski\@firma.pl.dev: jan.kowalski\@firma.pl/m' .sfpipe/config.yml
grep -q 'jan.kowalski@firma.pl.dev' .sfpipe/config.yml || { echo "✖ nie udało się uzupełnić users" >&2; exit 1; }
mkdir -p .github/workflows
cp "$EXAMPLE/.github/workflows/sfpipe-doctor.yml" .github/workflows/
sfpipe config validate
g add -A
g commit --quiet -m "sfpipe: konfiguracja i workflow doctor"
g switch --quiet main
g merge --quiet --no-ff -m "Merge: sfpipe init" chore/sfpipe-init
g branch --quiet -d chore/sfpipe-init
g push --quiet origin main

step "Kroki 7–8: baseline uat, stage i dev od main (bez retrieve z orgów)"
for branch in uat stage dev; do
  g branch --quiet "$branch" main
  g push --quiet -u origin "$branch"
  note "origin/$branch"
done

step "Krok 10: to, co robi workflow doctor.yml"
note "environments=$(sfpipe config validate --json | jq -c '[.config.environments[] | {name, alias: .orgAlias}]')"
sfpipe doctor | tee "$SANDBOX/doctor.txt" || true

step "Gotowe"
cat <<EOF
  Piaskownica: $SANDBOX
  Raport:      $SANDBOX/doctor.txt
  CLI w PATH:  source $SANDBOX/env.sh

  Lokalnie nie da się odtworzyć (robimy razem na GitHubie i w orgach):
    krok 1        repo sfpipe na GitHubie, tag i publikacja do GitHub Packages
    krok 3        logowanie JWT do orgów          → grupa "Orgi" w doctorze
    kroki 4–6, 9  Environments, App, labele, rulesety → grupa "GitHub"
    kroki 7–8     retrieve z orgów (tu uat, stage i dev są kopią main)
EOF
