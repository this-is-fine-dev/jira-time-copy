# jira-time-copy

Kopiuje czas zaraportowany w jednej Jirze do zbiorczego zadania w drugiej. Sumuje worklogi
użytkownika per dzień, wykrywa istniejące wpisy i może działać ręcznie albo automatycznie przez
`launchd` na macOS.

Typowy przypadek: czas raportujesz na bieżąco w Jirze klienta, na wielu zadaniach, a w firmowej
Jirze musisz wpisać dzienne sumy do jednego zadania. `jira-time-copy` robi to bez ręcznego
przepisywania.

## Najważniejsze możliwości

- Jira Cloud i Jira Server/Data Center w dowolnej kombinacji;
- interaktywny podgląd i wybór dni przed ręcznym zapisem;
- automatyczna codzienna synchronizacja przez `launchd` na macOS;
- ochrona przed duplikatami — automatyzacja pomija dni mające już worklog w zadaniu docelowym;
- natywna aplikacja w pasku menu z czasem źródłowym, statusem synchronizacji i statystykami;
- odświeżanie dzisiejszego czasu z Jiry źródłowej co 5 minut, bez zapisu;
- trwałe powiadomienia o pustych lub niepełnych dniach roboczych;
- konfigurowalna długość pełnego dnia, godzina przypomnienia i godzina synchronizacji;
- tokeny przechowywane lokalnie w pliku z uprawnieniami `600`.

Szczegóły integracji systemowej: [Automatyzacja na macOS](docs/macos.md).

## Wymagania

- Node.js 18+;
- pnpm lub npm;
- token dostępu do obu instancji Jiry;
- na macOS: Command Line Tools for Xcode, potrzebne do zbudowania małej aplikacji AppKit.

## Szybki start

```bash
git clone git@github.com:this-is-fine-dev/jira-time-copy.git
cd jira-time-copy
pnpm install
pnpm configure
```

Kreator:

1. pyta o adres i dane dostępowe do Jiry źródłowej;
2. pyta o adres i dane dostępowe do Jiry docelowej;
3. sprawdza logowanie do obu instancji i dostęp do zadania docelowego;
4. zapisuje konfigurację do `~/.jira-time-copy.env` z uprawnieniami `600`;
5. na macOS instaluje aplikację menu, zadania `launchd` i sprawdza powiadomienia.

Ponowne `pnpm configure` podpowiada zapisane wartości i aktualizuje istniejącą instalację.

### Tokeny Jiry

- **Jira Cloud** (`*.atlassian.net`) — podaj email konta Atlassian i zwykły API token z
  <https://id.atlassian.com/manage-profile/security/api-tokens>.
- **Jira Server/Data Center** — podaj Personal Access Token z profilu użytkownika; email zostaw
  pusty.

## Użycie z terminala

```bash
pnpm start                      # interaktywny wybór okresu, dni i sposobu zapisu
pnpm start 2026-08              # konkretny miesiąc
pnpm start 2026-08-27           # konkretny dzień
pnpm start 2026-08 --dry-run    # podgląd tekstowy bez zapisu
pnpm start 2026-08 --commit     # zapis bez pytań; kolizje są pomijane
```

Bez daty interaktywny tryb proponuje poprzedni miesiąc, bieżący miesiąc, dzisiaj albo własną datę.
Tryb interaktywny niczego nie zapisuje przed końcowym potwierdzeniem. Tryb `--commit` służy do
automatyzacji i zapisuje bez pytania.

### Kolizje

Kolizja oznacza, że w zadaniu docelowym istnieje już twój worklog z danego dnia.

| Tryb | Zachowanie |
|---|---|
| Interaktywny | Pozwala zsumować, pominąć albo nadpisać twoje wpisy z tego dnia. |
| `--commit` / `launchd` | Pomija cały dzień i zapisuje kolizję w logu. |

Opcja „Nadpisz” usuwa wyłącznie worklogi zalogowanego użytkownika w wybranym dniu i zadaniu
docelowym. Cudze wpisy oraz Jira źródłowa nigdy nie są modyfikowane.

## Automatyzacja na macOS

`pnpm configure` instaluje cztery zadania użytkownika:

| Zadanie | Domyślnie | Działanie |
|---|---:|---|
| Odczyt statusu | co 5 minut | Pobiera dzisiejszy czas z Jiry źródłowej. Tylko odczyt. |
| Przypomnienie | dni robocze, 16:00 | Alarmuje, gdy dzień ma mniej niż skonfigurowany próg. |
| Synchronizacja | codziennie, 23:00 | Kopiuje brakujące dni bieżącego miesiąca do Jiry docelowej. |
| Menu | po zalogowaniu | Pokazuje status i udostępnia ręczną synchronizację. |

Godziny są ustawiane w kreatorze. Na aktualnym komputerze mogą więc różnić się od wartości
domyślnych z tabeli.

Przypomnienie obejmuje dzisiaj i wcześniejsze dni robocze bieżącego miesiąca. Dla progu `8 h`
wartość `2 h` wywoła komunikat `2.00/8.00 h`, a `8 h` nie wywoła alarmu. Weekendy są pomijane;
święta i urlopy nie są obecnie rozpoznawane.

Aplikacja prosi macOS o trwałe alerty. System wymaga jednak, aby użytkownik sam zatwierdził dostęp
i ewentualnie wybrał styl **Stałe**. Kreator sprawdza faktyczne ustawienie i otwiera odpowiedni
panel, jeśli wykryje brak zgody albo znikające banery.

Pełny opis menu, agentów, plików, logów i diagnostyki znajduje się w
[docs/macos.md](docs/macos.md).

## Jak działa synchronizacja

1. W Jirze źródłowej wykonywane jest zapytanie JQL o worklogi bieżącego użytkownika w wybranym
   zakresie.
2. Dla znalezionych zadań pobierane są worklogi, filtrowane po użytkowniku i sumowane per dzień.
3. Z Jiry docelowej pobierane są istniejące wpisy użytkownika w zadaniu zbiorczym.
4. Dla każdego dnia bez kolizji powstaje jeden worklog z dzienną sumą.

Automatyczna synchronizacja bez podanej daty przetwarza bieżący miesiąc. Dzięki temu może uzupełnić
nie tylko dzisiaj, ale również wcześniejszy brakujący dzień.

## Konfiguracja

Wartości są przechowywane w `~/.jira-time-copy.env`. Każdą z nich można nadpisać zmienną
środowiskową o tej samej nazwie.

| Zmienna | Znaczenie |
|---|---|
| `SRC_URL`, `DST_URL` | Adresy Jiry źródłowej i docelowej. |
| `SRC_EMAIL`, `DST_EMAIL` | Email konta Atlassian dla Jira Cloud; pusty przy tokenie Bearer. |
| `SRC_TOKEN`, `DST_TOKEN` | Tokeny dostępowe. |
| `DST_ISSUE` | Klucz zbiorczego zadania w Jirze docelowej. |
| `COMMENT_KEYS` | `1` dopisuje klucze zadań źródłowych do komentarza worklogu. |
| `SYNC_TIME` | Godzina automatycznej synchronizacji na macOS, np. `23:00`. |
| `REMINDER_TIME` | Godzina przypomnienia w dni robocze, np. `16:00`. |
| `WORKDAY_HOURS` | Próg pełnego dnia, domyślnie `8`. |
| `JIRA_TIME_COPY_ENV` | Alternatywna ścieżka pliku konfiguracyjnego. |

## Linux i inne systemy

Interaktywny oraz bezobsługowy tryb Node.js działają poza macOS. Integracja z paskiem menu,
`launchd` i natywne powiadomienia są przeznaczone dla macOS.

Przykładowy cron uruchamiający synchronizację pierwszego dnia miesiąca:

```cron
0 10 1 * * cd ~/jira-time-copy && pnpm start "$(date -d 'last month' +\%Y-\%m)" --commit
```

## Testy

```bash
pnpm test
```

Self-check nie łączy się z Jirą. Sprawdza zakresy dat, dni robocze, próg niepełnego dnia, sumowanie
worklogów, parser konfiguracji i budowanie wpisu docelowego.

## Bezpieczeństwo

- plik konfiguracji, stan aplikacji i logi mają uprawnienia `600`;
- tokeny nie są przekazywane w argumentach procesów ani zapisywane w logach;
- agent statusu i przypomnienia tylko czytają Jirę źródłową;
- zapis wykonuje wyłącznie ręcznie zatwierdzona operacja albo zaplanowany agent synchronizacji;
- Jira źródłowa nigdy nie jest modyfikowana.
