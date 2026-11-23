"""Testy promote.sh, release.sh i back-sync.sh na prawdziwych repo gita (bare origin) z atrapą gh."""
from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
SCRIPTS = KIT / ".github" / "sf-pipeline"

# Atrapa gh: zapisuje wywołania; "pr create --head H --base B" nadaje numer parze H→B,
# a "pr list --head H --base B" go zwraca (otwarty PR tej pary).
FAKE_GH = r"""#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
key=$(printf '%s__%s' "$4" "$6" | tr '/' '_')
case "$1 $2" in
  "pr create")
    n=$(( $(cat "$GH_STATE/counter" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$GH_STATE/counter"
    echo "$n" > "$GH_STATE/$key" ;;
  "pr list") [ -f "$GH_STATE/$key" ] && cat "$GH_STATE/$key" ;;
esac
exit 0
"""


def harness_accepts(subject: str) -> bool:
    """Port message_error() z harnessu (hook commit-msg)."""
    if re.fullmatch(r"\[(?:chore|docs)\] \S.*", subject):
        return True
    match = re.fullmatch(r"\[(WI|FEATURE)-([1-9][0-9]*)\] \S.*", subject)
    return bool(match) and set(re.findall(r"\bAB#([0-9]+)\b", subject)) == {match.group(2)}


class Repo:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="sf-pipeline-scripts-"))
        self.origin = self.root / "origin.git"
        self.work = self.root / "work"
        self.ci = self.root / "ci"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.gh_log = self.root / "gh.log"
        (self.root / "gh.state").mkdir()
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "GH_LOG": str(self.gh_log),
            "GH_STATE": str(self.root / "gh.state"),
            "GIT_CONFIG_GLOBAL": str(self.root / "gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.env.pop("GITHUB_STEP_SUMMARY", None)
        (self.root / "gitconfig").write_text("[init]\n\tdefaultBranch = main\n[user]\n\tname = Dev\n\temail = dev@example.com\n")
        self.git(self.root, "init", "-q", "--bare", str(self.origin))
        self.git(self.root, "clone", "-q", str(self.origin), str(self.work))
        self.write("force-app/main/default/classes/DiscountService.cls", "public class DiscountService {}\n")
        self.commit("[chore] import metadata")
        self.git(self.work, "push", "-q", "origin", "main", "main:uat", "main:stage")

    def git(self, cwd: Path, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, path: str, content: str) -> None:
        file = self.work / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def commit(self, message: str) -> None:
        self.git(self.work, "add", "-A")
        self.git(self.work, "commit", "-qm", message)

    def work_item(self, branch: str, path: str, content: str) -> None:
        self.git(self.work, "fetch", "-q", "origin")
        self.git(self.work, "switch", "-qc", branch, "origin/main")
        self.write(path, content)
        item = re.search(r"/(\d+)", branch).group(1)
        tag = "FEATURE" if branch.startswith("feature/") else "WI"
        self.commit(f"[{tag}-{item}] change — AB#{item}")
        self.git(self.work, "push", "-q", "origin", branch)

    def merge_pr(self, head: str, base: str) -> None:
        """Symuluje zmergowanie PR-a (merge commit) na origin."""
        self.git(self.work, "fetch", "-q", "origin")
        self.git(self.work, "switch", "-q", "-C", f"tmp-{base}", f"origin/{base}")
        self.git(self.work, "merge", "-q", "--no-ff", "-m", f"Merge {head}", f"origin/{head}")
        self.git(self.work, "push", "-q", "origin", f"tmp-{base}:{base}")

    def run(self, script: str, *args: str) -> subprocess.CompletedProcess:
        """Skrypt w świeżym klonie, tak jak checkout w workflowie."""
        subprocess.run(["rm", "-rf", str(self.ci)], check=True)
        self.git(self.root, "clone", "-q", str(self.origin), str(self.ci))
        return subprocess.run(["bash", str(SCRIPTS / script), *args], cwd=self.ci, env=self.env, capture_output=True, text=True)

    def subjects(self, rev_range: str) -> list:
        self.git(self.work, "fetch", "-q", "origin")
        return self.git(self.work, "log", "--format=%s", rev_range).splitlines()

    def gh_calls(self) -> list:
        return self.gh_log.read_text().splitlines() if self.gh_log.exists() else []


class PromoteTest(unittest.TestCase):
    def test_promotes_a_work_item_and_opens_a_pr_with_auto_merge(self):
        repo = Repo()
        repo.work_item("work-item/5001-rabat", "force-app/main/default/classes/Rabat.cls", "public class Rabat {}\n")
        result = repo.run("promote.sh", "5001")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(repo.subjects("origin/uat..origin/promote/5001/uat")[0], "[WI-5001] promote to uat — AB#5001")
        calls = repo.gh_calls()
        self.assertTrue(any(c.startswith("pr create --head promote/5001/uat --base uat --title [WI-5001] promote to uat") for c in calls), calls)
        self.assertIn("pr merge 1 --auto --merge", calls)

    def test_updates_an_open_promotion_and_restarts_after_merge(self):
        repo = Repo()
        repo.work_item("work-item/5001-rabat", "force-app/main/default/classes/Rabat.cls", "public class Rabat {}\n")
        repo.run("promote.sh", "5001")
        # Poprawka w US, gdy PR promocji jest jeszcze otwarty: gałąź jest aktualizowana, nie nadpisywana.
        repo.git(repo.work, "switch", "-q", "work-item/5001-rabat")
        repo.write("force-app/main/default/classes/Rabat.cls", "public class Rabat { Integer v; }\n")
        repo.commit("[WI-5001] fix — AB#5001")
        repo.git(repo.work, "push", "-q", "origin", "work-item/5001-rabat")
        repo.git(repo.work, "fetch", "-q", "origin")
        first = repo.git(repo.work, "rev-parse", "origin/promote/5001/uat")
        self.assertEqual(repo.run("promote.sh", "5001").returncode, 0)
        repo.git(repo.work, "fetch", "-q", "origin")
        self.assertEqual(repo.git(repo.work, "merge-base", "--is-ancestor", first, "origin/promote/5001/uat"), "")

        repo.merge_pr("promote/5001/uat", "uat")
        again = repo.run("promote.sh", "5001")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("jest już w uat", again.stdout)

    def test_feature_branches_use_the_feature_template(self):
        repo = Repo()
        repo.work_item("feature/5000-faktury", "force-app/main/default/classes/Invoice.cls", "public class Invoice {}\n")
        self.assertEqual(repo.run("promote.sh", "5000").returncode, 0)
        self.assertEqual(repo.subjects("origin/uat..origin/promote/5000/uat")[0], "[FEATURE-5000] promote to uat — AB#5000")

    def test_reports_missing_duplicate_and_invalid_work_items(self):
        repo = Repo()
        self.assertIn("Brak gałęzi work itemu 5001", repo.run("promote.sh", "5001").stderr)
        self.assertIn("Nieprawidłowe ID", repo.run("promote.sh", "50a1").stderr)
        repo.work_item("work-item/5001-a", "force-app/main/default/classes/A.cls", "public class A {}\n")
        repo.work_item("work-item/5001-b", "force-app/main/default/classes/B.cls", "public class B {}\n")
        repo.work_item("work-item/50012-c", "force-app/main/default/classes/C.cls", "public class C {}\n")
        result = repo.run("promote.sh", "5001")
        self.assertEqual(result.returncode, 1)
        self.assertIn("kilka gałęzi: work-item/5001-a work-item/5001-b", result.stderr)

    def test_conflict_explains_how_to_resolve_it(self):
        repo = Repo()
        repo.work_item("work-item/5001-rabat", "force-app/main/default/classes/DiscountService.cls", "public class DiscountService { /* 5001 */ }\n")
        repo.work_item("work-item/5002-inne", "force-app/main/default/classes/DiscountService.cls", "public class DiscountService { /* 5002 */ }\n")
        repo.run("promote.sh", "5002")
        repo.merge_pr("promote/5002/uat", "uat")
        result = repo.run("promote.sh", "5001")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Konflikt przy merge'u work-item/5001-rabat do promote/5001/uat", result.stdout)
        self.assertIn('git merge --no-ff origin/work-item/5001-rabat -m "[WI-5001] promote to uat — AB#5001"', result.stdout)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.repo.work_item("work-item/5001-rabat", "force-app/main/default/classes/Rabat.cls", "public class Rabat {}\n")
        self.repo.work_item("work-item/5002-layout", "force-app/main/default/classes/Layout2.cls", "public class Layout2 {}\n")

    def test_only_work_items_from_uat_go_into_a_release(self):
        result = self.repo.run("release.sh", "create", "2026.12", "5001")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Tych US nie ma w uat w aktualnej wersji gałęzi: 5001", result.stderr)

    def test_create_and_ship(self):
        repo = self.repo
        for item in ("5001", "5002"):
            repo.run("promote.sh", item)
            repo.merge_pr(f"promote/{item}/uat", "uat")
        result = repo.run("release.sh", "create", "2026.12", "5001")  # 5002 zostaje w uat
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(repo.subjects("origin/main..origin/release/2026.12"), ["[WI-5001] add to release 2026.12 — AB#5001", "[WI-5001] change — AB#5001"])
        self.assertTrue(any(c.startswith("pr create --head release/2026.12 --base stage --title Release 2026.12 → stage") for c in repo.gh_calls()))

        self.assertIn("nie jest jeszcze w stage", repo.run("release.sh", "ship", "2026.12").stderr)
        repo.merge_pr("release/2026.12", "stage")
        shipped = repo.run("release.sh", "ship", "2026.12")
        self.assertEqual(shipped.returncode, 0, shipped.stderr)
        log = repo.gh_log.read_text()
        self.assertIn("pr create --head release/2026.12 --base main --title Release 2026.12 → main", log)
        self.assertIn("po testach na `stage`:\n\n- AB#5001", log)
        self.assertIn("istnieje; użyj update", repo.run("release.sh", "create", "2026.12", "5002").stderr)

    def test_hotfix_can_skip_the_uat_check(self):
        self.repo.env["SKIP_UAT_CHECK"] = "true"
        self.assertEqual(self.repo.run("release.sh", "create", "hotfix-5002", "5002").returncode, 0)


class BackSyncTest(unittest.TestCase):
    def test_opens_back_sync_prs_where_main_is_missing(self):
        repo = Repo()
        repo.git(repo.work, "switch", "-q", "main")
        repo.write("force-app/main/default/classes/Hotfix.cls", "public class Hotfix {}\n")
        repo.commit("[WI-6001] hotfix — AB#6001")
        repo.git(repo.work, "push", "-q", "origin", "main")
        result = repo.run("back-sync.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        for env in ("uat", "stage"):
            self.assertEqual(repo.subjects(f"origin/{env}..origin/sync/main/{env}")[0], f"[chore] back-sync main into {env}")
        repo.merge_pr("sync/main/uat", "uat")
        repo.merge_pr("sync/main/stage", "stage")
        self.assertIn("back-sync niepotrzebny", repo.run("back-sync.sh").stdout)


class CommitSubjectsTest(unittest.TestCase):
    def test_every_commit_created_by_the_scripts_passes_the_harness_hook(self):
        repo = Repo()
        repo.work_item("work-item/5001-rabat", "force-app/main/default/classes/Rabat.cls", "public class Rabat {}\n")
        repo.run("promote.sh", "5001")
        repo.merge_pr("promote/5001/uat", "uat")
        repo.run("release.sh", "create", "2026.12", "5001")
        subjects = repo.subjects("origin/uat..origin/release/2026.12") + repo.subjects("origin/main..origin/promote/5001/uat")
        created = [s for s in subjects if not s.startswith("Merge ")]  # "Merge …" to symulowane merge PR-ów na GitHubie
        self.assertTrue(created)
        self.assertEqual([s for s in created if not harness_accepts(s)], [])


if __name__ == "__main__":
    unittest.main()
