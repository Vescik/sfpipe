#!/usr/bin/env bash
# Back-sync: po każdej zmianie produkcji (main) otwiera PR-y main → każde środowisko testowe,
# w którym brakuje commitów z main (np. hotfixu). Gałąź sync/<produkcja>/<środowisko> jest
# jedna na środowisko i aktualizowana przy kolejnych zmianach.
#
# Użycie: back-sync.sh            wszystkie środowiska testowe z config.json
#         back-sync.sh --env uat  jedno środowisko
source "$(dirname "$0")/lib.sh"

production=$(cfg .flow.production)

if [ "${1:-}" = "--env" ]; then
  env=${2:?brak nazwy środowiska}
  git_identity
  git fetch --quiet origin "$production" "$env"
  if git merge-base --is-ancestor "origin/$production" "origin/$env"; then
    summary "$env zawiera $production; back-sync niepotrzebny."
    exit 0
  fi
  sync="sync/$production/$env"
  message=$(subject maintenance "back-sync $production into $env")
  prepare_branch "$sync" "$env"
  merge_ref "origin/$production" "$message" || conflict "$sync" "$env" "origin/$production" "$message"
  push_branch "$sync"
  open_pr "$sync" "$env" "$message" "Back-sync: commity z \`$production\` (np. hotfixy), których nie ma w \`$env\`."
  exit 0
fi

# Każde środowisko w osobnym procesie: konflikt w jednym nie blokuje pozostałych.
failed=""
for env in $(jq -r --arg p "$production" '.branches | keys[] | select(. != $p)' "$CONFIG"); do
  bash "$0" --env "$env" || failed="$failed $env"
done
[ -z "$failed" ] || fail "Back-sync nie powiódł się dla:$failed"
