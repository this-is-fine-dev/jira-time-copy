# jira-time-copy

Przepisuje czas zaraportowany w jednej Jirze do zbiorczego zadania w drugiej.

Typowy przypadek: pracujesz w firmie A, ale jesteś wystawiony do klienta B. Czas raportujesz na
bieżąco w Jirze klienta, rozbity na dziesiątki zadań — a na koniec miesiąca musisz to samo wyklikać
u siebie, dzień po dniu, na jednym zbiorczym tasku. Ten skrypt robi to za ciebie: sumuje twoje
worklogi per dzień i wpisuje jeden worklog dziennie w zadaniu zbiorczym.

- działa z **Jira Cloud** (`*.atlassian.net`) i **Jira Server/DC** — w dowolnej kombinacji
- **nic nie zapisuje bez potwierdzenia** — domyślnie tryb podglądu
- **nie duplikuje** — dni już zaraportowane wykrywa i pyta, co z nimi zrobić
- jedna zależność (`@clack/prompts`), reszta to stdlib Node

## Wymagania

- Node 18+ (używa wbudowanego `fetch`)
- pnpm (albo npm — wtedy `npm run` zamiast `pnpm`)
- token do obu Jir (skąd — podpowie kreator)

## Instalacja

```bash
git clone git@github.com:this-is-fine-dev/jira-time-copy.git
cd jira-time-copy
pnpm install
```

## Konfiguracja

```bash
pnpm configure
```

Kreator pyta po kolei o obie Jiry. Po URL-u sam rozpoznaje typ instancji i mówi, skąd wziąć token:

- **Jira Cloud** — token generujesz na koncie Atlassian, nie w samej Jirze:
  <https://id.atlassian.com/manage-profile/security/api-tokens> → *Create API token* (zwykły, bez
  scope). Pyta też o email konta Atlassian — Cloud używa basic auth `email:token`.
- **Jira Server/DC** — token z profilu: `<adres-jiry>/secure/ViewProfile.jspa` → zakładka
  *Personal Access Tokens*. Email niepotrzebny.

Na koniec podajesz klucz zbiorczego zadania (np. `TIME-42`) i decydujesz, czy w komentarzu worklogu
mają lądować klucze zadań źródłowych (domyślnie **nie** — jeśli nie chcesz pokazywać u siebie, nad
czym konkretnie pracowałeś u klienta).

Kreator sprawdza dostęp do obu Jir i tytuł zadania docelowego, zanim cokolwiek zapisze. Konfiguracja
ląduje w `~/.jira-time-copy.env` z prawami `600`. Ponowne `pnpm configure` podpowiada stare wartości
(Enter = bez zmian).

## Użycie

```bash
pnpm start                      # interaktywnie: wybierasz okres, dni i zatwierdzasz zapis
pnpm start 2026-08              # to samo, z gotowym miesiącem
pnpm start 2026-08-27           # to samo, dla jednego dnia
pnpm start 2026-08 --dry-run    # sam podgląd tekstowy, bez pytań i bez zapisu
pnpm start 2026-08 --commit     # bez pytań: zapisuje, dni z kolizją pomija (cron)
```

Bez argumentu daty TUI zapyta: poprzedni miesiąc / bieżący / dzisiaj / inna data.

Przebieg interaktywny:

```
┌  jira-time-copy → TIME-42
│
◇  Znalazłem 12 dni, razem 87.50h
│
◆  Które dni przenieść? (spacja = zaznacz, enter = dalej)
│  ◼ 2026-08-03   8.00h  ABC-201, ABC-198
│  ◼ 2026-08-04   7.50h  ABC-201
│  ◻ 2026-08-05   9.00h  w TIME-42 masz juz 8.00h — ABC-205
```

Wszystko aż do pytania *„Zapisać X.XXh do TIME-42?"* jest tylko odczytem — odpowiedź **No** albo
Ctrl+C nie zostawia śladu. Dopiero potwierdzenie wysyła worklogi.

### Dzień, który już masz zaraportowany

Dla każdego takiego dnia TUI pyta osobno:

| Wybór | Co robi |
|---|---|
| **Zsumuj** | dopisuje worklog z Jiry źródłowej obok istniejącego (8h + 9h = 17h) |
| **Pomiń** | nie rusza niczego |
| **Nadpisz** | kasuje **twoje** worklogi z tego dnia w zadaniu docelowym i wpisuje wersję źródłową |

Cudzych worklogów skrypt nie dotyka nigdy — filtruje po autorze. Ale *Nadpisz* kasuje wszystkie
twoje wpisy z tego dnia w tym zadaniu, również te dodane ręcznie z innego powodu.

## Jak to działa

1. W Jirze źródłowej leci JQL `worklogAuthor = currentUser() AND worklogDate >= … <= …`, potem dla
   każdego znalezionego zadania pobierane są worklogi i filtrowane po tobie i zakresie dat.
2. Sekundy sumują się per dzień (kilka zadań tego samego dnia = jeden wpis).
3. W zadaniu docelowym powstaje jeden worklog na dzień, ze startem 09:00 UTC.
4. Przed zapisem pobierane są twoje istniejące worklogi z zadania docelowego — stąd wykrywanie kolizji.

## Konfiguracja przez zmienne środowiskowe

Każdą wartość z pliku można nadpisać zmienną o tej samej nazwie (przydatne w CI/cronie):

| Zmienna | Znaczenie |
|---|---|
| `SRC_URL`, `DST_URL` | adresy Jiry źródłowej i docelowej |
| `SRC_EMAIL`, `DST_EMAIL` | email konta Atlassian — **tylko** dla Jira Cloud; pusty = token osobisty (Bearer) |
| `SRC_TOKEN`, `DST_TOKEN` | tokeny |
| `DST_ISSUE` | klucz zbiorczego zadania |
| `COMMENT_KEYS` | `1` = dopisz klucze zadań źródłowych do komentarza worklogu |
| `JIRA_TIME_COPY_ENV` | inna ścieżka pliku konfiguracyjnego niż `~/.jira-time-copy.env` |

Przykład wpisu do crona — 1. dnia miesiąca o 10:00 przepisuje poprzedni miesiąc:

```cron
# macOS
0 10 1 * * cd ~/jira-time-copy && pnpm start "$(date -v-1m +\%Y-\%m)" --commit
# Linux
0 10 1 * * cd ~/jira-time-copy && pnpm start "$(date -d 'last month' +\%Y-\%m)" --commit
```

Bez terminala skrypt nie pyta o nic: zapisuje dni bez kolizji, a te już zaraportowane pomija.

## Testy

```bash
pnpm test
```

Sprawdza sumowanie per dzień, zakresy dat, parser konfiguracji i budowanie worklogu — bez sieci.

## Uwagi

- Token daje pełny dostęp do twojego konta w Jirze. Trzymaj plik konfiguracyjny lokalnie i nie
  commituj go — `.gitignore` pilnuje `*.env`.
- Skrypt nigdy nie kasuje niczego w Jirze **źródłowej** — czyta tylko.
