#!/usr/bin/env bash
# Promocja jednego work itemu na środowisko testowe (domyślnie flow.workItems, czyli uat).
# Tworzy albo aktualizuje gałąź promote/<id>/<środowisko>, merguje do niej gałąź US
# i otwiera PR z auto-merge. Deploy robi workflow sf-deploy na tym PR-ze.
#
# Użycie: promote.sh <id> [gałąź-środowiska]
source "$(dirname "$0")/lib.sh"

id=${1:-}
valid_id "$id"
target=${2:-$(cfg .flow.workItems)}
cfg ".branches[\"$target\"]" >/dev/null || fail "Gałąź $target nie jest opisana w config.json"
git_identity

source_branch=$(find_source "$id")
kind=$(kind_of "$source_branch")
promote="promote/$id/$target"
message=$(subject "$kind" "promote to $target" "$id")

git fetch --quiet origin "$source_branch"
prepare_branch "$promote" "$target"
merge_ref "origin/$source_branch" "$message" || conflict "$promote" "$target" "origin/$source_branch" "$message"

if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$target")" ]; then
  summary "Work item $id jest już w $target w tej wersji ($source_branch); nie ma czego promować."
  exit 0
fi

push_branch "$promote"
open_pr "$promote" "$target" "$message" "Promocja \`$source_branch\` na \`$target\`.

AB#$id"
