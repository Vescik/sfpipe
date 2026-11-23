# Faza 0: runbook

Kroki, które wymagają Waszego dostępu do GitHuba i orgów Salesforce. Kolejność ma znaczenie: baseline (kroki 7–8) idzie **przed** rulesetami (krok 9), żeby pushe linii bazowej nie były blokowane.

Na końcu `sfpipe doctor` (krok 10) powinien pokazać same `✔`, z jednym oczekiwanym wyjątkiem opisanym w kroku 9.

## Próba lokalna

Przed pracą na GitHubie i w orgach można przejść runbook na sucho:

```bash
npm run sandbox
```

Skrypt `scripts/sandbox.sh` buduje w `.sandbox/` (poza gitem) odpowiedniki kroków, które nie wymagają dostępu z zewnątrz:

| Krok | Lokalnie | Na GitHubie i w orgach |
|---|---|---|
| 1 | `npm pack` i instalacja CLI z paczki | repo `sfpipe`, tag, GitHub Packages |
| 2 | bare repo jako `origin` repo `salesforce`, `sfpipe init` na gałęzi z merge commitem | prawdziwe repo i PR |
| 7–8 | `uat`, `stage` i `dev` jako kopie `main` | retrieve z każdego orga |
| 10 | lista środowisk przez `jq` jak w `doctor.yml`, potem `sfpipe doctor` | to samo z `GH_TOKEN` i w Actions |

Kroki 3–6 i 9 nie mają lokalnego odpowiednika. Dlatego w raporcie (`.sandbox/doctor.txt`) oczekiwane są:

- błędy grupy *Orgi Salesforce* (brak logowania JWT, krok 3);
- pominięta grupa *GitHub* i ostrzeżenie o `remote origin`, które nie jest repo GitHub;
- błąd `sfdx-git-delta`, jeśli plugin nie jest zainstalowany lokalnie.

Wszystkie inne pozycje powinny mieć `✔`. Żeby pracować w piaskownicy z poleceniem `sfpipe`, wykonaj `source .sandbox/env.sh` i przejdź do `.sandbox/salesforce`.

## 1. Repo `sfpipe` na GitHubie i pierwsza wersja

1. Utwórz prywatne repo `sfpipe` w organizacji i wypchnij to repo:

   ```bash
   git remote add origin git@github.com:TWOJA-ORGANIZACJA/sfpipe.git
   git push -u origin main
   ```

2. W repo `sfpipe`: **Settings → Actions → General → Access** ustaw *Accessible from repositories in the organization*. Bez tego repo `salesforce` nie wywoła reużywalnych workflowów.
3. Wypuść wersję. Workflow `release` opublikuje `@<organizacja>/sfpipe` do GitHub Packages:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. Po publikacji: **Packages → sfpipe → Package settings → Manage Actions access → Add repository**: `salesforce`, rola *Read*. Bez tego workflowy w `salesforce` nie zainstalują CLI.

## 2. Repo `salesforce`: przygotowanie

1. Zainstaluj CLI lokalnie z tego repo (do czasu instalacji z GitHub Packages):

   ```bash
   npm ci && npm run build && npm install --global ./packages/cli
   ```

2. W katalogu głównym repo `salesforce`:

   ```bash
   sfpipe doctor --only tools repo
   ```

   Sprawdza format source (`sfdx-project.json`), `.forceignore` i remote. Jeśli repo jest w formacie Metadata API, doctor podpowie komendę konwersji.

3. Domknij stare gałęzie: zmerguj albo zamknij to, co jest w toku, i usuń zmergowane (`git branch -r --merged origin/main`). Nowy model zaczyna od czystego `main`.
4. Utwórz konfigurację, uzupełnij `mirror.types` i `users`, sprawdź ją i wprowadź do `main` przez PR:

   ```bash
   sfpipe init
   sfpipe config validate
   ```

## 3. Salesforce: logowanie JWT dla każdego orga

Dla każdego z orgów `sf-dev`, `sf-uat`, `sf-stage`, `sf-prod`:

1. Wygeneruj klucz i certyfikat (osobne dla każdego orga):

   ```bash
   openssl req -x509 -newkey rsa:4096 -sha256 -days 730 -nodes -keyout sf-uat.key -out sf-uat.crt -subj "/CN=sfpipe-uat"
   ```

   Klucz trzymaj w menedżerze haseł; `*.key` jest w `.gitignore`.

2. Dedykowany użytkownik integracyjny (np. `sfpipe@firma.pl` na prod, z sufiksem sandboxa w sandboxach) z uprawnieniami do deployu przez Metadata API: m.in. *API Enabled* i *Modify Metadata Through Metadata API Functions*; do deployu Apex i uruchamiania testów zwykle także *Modify All Data* lub *Author Apex*. Dokładny zestaw ustalcie z adminem Salesforce.
3. **External Client App** (lub Connected App): OAuth z zakresami *api* i *refresh_token, offline_access*, włączony JWT Bearer Flow, wgrany `sf-uat.crt`, polityka *Admin approved users are pre-authorized*, dostęp dla użytkownika integracyjnego przez permission set. Consumer Key to `SF_CLIENT_ID`.
4. Test logowania lokalnie:

   ```bash
   sf org login jwt --client-id "<consumer key>" --jwt-key-file sf-uat.key --username "sfpipe@firma.pl.uat" --instance-url "https://firma--uat.sandbox.my.salesforce.com" --alias sf-uat
   ```

   Alias musi być równy nazwie Environment z kroku 4 (`sf-<środowisko>`); doctor sprawdza też, że alias nieprodukcyjny wskazuje na sandbox.

## 4. GitHub Environments w repo `salesforce`

**Settings → Environments → New environment**: `sf-dev`, `sf-uat`, `sf-stage`, `sf-prod`. W każdym sekrety Environment:

| Sekret | Wartość |
|---|---|
| `SF_CLIENT_ID` | Consumer Key z kroku 3 |
| `SF_USERNAME` | użytkownik integracyjny w tym orgu |
| `SF_INSTANCE_URL` | My Domain orga, np. `https://firma--uat.sandbox.my.salesforce.com` |
| `SF_JWT_KEY` | cała zawartość pliku `.key` |

Reviewerzy:

| Environment | Required reviewers | Prevent self-review |
|---|---|---|
| `sf-dev` | brak | — |
| `sf-uat` | zespół Developers | nie (autor może zatwierdzić) |
| `sf-stage` | zespół Developers | nie |
| `sf-prod` | Product Owner | tak |

Ograniczenia *Deployment branches* ustawimy w fazie 2–3 razem z workflowami deployu, bo zależą od tego, jak będą wyzwalane.

## 5. GitHub App dla workflowów

Workflowy (push lustra do `dev`, PR-y, auto-merge, labele) działają przez dedykowaną GitHub App, nie przez osobisty token. Potrzebna od fazy 1, ale utwórz ją teraz, bo jest bypassem w rulesecie `dev` (krok 9).

1. **Organization settings → Developer settings → GitHub Apps → New GitHub App** (`sfpipe-bot`), bez webhooka. Uprawnienia repozytorium: *Contents* read/write, *Pull requests* read/write, *Issues* read/write, *Metadata* read. Uprawnienia organizacji: *Projects* read/write.
2. Zainstaluj ją tylko na repo `salesforce`.
3. W repo `salesforce`: zmienna `SFPIPE_APP_ID` i sekret `SFPIPE_APP_PRIVATE_KEY` (klucz prywatny aplikacji).

## 6. Labele i Project

```bash
gh label create user-story --color 0E8A16 --description "User Story (sfpipe)"
gh label create sf:uat --color FBCA04 --description "US wdrożony na UAT"
gh label create sf:stage --color F9A825 --description "US wdrożony na stage"
gh label create sf:prod --color 5319E7 --description "US wdrożony na prod"
```

Project organizacji z polem jednokrotnego wyboru **Środowisko**: `dev`, `uat`, `stage`, `prod`.

## 7. Baseline: `main`, `uat`, `stage`

Celem jest, żeby każda gałąź była zgodna ze swoim orgiem.

1. Manifest śledzonych typów (raz, potem przytnij do potrzebnych typów i zapisz w repo):

   ```bash
   sf project generate manifest --from-org sf-prod --name tracked --output-dir manifest
   ```

2. `main` względem prod, przez PR:

   ```bash
   git switch main && git pull
   git switch -c baseline/prod
   sf project retrieve start --manifest manifest/tracked.xml --target-org sf-prod --wait 120
   git add -A && git commit -m "baseline: stan prod"
   git push -u origin baseline/prod
   ```

   Retrieve aktualizuje i dodaje pliki, ale nie usuwa tych, których w orgu już nie ma. Żeby je znaleźć, zrób retrieve do pustego katalogu (`--output-dir /tmp/prod`) i porównaj z `force-app` (`diff -rq`).

3. `uat` i `stage` od zaktualizowanego `main`, z różnicami swoich orgów:

   ```bash
   git switch main && git pull
   git switch -c uat
   sf project retrieve start --manifest manifest/tracked.xml --target-org sf-uat --wait 120
   git add -A && git commit -m "baseline: stan uat"
   git push -u origin uat
   ```

   To samo dla `stage` z `--target-org sf-stage`.

## 8. Baseline: lustro `dev`

Pierwszy pełny snapshot orga dev. Full Copy ma rozmiar produkcji, więc retrieve może trwać długo.

```bash
git switch main && git pull
git switch -c dev
sf project retrieve start --manifest manifest/tracked.xml --target-org sf-dev --wait 240
git add -A && git commit -m "dev: pierwszy snapshot lustra"
git push -u origin dev
```

Od fazy 1 gałąź `dev` aktualizuje już tylko workflow lustra.

## 9. Rulesety w repo `salesforce`

**Settings → Rules → Rulesets → New branch ruleset**, enforcement *Active*, bypass tylko *Repository admin* (do `env reset`). **Nie** włączaj *Require linear history* ani merge queue.

| Ruleset | Gałęzie | Reguły |
|---|---|---|
| `sfpipe uat` | `uat` | Restrict deletions; Block force pushes; Require a pull request: 1 approval, Require conversation resolution, Allowed merge methods: tylko *Merge*; Require status checks: *Require branches to be up to date* + check `sfpipe-pr` |
| `sfpipe stage-main` | `stage`, `main` | jak wyżej, ale 0 approvals i bez wymogu rozwiązanych wątków |
| `sfpipe dev` | `dev` | Restrict updates (bypass: aplikacja `sfpipe-bot`); Restrict deletions; Block force pushes |

Check `sfpipe-pr` powstaje dopiero w fazie 2. Do tego czasu nie da się go wybrać w rulesecie, a doctor pokaże błąd „brak wymaganego checku sfpipe-pr” dla `uat`, `stage` i `main`. To oczekiwany wyjątek. Konfigurację (`.sfpipe/config.yml`) zmieniacie do tego czasu zwykłym PR-em do `main`.

## 10. Doctor

Lokalnie, z tokenem z `gh`:

```bash
GH_TOKEN="$(gh auth token)" sfpipe doctor
```

Sprawdzenie sekretów w Environments wymaga uprawnień admina repo; bez nich doctor oznaczy je jako pominięte.

W Actions: skopiuj `examples/sfdx-project/.github/workflows/sfpipe-doctor.yml` do repo `salesforce`, zamień `TWOJA-ORGANIZACJA` i uruchom ręcznie. Z opcją `check-orgs` workflow zaloguje się do każdego orga sekretami z Environments, więc `sf-uat`, `sf-stage` i `sf-prod` poproszą o akceptację. To jednocześnie test sekretów z kroku 4.
