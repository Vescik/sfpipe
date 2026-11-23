#!/usr/bin/env python3
"""Plan i parametry deployu dla workflowu sf-deploy. Tylko biblioteka standardowa Pythona.

  pipeline.py plan --from <sha> --to <sha> --base <gałąź> --head <gałąź>
      liczy paczkę (sfdx-git-delta), dobiera testy, sprawdza źródło PR-a;
      zapisuje .sfdelta/plan.json, wyjścia kroku i podsumowanie joba
  pipeline.py deploy-args <plan.json>
      argumenty dla `sf project deploy start`, jeden w linii
  pipeline.py window-check <plan.json>
      kończy się błędem poza oknem deployu (tylko gdy środowisko ma deployWindow)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

HERE = Path(__file__).resolve().parent
NS = {"sf": "http://soap.sforce.com/2006/04/metadata"}
APEX_TYPES = ("ApexClass", "ApexTrigger")
TEST_LEVELS = ("NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg")
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

Manifest = Dict[str, List[str]]


class PipelineError(Exception):
    pass


# ---------------------------------------------------------------- konfiguracja

def load_config(path: Optional[str] = None) -> dict:
    file = Path(path) if path else Path(os.environ.get("SF_PIPELINE_CONFIG", HERE / "config.json"))
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise PipelineError(f"Nie da się odczytać {file}: {error}")


def branch_config(config: dict, base: str) -> dict:
    branches = config.get("branches", {})
    if base not in branches:
        raise PipelineError(
            f'Gałąź "{base}" nie jest opisana w config.json (branches). Znane: {", ".join(branches) or "brak"}'
        )
    env = branches[base]
    if env.get("testLevel") not in TEST_LEVELS:
        raise PipelineError(f'branches.{base}.testLevel: oczekiwano jednego z {", ".join(TEST_LEVELS)}')
    if env.get("deployWindow"):
        parse_window(env["deployWindow"])  # błąd składni wychodzi już w planie
    return env


# ---------------------------------------------------------------- manifesty sgd

def read_manifest(path: Path) -> Manifest:
    if not path.exists():
        return {}
    result: Manifest = {}
    for node in ET.parse(path).getroot().findall("sf:types", NS):
        name = node.findtext("sf:name", namespaces=NS)
        members = [m.text for m in node.findall("sf:members", NS) if m.text]
        if name and members:
            result.setdefault(name, []).extend(members)
    return result


def count(manifest: Manifest) -> int:
    return sum(len(members) for members in manifest.values())


def run_sgd(source: str, target: str, out: Path, source_dir: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    command = ["sf", "sgd", "source", "delta", "--from", source, "--to", target,
               "--output-dir", str(out), "--source-dir", source_dir, "--json"]
    if Path(".forceignore").exists():
        command += ["--ignore-file", ".forceignore"]
    result = subprocess.run(command, capture_output=True, text=True)
    try:
        payload = json.loads(result.stdout[result.stdout.find("{"):])
    except ValueError:
        payload = {}
    if result.returncode != 0 or payload.get("status") != 0:
        message = payload.get("message") or result.stderr.strip() or "sfdx-git-delta zakończył się błędem"
        raise PipelineError(f"sfdx-git-delta: {message}")
    for warning in (payload.get("result") or {}).get("warnings") or []:
        print(f"::warning::sfdx-git-delta: {warning}")


# ---------------------------------------------------------------- testy

def index_classes(source_dir: Path) -> Dict[str, Path]:
    return {path.stem: path for path in source_dir.rglob("*.cls")}


def is_test_class(path: Path) -> bool:
    try:
        return re.search(r"@\s*isTest\b", path.read_text(encoding="utf-8", errors="replace"), re.I) is not None
    except OSError:
        return False


def select_tests(package: Manifest, destructive: Manifest, classes: Dict[str, Path], naming: List[str],
                 level: str, production: bool) -> Tuple[str, List[str], List[str]]:
    """Zwraca (poziom testów, lista testów, uwagi). Poziom "default" = bez flagi --test-level."""
    has_apex = any(package.get(t) or destructive.get(t) for t in APEX_TYPES)
    if not has_apex:
        # Na produkcji NoTestRun jest niedozwolony; bez Apex Salesforce i tak nie uruchamia testów.
        return ("default" if production else "NoTestRun"), [], []
    if level != "RunSpecifiedTests":
        return level, [], []

    tests: Set[str] = set()

    def by_naming(name: str) -> None:
        for pattern in naming:
            candidate = pattern.replace("{name}", name)
            if candidate in classes:
                tests.add(candidate)

    for name in package.get("ApexClass", []):
        path = classes.get(name)
        if path is not None and is_test_class(path):
            tests.add(name)
        else:
            by_naming(name)
    for name in package.get("ApexTrigger", []):
        by_naming(name)
        if name.endswith("Trigger") and len(name) > len("Trigger"):
            by_naming(name[: -len("Trigger")])

    if not tests:
        return "RunLocalTests", [], ["Żadna klasa testowa nie pasuje do konwencji nazw (testNaming), więc idzie RunLocalTests."]
    return "RunSpecifiedTests", sorted(tests), []


# ---------------------------------------------------------------- okno deployu

def parse_window(spec: str) -> Tuple[Set[int], int, int, str]:
    """"Tue,Thu 18:00-21:00 Europe/Warsaw" → (dni 0=pon, start, koniec w minutach, strefa)."""
    parts = spec.split()
    if len(parts) != 3:
        raise PipelineError(f'deployWindow "{spec}": oczekiwano "Dni GG:MM-GG:MM Strefa", np. "Tue,Thu 18:00-21:00 Europe/Warsaw"')
    days_part, hours_part, zone = parts
    days: Set[int] = set()
    for item in days_part.split(","):
        ends = item.split("-")
        if len(ends) > 2 or any(end not in DAYS for end in ends):
            raise PipelineError(f'deployWindow "{spec}": nieznany dzień "{item}" (Mon, Tue, Wed, Thu, Fri, Sat, Sun)')
        first, last = DAYS.index(ends[0]), DAYS.index(ends[-1])
        day = first
        days.add(day)
        while day != last:
            day = (day + 1) % 7
            days.add(day)
    match = re.fullmatch(r"(\d{2}):(\d{2})-(\d{2}):(\d{2})", hours_part)
    if not match:
        raise PipelineError(f'deployWindow "{spec}": godziny w postaci GG:MM-GG:MM')
    h1, m1, h2, m2 = (int(x) for x in match.groups())
    if h1 > 23 or h2 > 23 or m1 > 59 or m2 > 59 or (h1, m1) == (h2, m2):
        raise PipelineError(f'deployWindow "{spec}": nieprawidłowe godziny')
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(zone)
    except Exception:
        raise PipelineError(f'deployWindow "{spec}": nieznana strefa czasowa "{zone}"')
    return days, h1 * 60 + m1, h2 * 60 + m2, zone


def within_window(spec: str, now: datetime) -> bool:
    from zoneinfo import ZoneInfo

    days, start, end, zone = parse_window(spec)
    local = now.astimezone(ZoneInfo(zone))
    minutes, weekday = local.hour * 60 + local.minute, local.weekday()
    if start < end:
        return weekday in days and start <= minutes < end
    # Okno przez północ należy do dnia, w którym się zaczyna.
    return (weekday in days and minutes >= start) or ((weekday - 1) % 7 in days and minutes < end)


# ---------------------------------------------------------------- plan

def make_plan(config: dict, base: str, head: str, out: Path, source_dir: Path) -> dict:
    env = branch_config(config, base)
    production = bool(env.get("production"))
    package = read_manifest(out / "package" / "package.xml")
    destructive = read_manifest(out / "destructiveChanges" / "destructiveChanges.xml")
    has_changes = bool(package or destructive)

    allowed = env.get("allowedSources") or []
    source_ok = not allowed or any(head.startswith(prefix) for prefix in allowed)
    if not source_ok and has_changes:
        flow = config.get("flow", {})
        hint = (
            f'Użyj workflowu sf-promote (gałąź promote/<id>/{base}).' if base == flow.get("workItems")
            else "Użyj workflowu sf-release." if base in (flow.get("release"), flow.get("production"))
            else ""
        )
        raise PipelineError(
            f'PR z "{head}" zmienia metadane, a do "{base}" mogą je wnosić tylko gałęzie {", ".join(allowed)}. {hint}'.strip()
        )

    level, tests, notes = select_tests(
        package, destructive, index_classes(source_dir), config.get("testNaming", ["{name}Test"]),
        env["testLevel"], production,
    )
    if not source_ok:
        notes.append(f'Gałąź "{head}" nie jest źródłem promocji, ale PR nie zmienia metadanych, więc może wejść bez deployu.')
    return {
        "base": base,
        "head": head,
        "environment": env["environment"],
        "production": production,
        "deployWindow": env.get("deployWindow"),
        "hasChanges": has_changes,
        "package": package,
        "destructive": destructive,
        "testLevel": level,
        "tests": tests,
        "notes": notes,
        "outputDir": str(out),
    }


def summary_markdown(plan: dict) -> str:
    lines = [f'### Paczka: {plan["head"]} → {plan["base"]} (Environment `{plan["environment"]}`)', ""]
    if not plan["hasChanges"]:
        lines.append("Brak zmian w metadanych: deploy jest pomijany.")
    for title, key in (("Do wdrożenia", "package"), ("Do usunięcia", "destructive")):
        manifest = plan[key]
        if manifest:
            lines += [f"**{title}** ({count(manifest)})", "", "| Typ | Komponent |", "|---|---|"]
            for type_name in sorted(manifest):
                lines += [f"| {type_name} | {member} |" for member in sorted(manifest[type_name])]
            lines.append("")
    if plan["hasChanges"]:
        level = "domyślny Salesforce (bez Apex)" if plan["testLevel"] == "default" else plan["testLevel"]
        lines.append(f"**Testy:** {level}" + (f': {", ".join(plan["tests"])}' if plan["tests"] else ""))
        if plan["deployWindow"]:
            lines.append(f'**Okno deployu:** {plan["deployWindow"]}')
    for note in plan["notes"]:
        lines.append(f"> {note}")
    return "\n".join(lines) + "\n"


def deploy_args(plan: dict) -> List[str]:
    out = Path(plan["outputDir"])
    args = ["--manifest", str(out / "package" / "package.xml")]
    if plan["destructive"]:
        args += ["--post-destructive-changes", str(out / "destructiveChanges" / "destructiveChanges.xml")]
    if plan["testLevel"] != "default":
        args += ["--test-level", plan["testLevel"]]
    for test in plan["tests"]:
        args += ["--tests", test]
    return args


def append(path_variable: str, text: str) -> None:
    path = os.environ.get(path_variable)
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)


# ---------------------------------------------------------------- CLI

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    plan_cmd = sub.add_parser("plan")
    plan_cmd.add_argument("--from", dest="source", required=True)
    plan_cmd.add_argument("--to", dest="target", required=True)
    plan_cmd.add_argument("--base", required=True)
    plan_cmd.add_argument("--head", required=True)
    plan_cmd.add_argument("--out", default=".sfdelta")
    plan_cmd.add_argument("--config")
    plan_cmd.add_argument("--skip-sgd", action="store_true", help="użyj gotowego wyniku sgd w --out (testy)")
    sub.add_parser("deploy-args").add_argument("plan")
    window_cmd = sub.add_parser("window-check")
    window_cmd.add_argument("plan")
    window_cmd.add_argument("--now", help="ISO 8601, do testów")
    args = parser.parse_args(argv)

    try:
        if args.command == "plan":
            config = load_config(args.config)
            out = Path(args.out)
            if not args.skip_sgd:
                run_sgd(args.source, args.target, out, config.get("sourceDir", "force-app"))
            plan = make_plan(config, args.base, args.head, out, Path(config.get("sourceDir", "force-app")))
            (out / "plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
            markdown = summary_markdown(plan)
            print(markdown)
            append("GITHUB_STEP_SUMMARY", markdown)
            append("GITHUB_OUTPUT", f'has_changes={str(plan["hasChanges"]).lower()}\nenvironment={plan["environment"]}\n')
        elif args.command == "deploy-args":
            print("\n".join(deploy_args(json.loads(Path(args.plan).read_text(encoding="utf-8")))))
        else:
            plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
            spec = plan.get("deployWindow")
            now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
            if spec and not within_window(spec, now):
                raise PipelineError(f"Poza oknem deployu ({spec}). Uruchom job ponownie w oknie (Re-run jobs).")
            print(f"Okno deployu: {spec or 'brak ograniczeń'}")
        return 0
    except PipelineError as error:
        print(f"::error::{error}")
        append("GITHUB_STEP_SUMMARY", f"❌ {error}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
