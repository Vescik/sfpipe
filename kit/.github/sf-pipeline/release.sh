#!/usr/bin/env bash
# Release candidate: release/<nazwa> = produkcja (main) + wybrane work itemy z uat.
#
#   release.sh create <nazwa> <id...>   nowa gałąź od main, merge US, PR do stage
#   release.sh update <nazwa> [id...]   merge aktualnego main (np. po hotfixie) i ewentualnie kolejnych US
#   release.sh ship <nazwa>             PR tej samej gałęzi do main (po testach na stage)
#
# SKIP_UAT_CHECK=true pozwala dodać US, którego nie ma w uat (np. pilny hotfix).
source "$(dirname "$0")/lib.sh"

action=${1:-}
name=${2:-}
shift 2 2>/dev/null || true
printf '%s' "$name" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z._-]*$' || fail "Nieprawidłowa nazwa release'u: \"$name\" (np. 2026.12)"

uat=$(cfg .flow.workItems)
stage=$(cfg .flow.release)
production=$(cfg .flow.production)
release="release/$name"
git_identity

# add_work_items <id...>: merge gałęzi US do release'u (każdy US to osobny merge commit)
add_work_items() {
  local id source_branch kind message missing=""
  [ $# -gt 0 ] || return 0
  git fetch --quiet origin "$uat"
  for id in "$@"; do valid_id "$id"; done
  for id in "$@"; do
    source_branch=$(find_source "$id")
    git fetch --quiet origin "$source_branch"
    if [ "${SKIP_UAT_CHECK:-false}" != "true" ] && ! git merge-base --is-ancestor "origin/$source_branch" "origin/$uat"; then
      missing="$missing $id"
    fi
  done
  [ -z "$missing" ] || fail "Tych US nie ma w $uat w aktualnej wersji gałęzi:$missing. Najpierw sf-promote (albo SKIP_UAT_CHECK dla hotfixu)."
  for id in "$@"; do
    source_branch=$(find_source "$id")
    kind=$(kind_of "$source_branch")
    message=$(subject "$kind" "add to release $name" "$id")
    merge_ref "origin/$source_branch" "$message" || conflict "$release" "$production" "origin/$source_branch" "$message"
    summary "+ AB#$id ($source_branch)"
  done
}

work_item_list() {
  git log --format=%s "origin/$production..HEAD" | grep -oE 'AB#[0-9]+' | sort -u | sed 's/^/- /'
}

case $action in
  create)
    [ $# -gt 0 ] || fail "Podaj ID work itemów, np.: release.sh create $name 5001 5002"
    remote_exists "$release" && fail "$release już istnieje; użyj update"
    git fetch --quiet origin "$production"
    git checkout --quiet -B "$release" "origin/$production"
    add_work_items "$@"
    push_branch "$release"
    open_pr "$release" "$stage" "Release $name → $stage" "Release candidate \`$release\`:

$(work_item_list)"
    ;;
  update)
    remote_exists "$release" || fail "$release nie istnieje; użyj create"
    git fetch --quiet origin "$release" "$production"
    git checkout --quiet -B "$release" "origin/$release"
    message=$(subject maintenance "merge $production into $release")
    merge_ref "origin/$production" "$message" || conflict "$release" "$production" "origin/$production" "$message"
    add_work_items "$@"
    if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$release")" ]; then
      summary "$release jest aktualny; nic do zmiany."
      exit 0
    fi
    push_branch "$release"
    summary "Zaktualizowano $release; otwarte PR-y tej gałęzi uruchomią deploy ponownie."
    ;;
  ship)
    remote_exists "$release" || fail "$release nie istnieje"
    git fetch --quiet origin "$release" "$stage" "$production"
    git merge-base --is-ancestor "origin/$release" "origin/$stage" ||
      fail "$release nie jest jeszcze w $stage w aktualnej wersji (PR do $stage niezmergowany albo gałąź ma nowsze commity)"
    git checkout --quiet -B "$release" "origin/$release"
    open_pr "$release" "$production" "Release $name → $production" "Release \`$release\` po testach na \`$stage\`:

$(work_item_list)"
    ;;
  *)
    fail "Nieznana akcja \"$action\" (create, update, ship)"
    ;;
esac
