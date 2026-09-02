# Automatyzacja na macOS

Ten przewodnik opisuje instalację systemową `jira-time-copy`: aplikację w pasku menu, zadania
`launchd`, przypomnienia, logi i diagnostykę.

## Instalacja i aktualizacja

```bash
pnpm configure
```

Kreator zapisuje konfigurację Jiry, kompiluje małą aplikację AppKit i instaluje ją w katalogu
użytkownika. Nie wymaga uprawnień administratora ani wpisów w `crontab`.

Ponowne uruchomienie kreatora:

- zachowuje dotychczasowe wartości jako odpowiedzi domyślne;
- ponownie sprawdza dostęp do obu Jir;
- aktualizuje godziny i próg pełnego dnia;
- przebudowuje aplikację menu;
- przeładowuje wszystkie zadania `launchd`;
- wysyła testowe powiadomienie.

## Co jest instalowane

| Element | Lokalizacja |
|---|---|
| Konfiguracja | `~/.jira-time-copy.env` |
| Aplikacja | `~/Applications/Jira Time Copy.app` |
| Stan dzisiejszego czasu | `~/Library/Application Support/jira-time-copy/status.json` |
| Agenty | `~/Library/LaunchAgents/dev.this-is-fine.jira-time-copy.*.plist` |
| Logi | `~/Library/Logs/jira-time-copy*.log` |

Konfiguracja, stan i logi mają uprawnienia `600`.

## Zadania launchd

### `dev.this-is-fine.jira-time-copy.status`

Uruchamia się po instalacji i później co 300 sekund. Pobiera wyłącznie dzisiejsze worklogi
z Jiry źródłowej, sumuje je i zapisuje mały plik stanu dla aplikacji menu.

- Jira źródłowa: odczyt;
- Jira docelowa: brak połączenia;
- przy błędzie: menu pokazuje nieudane sprawdzenie, a szczegóły trafiają do logu.

### `dev.this-is-fine.jira-time-copy.reminder`

Uruchamia się od poniedziałku do piątku o godzinie ustawionej jako `REMINDER_TIME`. Sprawdza dni
robocze od początku bieżącego miesiąca do dzisiaj.

Powiadomienie pojawia się, gdy którykolwiek dzień ma mniej niż `WORKDAY_HOURS`:

| Czas przy progu 8 h | Wynik |
|---:|---|
| `0.00 h` | Powiadomienie o pustym dniu. |
| `2.00 h` | Powiadomienie o niepełnym dniu `2.00/8.00 h`. |
| `8.00 h` lub więcej | Brak powiadomienia. |

Komunikat wymienia również niepełne wcześniejsze dni. Weekendy są pomijane. Nie ma integracji
z kalendarzem świąt ani urlopów, więc taki dzień może wymagać ręcznego zignorowania alertu.

Jeśli Jira źródłowa jest niedostępna, pojawia się osobne powiadomienie o błędzie sprawdzenia.

### `dev.this-is-fine.jira-time-copy.sync`

Uruchamia się codziennie o `SYNC_TIME` z opcją `--commit`. Pobiera bieżący miesiąc, sumuje czas
per dzień i zapisuje brakujące dni w zbiorczym zadaniu Jiry docelowej.

Jeśli w zadaniu docelowym istnieje już worklog użytkownika z danego dnia, agent nie dopisuje kolejnego
wpisu. Zapisuje kolizję w logu i przechodzi dalej. Dzięki temu ponowne uruchomienie jest bezpieczne.

### `dev.this-is-fine.jira-time-copy.menu`

Startuje po zalogowaniu użytkownika i utrzymuje ikonę w pasku menu. Nie wykonuje zapisu samodzielnie;
przycisk „Synchronizuj teraz” zleca uruchomienie agenta `sync`.

Zadania kalendarzowe zwykle mają stan `not running` pomiędzy wykonaniami. To prawidłowe — aktywny
proces pojawia się tylko na czas pracy. Agent menu powinien mieć stan `running`.

## Pasek menu

Menu pokazuje:

- ostatnią synchronizację i jej wynik;
- dzisiejszy czas w Jirze źródłowej względem progu, np. `6.50 h / 8.00 h`;
- godzinę ostatniego odczytu statusu;
- czas skopiowany dzisiaj i łącznie od instalacji;
- liczbę kolizji ostatniej synchronizacji;
- godziny przypomnienia i automatycznego zapisu.

Dostępne akcje:

- **Synchronizuj teraz** — natychmiast uruchamia ten sam proces co harmonogram;
- **Otwórz log** — otwiera główny log synchronizacji;
- **Zakończ** — zamyka aplikację menu; `launchd` uruchomi ją ponownie po następnym logowaniu.

## Powiadomienia

Konfigurator rejestruje aplikację, prosi o zgodę i wysyła test. Ustawienie trwałego alertu jest
deklarowane przez aplikację, ale macOS pozwala użytkownikowi je nadpisać.

Jeśli komunikat znika automatycznie:

1. otwórz **Ustawienia systemowe → Powiadomienia → Jira Time Copy**;
2. włącz powiadomienia;
3. w sekcji **Styl alertów** wybierz **Stałe** zamiast **Tymczasowe**.

Kreator odczytuje faktyczny styl z systemu. Jeśli nie jest trwały, otwiera panel ustawień i nie
zgłasza fałszywego sukcesu. macOS nie pozwala aplikacji kliknąć tej opcji za użytkownika.

## Logi i stan

| Plik | Zawartość |
|---|---|
| `~/Library/Logs/jira-time-copy.log` | Automatyczne i ręczne synchronizacje, sumy oraz kolizje. |
| `~/Library/Logs/jira-time-copy-status.log` | Odczyty dzisiejszego czasu co 5 minut. |
| `~/Library/Logs/jira-time-copy-reminder.log` | Wyniki sprawdzania niepełnych dni. |
| `~/Library/Logs/jira-time-copy-menu.log` | Błędy aplikacji paska menu. |
| `~/Library/Application Support/jira-time-copy/status.json` | Ostatni stan czytany przez menu. |

Szybki podgląd głównego logu:

```bash
tail -n 100 ~/Library/Logs/jira-time-copy.log
```

## Diagnostyka launchd

Sprawdzenie aplikacji menu:

```bash
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.menu
```

Sprawdzenie automatycznej synchronizacji:

```bash
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.sync
```

Sprawdzenie odczytu statusu:

```bash
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.status
```

Najważniejsze pola:

- `state = running` — proces aktualnie działa;
- `runs` — liczba uruchomień od załadowania agenta;
- `last exit code = 0` — ostatnie wykonanie zakończyło się poprawnie;
- `StartCalendarInterval` albo `run interval` — aktywny harmonogram.

## Typowe problemy

### Menu pokazuje stare dane

Odczyt odbywa się co 5 minut, a aplikacja odświeża widok co 30 sekund. Jeśli ostatnie sprawdzenie
zakończyło się błędem, zajrzyj do `jira-time-copy-status.log`.

### Synchronizacja nie uruchamia się po zmianie wersji Node.js

Agent zapisuje pełną ścieżkę aktualnego procesu Node.js. Po zmianie lub usunięciu wersji zarządzanej
przez `nvm` uruchom ponownie:

```bash
pnpm configure
```

### Powiadomienie pojawia się i znika

W ustawieniach powiadomień aplikacji wybierz styl **Stałe**. Sama zgoda na powiadomienia nie zmienia
stylu **Tymczasowe**.

### Automatyzacja zgłasza kolizję

To oznacza, że dzień ma już wpis w zadaniu docelowym. Agent celowo go nie zmienia. Jeśli istniejący
wpis jest błędny, użyj trybu interaktywnego i wybierz „Nadpisz” albo popraw go ręcznie w Jirze.

## Zmiana harmonogramu

Uruchom ponownie kreator:

```bash
pnpm configure
```

Zmiana jest zapisywana w `~/.jira-time-copy.env`, a wszystkie agenty są przeładowywane od razu.
