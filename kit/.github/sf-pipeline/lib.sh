#!/usr/bin/env bash
# Wspólne funkcje skryptów promote.sh, release.sh i back-sync.sh.
# Wymagają: git, jq, gh (GH_TOKEN z uprawnieniem do PR-ów). Działają też w bash 3.2.
set -euo pipefail

PIPELINE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG=${SF_PIPELINE_CONFIG:-$PIPELINE_DIR/config.json}

summary() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

fail() {
  printf '::error::%s\n' "$1" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '❌ %s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 1
}

cfg() { jq -er "$1" "$CONFIG"; }

valid_id() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]*$' || fail "Nieprawidłowe ID work itemu: \"$1\" (oczekiwano liczby, np. 5001)"
}

git_identity() {
  git config user.name "${SF_PIPELINE_GIT_NAME:-github-actions[bot]}"
  git config user.email "${SF_PIPELINE_GIT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
}

# subject <workItem|feature|maintenance> <opis> [id]: temat commitu z szablonu w config.json
subject() {
  jq -er --arg kind "$1" --arg message "$2" --arg id "${3:-}" \
    '.commits[$kind] | gsub("\\{message\\}"; $message) | gsub("\\{id\\}"; $id)' "$CONFIG"
}

# find_source <id>: jedyna gałąź <prefiks><id> albo <prefiks><id>-<opis> na origin
find_source() {
  local id=$1 heads prefix matches count
  heads=$(git ls-remote --heads origin | awk '{print $2}' | sed 's#^refs/heads/##')
  matches=$(for prefix in $(jq -r '.workItemBranches | keys[]' "$CONFIG"); do
    printf '%s\n' "$heads" |
      awk -v p="$prefix$id" 'index($0, p) == 1 && (length($0) == length(p) || substr($0, length(p) + 1, 1) == "-")'
  done)
  count=$(printf '%s' "$matches" | grep -c . || true)
  case $count in
    1) printf '%s\n' "$matches" ;;
    0) fail "Brak gałęzi work itemu $id na origin (np. work-item/$id-opis)" ;;
    *) fail "Work item $id ma kilka gałęzi: $(printf '%s' "$matches" | tr '\n' ' ')— zostaw jedną" ;;
  esac
}

# kind_of <gałąź>: workItem albo feature, według prefiksu z config.json
kind_of() {
  jq -er --arg branch "$1" \
    '[.workItemBranches | to_entries[] | . as $e | select($branch | startswith($e.key)) | .value][0] // error("nieznany prefiks gałęzi")' \
    "$CONFIG"
}

remote_exists() { git ls-remote --exit-code --heads origin "$1" >/dev/null 2>&1; }

# merge_ref <ref> <temat>: merge commit; przy konflikcie cofa merge, zapisuje pliki i zwraca 1
merge_ref() {
  if git merge --no-ff --no-edit -m "$2" "$1" >/dev/null 2>&1; then return 0; fi
  CONFLICT_FILES=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
  git merge --abort >/dev/null 2>&1 || true
  return 1
}

# conflict <gałąź> <baza> <ref> <temat>: instrukcja ręcznego rozwiązania i błąd
conflict() {
  local branch=$1 base=$2 ref=$3 message=$4
  summary "Konflikt przy merge'u ${ref#origin/} do $branch: ${CONFLICT_FILES:-}"
  summary ""
  summary "Rozwiąż go lokalnie, wypchnij gałąź i uruchom workflow ponownie:"
  summary '```'
  summary "git fetch origin"
  summary "git switch $branch 2>/dev/null || git switch -c $branch origin/$base"
  summary "git merge --no-ff $ref -m \"$message\""
  summary "# popraw pliki z konfliktem, potem: git add <pliki>; git commit --no-edit"
  summary "git push -u origin $branch"
  summary '```'
  fail "Konflikt przy merge'u ${ref#origin/} do $branch"
}

# prepare_branch <gałąź> <baza>: otwarta (niezmergowana) gałąź jest aktualizowana o bazę,
# zmergowana albo nieistniejąca zaczyna od nowa od bazy. FORCE_PUSH=1, gdy push ją nadpisze.
prepare_branch() {
  local branch=$1 base=$2 message
  FORCE_PUSH=0
  git fetch --quiet origin "$base"
  if remote_exists "$branch"; then
    git fetch --quiet origin "$branch"
    if git merge-base --is-ancestor "origin/$branch" "origin/$base"; then
      git checkout --quiet -B "$branch" "origin/$base"
      FORCE_PUSH=1
    else
      git checkout --quiet -B "$branch" "origin/$branch"
      message=$(subject maintenance "merge $base into $branch")
      merge_ref "origin/$base" "$message" || conflict "$branch" "$base" "origin/$base" "$message"
    fi
  else
    git checkout --quiet -B "$branch" "origin/$base"
  fi
}

push_branch() {
  if [ "${FORCE_PUSH:-0}" = "1" ]; then
    git push --quiet --force-with-lease origin "$1"
  else
    git push --quiet -u origin "$1"
  fi
}

# open_pr <head> <baza> <tytuł> <opis>: PR (nowy albo istniejący) z włączonym auto-merge
open_pr() {
  local head=$1 base=$2 title=$3 body=$4 number
  number=$(gh pr list --head "$head" --base "$base" --state open --json number --jq '.[0].number // empty')
  if [ -z "$number" ]; then
    gh pr create --head "$head" --base "$base" --title "$title" --body "$body" >/dev/null
    number=$(gh pr list --head "$head" --base "$base" --state open --json number --jq '.[0].number')
  fi
  if ! gh pr merge "$number" --auto --merge >/dev/null 2>&1; then
    summary "⚠ Auto-merge nie włączył się dla PR #$number. Sprawdź Settings → General → Allow auto-merge."
  fi
  summary "PR #$number: $head → $base"
}
