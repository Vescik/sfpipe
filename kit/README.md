# Zestaw sf-pipeline dla istniejącego repo

Pipeline wdrożeń Salesforce jako zwykłe pliki w Twoim repo: 4 workflowy GitHub Actions i kilka skryptów. Nie trzeba instalować żadnego programu ani paczki: na komputerze wystarczą `git`, `sf` i `gh`, resztę robi GitHub Actions.

```
work-item/5001-opis ──sf-promote──▶ promote/5001/uat ──PR──▶ uat      (każdy US osobno)
main + wybrane US ───sf-release───▶ release/2026.12 ──PR──▶ stage
                                    release/2026.12 ──PR──▶ main     (= produkcja)
main ──sf-back-sync──▶ sync/main/uat, sync/main/stage ──PR──▶ uat, stage

Każdy PR do uat / stage / main:  sf-plan (paczka z gita) → akceptacja w Environment → sf-deploy → auto-merge
```

- **Paczka = różnica w gicie.** Do orga idzie dokładnie to, co zmieni się w gałęzi środowiska po merge'u PR-a (sfdx-git-delta), łącznie z usunięciami.
- **Deploy przed merge'em.** PR wchodzi do gałęzi dopiero po udanym deployu, więc gałąź `uat` = org UAT, `stage` = org stage, `main` = produkcja.
- **Akceptacje:** UAT i stage zatwierdza developer, produkcję Product Owner (w oknie deployu).
- **Tematy commitów** są zgodne z hookiem harnessu (`[WI-<id>] … — AB#<id>`, `[chore] …`).

## Co kopiujesz do repo

```
.github/workflows/sf-deploy.yml      PR do uat/stage/main: plan → akceptacja → deploy
.github/workflows/sf-promote.yml     przycisk: US na UAT
.github/workflows/sf-release.yml     przycisk: release create / update / ship
.github/workflows/sf-back-sync.yml   automatycznie po zmianie main
.github/sf-pipeline/config.json      ustawienia: gałęzie, Environments, testy, okno deployu
.github/sf-pipeline/*.py, *.sh       skrypty używane przez workflowy
```

`rulesets/*.json` importujesz w ustawieniach repo (krok 7). `tests/` zostaje tutaj.

---

## Krok 1. Gałęzie `uat` i `stage`

W PowerShellu, w katalogu Twojego repo:

```powershell
git fetch origin; git push origin origin/main:refs/heads/uat; git push origin origin/main:refs/heads/stage
```

**Baseline (zalecane, przed krokiem 7).** Jeśli org UAT albo stage różni się od `main`, ustaw gałąź na stan orga. Inaczej pierwszy deploy porówna paczkę z czymś, czego w orgu nie ma. Przykład dla uat (alias jak w `config\harness.local.json`):

```powershell
git switch uat; sf project retrieve start --manifest manifest/package.xml --target-org ALIAS-UAT; git status
```

Jeśli `git status` pokazuje zmiany, zacommituj je prosto na `uat` (rulesetów jeszcze nie ma):

```powershell
git add -A; git commit -m "[chore] baseline: uat org state"; git push origin uat
```

To samo dla `stage`. Produkcję (`main`) porównaj tak samo, ale różnice wprowadź przez PR do `main`.

## Krok 2. Salesforce: logowanie JWT (uat, stage, prod)

W każdym z trzech orgów:

1. **Klucz i certyfikat**, osobne dla każdego orga, poza katalogiem repo:

   ```powershell
   & "C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -newkey rsa:4096 -sha256 -days 730 -nodes -keyout sf-uat.key -out sf-uat.crt -subj "/CN=sf-pipeline-uat"
   ```

2. **Użytkownik integracyjny**, np. `sf-pipeline@firma.pl` (w sandboxie z sufiksem). Potrzebuje uprawnień do deployu: *API Enabled*, *Modify Metadata Through Metadata API Functions*, do Apex zwykle *Modify All Data* lub *Author Apex*.
3. **Setup → External Client App Manager → New:**
   - OAuth, zakresy *api* i *refresh_token, offline_access*;
   - *Enable JWT Bearer Flow* z wgranym `sf-uat.crt`;
   - polityka *Admin approved users are pre-authorized* i dostęp dla użytkownika integracyjnego (permission set).

   **Consumer Key** to późniejszy `SF_CLIENT_ID`.
4. **Test logowania:**

   ```powershell
   sf org login jwt --client-id "CONSUMER-KEY" --jwt-key-file sf-uat.key --username "sf-pipeline@firma.pl.uat" --instance-url "https://firma--uat.sandbox.my.salesforce.com" --alias sfp-uat-test
   ```

## Krok 3. GitHub Environments

**Settings → Environments → New environment**, trzy razy:

| Environment | Required reviewers | Prevent self-review |
|---|---|---|
| `sf-uat` | zespół developerów | nie (autor może zatwierdzić deploy) |
| `sf-stage` | zespół developerów | nie |
| `sf-prod` | Product Owner | tak |

Sekrety każdego Environment (przykład dla `sf-uat`):

```powershell
gh secret set SF_CLIENT_ID --env sf-uat --body "CONSUMER-KEY"
```
```powershell
gh secret set SF_USERNAME --env sf-uat --body "sf-pipeline@firma.pl.uat"
```
```powershell
gh secret set SF_INSTANCE_URL --env sf-uat --body "https://firma--uat.sandbox.my.salesforce.com"
```
```powershell
Get-Content sf-uat.key -Raw | gh secret set SF_JWT_KEY --env sf-uat
```

Sekrety Environment trafiają do joba dopiero po akceptacji, więc job produkcyjny dostaje klucz prod dopiero, gdy PO zatwierdzi deploy. Nazwy Environments muszą być takie jak w `config.json` (`environment`).

## Krok 4. GitHub App (PR-y z workflowów)

PR otwarty przez workflow tokenem `GITHUB_TOKEN` nie uruchamia innych workflowów, więc promocja, release i back-sync otwierają PR-y jako GitHub App.

1. **Organization settings → Developer settings → GitHub Apps → New GitHub App:**
   - nazwa np. `sf-pipeline-bot`, *Webhook* wyłączony;
   - uprawnienia repozytorium: *Contents* read and write, *Pull requests* read and write, *Workflows* read and write, *Metadata* read-only.
2. **Generate a private key** (pobierze się plik `.pem`). Zapisz też **Client ID** ze strony aplikacji.
3. **Install App** tylko na Twoim repo.
4. W repo:

   ```powershell
   gh variable set SF_PIPELINE_APP_CLIENT_ID --body "CLIENT-ID"
   ```
   ```powershell
   Get-Content sf-pipeline-bot.private-key.pem -Raw | gh secret set SF_PIPELINE_APP_KEY
   ```

## Krok 5. Ustawienia repo

```powershell
gh repo edit --enable-merge-commit --enable-auto-merge
```

To samo w przeglądarce: **Settings → General → Pull Requests**: *Allow merge commits* i *Allow auto-merge*.

## Krok 6. Skopiuj pliki i dostosuj

```powershell
git switch main; git pull; git switch -c chore/sf-pipeline
```
```powershell
Copy-Item -Path "$HOME\sfpipe\kit\.github\*" -Destination .\.github -Recurse -Force
```

Otwórz `.github\sf-pipeline\config.json` i sprawdź:

| Pole | Co ustawić |
|---|---|
| `sourceDir` | katalog z metadanymi (`force-app`) |
| `flow` | gałęzie: US na `uat`, release na `stage`, produkcja `main` |
| `workItemBranches` | prefiksy gałęzi US: `work-item/` i `feature/` jak w harnessie |
| `commits` | szablony tematów commitów; domyślne pasują do hooka harnessu |
| `branches.<gałąź>.environment` | nazwa GitHub Environment z kroku 3 |
| `branches.<gałąź>.testLevel` | `RunSpecifiedTests` (testy dobierane po nazwach z `testNaming`) albo `RunLocalTests` |
| `branches.<gałąź>.allowedSources` | z jakich gałęzi PR może wnosić metadane |
| `branches.main.deployWindow` | okno deployu na produkcję, np. `Tue,Thu 18:00-21:00 Europe/Warsaw` |

Jeśli zmieniasz nazwy gałęzi, popraw je też w `sf-deploy.yml` (`branches:`) i `sf-back-sync.yml` (`branches:`).

```powershell
git add .github; git commit -m "[chore] add sf-pipeline workflows"; git push -u origin chore/sf-pipeline; gh pr create --fill --base main
```

Ten PR od razu jest testem: `sf-deploy` ruszy, nie znajdzie zmian w metadanych, więc `sf-plan` przejdzie, a deploy zostanie pominięty. W harnessie pójdzie też pełne CI (`PR CI / Gate`), bo zmiany są w `.github/`.

## Krok 7. Rulesety

**Settings → Rules → Rulesets → New ruleset → Import a ruleset** i wybierz kolejno:

- `rulesets/sf-uat.json`: PR wymagany, 1 approve, rozwiązane wątki, tylko merge commit, wymagane checki `sf-plan` i `sf-deploy`, PR aktualny względem gałęzi;
- `rulesets/sf-stage-main.json`: to samo dla `stage` i `main`, bez wymaganego approve (decyzję podejmuje akceptacja deployu).

Albo z PowerShella (w miejsce `ORG/REPO` wpisz swoje repo):

```powershell
gh api repos/ORG/REPO/rulesets --method POST --input "$HOME\sfpipe\kit\rulesets\sf-uat.json"
```
```powershell
gh api repos/ORG/REPO/rulesets --method POST --input "$HOME\sfpipe\kit\rulesets\sf-stage-main.json"
```

Istniejący ruleset harnessu na `main` (z `PR CI / Gate`) zostaw. GitHub łączy reguły, więc na `main` będą wymagane oba zestawy checków.

## Krok 8. Pierwsza próba

1. Mały US: `git switch -c work-item/<id>-proba origin/main`, nieszkodliwa zmiana (np. opis pola), commit `[WI-<id>] … — AB#<id>`, `git push -u origin HEAD`.
2. **Actions → sf-promote → Run workflow**, ID = `<id>`. Powstaje PR `promote/<id>/uat → uat`.
3. W PR: `sf-plan` pokazuje paczkę i testy (zakładka *Checks* → podsumowanie). Ktoś z zespołu robi review, a w jobie `sf-deploy` klikasz **Review deployments → Approve**.
4. Po udanym deployu PR merguje się sam, a US jest w orgu UAT.

---

## Codzienna praca

| Co | Jak |
|---|---|
| Nowy US | `git switch -c work-item/5001-opis origin/main` (w harnessie robi to agent) |
| Komponent z orga dev do US | `sf project retrieve start --metadata "ApexClass:Foo" --target-org ALIAS-DEV`, potem commit `[WI-5001] add ApexClass:Foo — AB#5001` |
| Usunięcie komponentu z paczki | zmieniony: `git checkout origin/main -- <pliki>`; nowy: `git rm <pliki>`; commit. Jeśli komponent był już na UAT, kolejna promocja przywróci tam wersję z produkcji |
| Podgląd paczki lokalnie | `sf sgd source delta --from origin/main --to HEAD --output-dir .sfdelta` i plik `.sfdelta\package\package.xml` |
| US na UAT | **Actions → sf-promote** z ID US |
| Poprawka po testach UAT | commit na gałęzi US, push i ponownie **sf-promote**: ten sam PR się zaktualizuje |
| Release | **sf-release**: `create`, nazwa `2026.12`, ID `5001 5002` → PR do stage → testy → **sf-release** `ship` → PO zatwierdza deploy w oknie |
| Hotfix | US od `main`, potem **sf-release** `create` z nazwą `hotfix-6001`, ID `6001` i zaznaczonym *skip uat check* → stage → `ship` |
| Back-sync | sam, po każdym merge'u do `main` (PR-y do `stage` i `uat`) |
| Konflikt przy promocji lub release | workflow kończy się błędem i wypisuje w podsumowaniu komendy do rozwiązania konfliktu lokalnie |
| Inny PR wszedł przed Twoim | `sf-deploy` kończy się błędem „zmieniła się od startu”: w PR kliknij **Update branch** |

## Zmiana w procesie harnessu

Dziś PR z `work-item/…` idzie prosto do `main`. Z zestawem US idą przez **sf-promote** na `uat`, a do `main` trafiają tylko release'y. Jeśli PR z gałęzi US do `main` zmienia metadane, `sf-plan` go zablokuje. Zmiany bez metadanych (agenci, dokumentacja, `work-items/`) dalej mogą iść do `main` zwykłym PR-em. Zaktualizujcie w harnessie `docs/delivery-process.md` i skill `git-workflow`, żeby agenci nie otwierali PR-ów z US do `main`.

## Czego zestaw jeszcze nie robi

- **Lustra orga dev w gicie.** Komponenty z dev dobiera się poleceniem `sf project retrieve`.
- **Wykrywania, że dwa US zmieniają ten sam komponent.**
- **Walidacji na prod dzień wcześniej i quick deployu.** Teraz deploy na prod uruchamia testy w oknie.
- **Automatycznego rollbacku.** Cofnięcie to revert merge'a w gałęzi środowiska przez PR, wdrażany tym samym `sf-deploy`.
