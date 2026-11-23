"""Testy pipeline.py (plan, testy, okno deployu). Uruchomienie: python3 -m unittest discover -s kit/tests"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT / ".github" / "sf-pipeline"))

import pipeline  # noqa: E402

CONFIG = pipeline.load_config(str(KIT / ".github" / "sf-pipeline" / "config.json"))
XML = """<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
{types}  <version>62.0</version>
</Package>
"""


def manifest_xml(types: dict) -> str:
    body = "".join(
        "  <types>\n" + "".join(f"    <members>{m}</members>\n" for m in members) + f"    <name>{name}</name>\n  </types>\n"
        for name, members in types.items()
    )
    return XML.format(types=body)


class Workspace:
    """Katalog z force-app i wynikiem sgd (.sfdelta) do testów planu."""

    def __init__(self, package: dict, destructive: dict | None = None, classes: dict | None = None):
        self.root = Path(tempfile.mkdtemp(prefix="sf-pipeline-"))
        out = self.root / ".sfdelta"
        (out / "package").mkdir(parents=True)
        (out / "destructiveChanges").mkdir(parents=True)
        (out / "package" / "package.xml").write_text(manifest_xml(package), encoding="utf-8")
        (out / "destructiveChanges" / "destructiveChanges.xml").write_text(manifest_xml(destructive or {}), encoding="utf-8")
        class_dir = self.root / "force-app" / "main" / "default" / "classes"
        class_dir.mkdir(parents=True)
        for name, body in (classes or {}).items():
            (class_dir / f"{name}.cls").write_text(body, encoding="utf-8")
        self.out = out

    def plan(self, base: str, head: str) -> dict:
        return pipeline.make_plan(CONFIG, base, head, self.out, self.root / "force-app")


PLAIN = "public class X {}"
TEST = "@IsTest\nprivate class X {}"


class SelectTestsTest(unittest.TestCase):
    def test_runs_matching_tests_for_changed_classes_and_triggers(self):
        ws = Workspace(
            {"ApexClass": ["DiscountService", "OrderTest"], "ApexTrigger": ["AccountTrigger"], "Layout": ["Account-Account Layout"]},
            classes={
                "DiscountService": PLAIN,
                "DiscountServiceTest": TEST,
                "OrderTest": TEST,
                "AccountTrigger_Test": TEST,
                "Account_Test": TEST,
            },
        )
        plan = ws.plan("uat", "promote/5001/uat")
        self.assertEqual(plan["testLevel"], "RunSpecifiedTests")
        self.assertEqual(plan["tests"], ["AccountTrigger_Test", "Account_Test", "DiscountServiceTest", "OrderTest"])

    def test_falls_back_to_local_tests_when_no_test_matches(self):
        ws = Workspace({"ApexClass": ["Lonely"]}, classes={"Lonely": PLAIN})
        plan = ws.plan("uat", "promote/5001/uat")
        self.assertEqual((plan["testLevel"], plan["tests"]), ("RunLocalTests", []))
        self.assertIn("testNaming", plan["notes"][0])

    def test_without_apex_skips_tests_in_sandbox_and_uses_default_in_production(self):
        ws = Workspace({"Layout": ["Account-Account Layout"]})
        self.assertEqual(ws.plan("uat", "promote/5001/uat")["testLevel"], "NoTestRun")
        self.assertEqual(ws.plan("main", "release/2026.12")["testLevel"], "default")

    def test_deleting_apex_counts_as_apex(self):
        ws = Workspace({}, destructive={"ApexClass": ["OldService"]})
        plan = ws.plan("main", "release/2026.12")
        self.assertEqual((plan["testLevel"], plan["hasChanges"]), ("RunLocalTests", True))


class SourceBranchTest(unittest.TestCase):
    def test_rejects_metadata_changes_from_branches_outside_the_flow(self):
        ws = Workspace({"ApexClass": ["DiscountService"]}, classes={"DiscountService": PLAIN})
        with self.assertRaisesRegex(pipeline.PipelineError, "sf-promote"):
            ws.plan("uat", "work-item/5001-rabat")
        with self.assertRaisesRegex(pipeline.PipelineError, "sf-release"):
            ws.plan("main", "work-item/5001-rabat")

    def test_allows_changes_without_metadata_from_any_branch(self):
        ws = Workspace({})
        plan = ws.plan("main", "chore/update-agents")
        self.assertFalse(plan["hasChanges"])
        self.assertIn("bez deployu", plan["notes"][0])

    def test_unknown_base_branch(self):
        with self.assertRaisesRegex(pipeline.PipelineError, 'Gałąź "qa"'):
            Workspace({}).plan("qa", "release/x")


class DeployArgsTest(unittest.TestCase):
    def test_builds_sf_arguments(self):
        ws = Workspace(
            {"ApexClass": ["DiscountService"]},
            destructive={"CustomField": ["Account.Old__c"]},
            classes={"DiscountService": PLAIN, "DiscountServiceTest": TEST},
        )
        args = pipeline.deploy_args(ws.plan("uat", "promote/5001/uat"))
        self.assertEqual(
            args,
            [
                "--manifest", str(ws.out / "package" / "package.xml"),
                "--post-destructive-changes", str(ws.out / "destructiveChanges" / "destructiveChanges.xml"),
                "--test-level", "RunSpecifiedTests",
                "--tests", "DiscountServiceTest",
            ],
        )

    def test_default_level_adds_no_test_flag(self):
        args = pipeline.deploy_args(Workspace({"Layout": ["A-B"]}).plan("main", "release/x"))
        self.assertNotIn("--test-level", args)


class DeployWindowTest(unittest.TestCase):
    SPEC = "Tue,Thu 18:00-21:00 Europe/Warsaw"

    def at(self, iso: str) -> datetime:
        return datetime.fromisoformat(iso)

    def test_inside_and_outside(self):
        self.assertTrue(pipeline.within_window(self.SPEC, self.at("2026-11-24T18:30:00+01:00")))  # wtorek
        self.assertFalse(pipeline.within_window(self.SPEC, self.at("2026-11-24T21:00:00+01:00")))
        self.assertFalse(pipeline.within_window(self.SPEC, self.at("2026-11-25T19:00:00+01:00")))  # środa
        self.assertTrue(pipeline.within_window(self.SPEC, self.at("2026-11-24T17:30:00+00:00")))  # 18:30 w Warszawie

    def test_overnight_window_belongs_to_its_start_day(self):
        spec = "Fri 22:00-02:00 UTC"
        self.assertTrue(pipeline.within_window(spec, self.at("2026-11-28T01:00:00+00:00")))  # sobota rano
        self.assertFalse(pipeline.within_window(spec, self.at("2026-11-27T01:00:00+00:00")))  # piątek rano
        self.assertTrue(pipeline.within_window("Fri-Mon 08:00-09:00 UTC", self.at("2026-11-29T08:30:00+00:00")))

    def test_invalid_specs(self):
        for spec, message in [
            ("Tue 18:00-21:00", "Dni GG:MM"),
            ("Tuesday 18:00-21:00 UTC", "nieznany dzień"),
            ("Tue 25:00-26:00 UTC", "nieprawidłowe godziny"),
            ("Tue 18:00-21:00 Mars/Base", "strefa"),
        ]:
            with self.assertRaisesRegex(pipeline.PipelineError, message):
                pipeline.parse_window(spec)


class CliTest(unittest.TestCase):
    def test_plan_writes_outputs_summary_and_plan_file(self):
        ws = Workspace({"ApexClass": ["DiscountService"]}, classes={"DiscountService": PLAIN, "DiscountServiceTest": TEST})
        outputs, summary = ws.root / "out.txt", ws.root / "summary.md"
        cwd = os.getcwd()
        os.chdir(ws.root)
        os.environ.update(GITHUB_OUTPUT=str(outputs), GITHUB_STEP_SUMMARY=str(summary))
        try:
            with redirect_stdout(io.StringIO()):
                code = pipeline.main(["plan", "--from", "A", "--to", "B", "--base", "uat", "--head", "promote/5001/uat",
                                      "--skip-sgd", "--config", str(KIT / ".github" / "sf-pipeline" / "config.json")])
                window = pipeline.main(["window-check", ".sfdelta/plan.json"])
        finally:
            os.chdir(cwd)
            for key in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"):
                os.environ.pop(key)
        self.assertEqual((code, window), (0, 0))
        self.assertEqual(outputs.read_text(encoding="utf-8"), "has_changes=true\nenvironment=sf-uat\n")
        self.assertIn("| ApexClass | DiscountService |", summary.read_text(encoding="utf-8"))
        self.assertEqual(json.loads((ws.out / "plan.json").read_text(encoding="utf-8"))["tests"], ["DiscountServiceTest"])

    def test_window_check_fails_outside_the_window(self):
        ws = Workspace({"Layout": ["A-B"]})
        (ws.out / "plan.json").write_text(json.dumps(ws.plan("main", "release/x")), encoding="utf-8")
        with redirect_stdout(io.StringIO()) as output:
            code = pipeline.main(["window-check", str(ws.out / "plan.json"), "--now", "2026-11-25T12:00:00+00:00"])
        self.assertEqual(code, 1)
        self.assertIn("Poza oknem deployu", output.getvalue())


@unittest.skipUnless(os.environ.get("RUN_SGD_TESTS") == "1" and shutil.which("sf"), "wymaga sf i sfdx-git-delta (RUN_SGD_TESTS=1)")
class SgdIntegrationTest(unittest.TestCase):
    """Prawdziwy sfdx-git-delta na commicie merge'u, tak jak w workflowie sf-deploy."""

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def test_plan_from_a_merge_commit(self):
        self.root = Path(tempfile.mkdtemp(prefix="sf-pipeline-sgd-"))
        shutil.copytree(KIT.parent / "examples" / "sfdx-project" / "force-app", self.root / "force-app")
        shutil.copy(KIT.parent / "examples" / "sfdx-project" / "sfdx-project.json", self.root)
        classes = self.root / "force-app" / "main" / "default" / "classes"
        self.git("init", "-q", "-b", "uat")
        self.git("-c", "user.name=T", "-c", "user.email=t@example.com", "add", "-A")
        self.git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "[chore] base")
        self.git("switch", "-qc", "promote/5001/uat")
        (classes / "DiscountService.cls").write_text("public class DiscountService { public static Integer v = 2; }\n")
        (classes / "DiscountServiceTest.cls").write_text("@IsTest private class DiscountServiceTest {}\n")
        (classes / "DiscountServiceTest.cls-meta.xml").write_text((classes / "DiscountService.cls-meta.xml").read_text())
        self.git("-c", "user.name=T", "-c", "user.email=t@example.com", "add", "-A")
        self.git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "[WI-5001] change — AB#5001")
        self.git("switch", "-q", "uat")
        self.git("-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "--no-ff", "-qm", "merge", "promote/5001/uat")

        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            with redirect_stdout(io.StringIO()):
                code = pipeline.main(["plan", "--from", "HEAD~1", "--to", "HEAD", "--base", "uat", "--head", "promote/5001/uat",
                                      "--config", str(KIT / ".github" / "sf-pipeline" / "config.json")])
        finally:
            os.chdir(cwd)
        self.assertEqual(code, 0)
        plan = json.loads((self.root / ".sfdelta" / "plan.json").read_text())
        self.assertEqual(plan["package"], {"ApexClass": ["DiscountService", "DiscountServiceTest"]})
        self.assertEqual((plan["testLevel"], plan["tests"]), ("RunSpecifiedTests", ["DiscountServiceTest"]))


if __name__ == "__main__":
    unittest.main()
