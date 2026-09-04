# This Is Logged

> Your worklogs are fine. Probably.

Lekka aplikacja macOS w pasku menu, która pilnuje raportów czasu w Jirze. Pokazuje stan dnia,
tygodnia i miesiąca, przypomina o brakach i — opcjonalnie — kopiuje dzienne sumy do zbiorczego
zadania w drugiej Jirze.

## Dwa tryby

| Tryb | Jira główna | Jira docelowa | Kontrola raportów | Kopiowanie |
|---|---:|---:|---:|---:|
| Monitoring | wymagana | niepotrzebna | tak | nie |
| Monitoring + synchronizacja | wymagana | wymagana | tak | tak |

Druga Jira nie jest potrzebna do działania aplikacji. Awaria albo wyłączenie synchronizacji nie
blokuje odczytu raportów z Jiry głównej.

## Możliwości

- aktualny czas raportowany dzisiaj i bilans całego miesiąca;
- kontrola wczoraj, aktualnego tygodnia pracy i zakończonych dni miesiąca;
- wskazanie konkretnych dat oraz brakujących godzin;
- odświeżanie danych co minutę przez `launchd`;
- zachowanie ostatniego poprawnego odczytu po rozłączeniu VPN lub utracie sieci;
- trwałe powiadomienia o pustych i niepełnych dniach;
- polskie święta ustawowe i weekendy wyłączone z wymaganej normy;
- Jira Cloud oraz Jira Server/Data Center;
- opcjonalne porównanie i synchronizacja z drugą Jirą;
- bezpieczne rozwiązywanie różnic: automatyzacja niczego nie nadpisuje;
- tokeny przechowywane lokalnie z uprawnieniami `600`.

## Wymagania

- macOS 13.5 lub nowszy;
- token do Jiry głównej;
- token do Jiry docelowej tylko przy synchronizacji;
- paczka z tego repo jest obecnie budowana dla Apple Silicon.

## Instalacja

1. Otwórz `This Is Logged.dmg`.
2. Przeciągnij **This Is Logged** do **Applications**.
3. Uruchom aplikację. Przy pierwszym starcie automatycznie otworzy się natywna konfiguracja.
4. Podaj dane Jiry głównej, opcjonalnie włącz drugą Jirę, a następnie wybierz **Sprawdź i zapisz**.

Konfigurator:

- sprawdza logowanie do Jiry głównej i opcjonalnej Jiry docelowej przed zapisem;
- sprawdza istnienie zadania docelowego;
- zapisuje sekrety w `~/.this-is-logged.env` z uprawnieniami `600`;
- instaluje i przeładowuje właściwe zadania `launchd`;
- uruchamia monitoring i sprawdza trwałe powiadomienia.

Instalacja, pierwsza konfiguracja i późniejsze zmiany nie wymagają Terminala, Node.js ani pnpm.

Przy aktualizacji stara konfiguracja `~/.jira-time-copy.env`, status, logi i agenty są jednorazowo
migrowane do nazwy `this-is-logged`. Nie trzeba ponownie wpisywać tokenów.

### Tokeny

- **Jira Cloud** (`*.atlassian.net`) — email konta Atlassian oraz API token z
  <https://id.atlassian.com/manage-profile/security/api-tokens>;
- **Jira Server/Data Center** — Personal Access Token; pole email pozostaje puste.

## Menu macOS

Nagłówek pokazuje bieżący miesiąc, zaraportowane godziny względem planu, kompletność zamkniętych
dni oraz dzisiejszy czas.

W trybie monitoringu menu zawiera:

- raport dzisiejszy, wczorajszy, tygodniowy i miesięczny;
- dokładne daty braków w rozwijanych szczegółach;
- harmonogram przypomnienia;
- ręczne odświeżenie;
- ustawienia i log monitoringu.

Po włączeniu dodatku pojawia się osobna sekcja **Synchronizacja** z ręcznym zapisem, trybem
interaktywnym, harmonogramem i historią. Porównania z celem są widoczne tylko w szczegółach
raportów, a nie w głównym bilansie.

Szczegóły systemowe: [Automatyzacja na macOS](docs/macos.md).

## Powiadomienia i kalendarz

Przypomnienie sprawdza dzisiaj oraz wcześniejsze dni robocze bieżącego miesiąca. Przy normie
`8 h` wpis `2 h` wywoła komunikat `2.00/8.00 h`, a `8 h` lub więcej nie wywoła alarmu.

Weekendy oraz polskie święta ustawowe są pomijane. Urlopy i firmowy termin dnia wolnego
oddawanego za święto w sobotę wymagają kalendarza pracodawcy i nie są automatycznie rozpoznawane.

macOS wymaga, aby użytkownik zatwierdził powiadomienia i może wymagać ręcznego wyboru stylu
**Stałe**. Kreator sprawdza rzeczywiste ustawienie i otwiera właściwy panel, jeśli jest ono
niepoprawne.

## Opcjonalna synchronizacja

Synchronizacja sumuje worklogi użytkownika per dzień i zapisuje brakujące sumy w jednym zadaniu
drugiej Jiry. Zgodne dni są pomijane. Jeśli wartości się różnią, automatyzacja nie nadpisuje celu
i pokazuje powiadomienie umożliwiające uruchomienie trybu interaktywnego.

```bash
pnpm start                       # interaktywny wybór okresu i sposobu zapisu
pnpm start 2026-08               # konkretny miesiąc
pnpm start 2026-08-27            # konkretny dzień
pnpm start 2026-08 --dry-run     # podgląd bez zapisu
pnpm start 2026-08 --commit      # zapis bez pytań; różnice pomijane
```

W trybie interaktywnym różnicę można zsumować, pominąć albo nadpisać. Nadpisanie usuwa wyłącznie
worklogi zalogowanego użytkownika z wybranego dnia w zadaniu docelowym. Jira główna nigdy nie jest
modyfikowana.

Próba uruchomienia tych poleceń bez skonfigurowanego dodatku kończy się bezpieczną odmową.

## Zadania `launchd`

| Zadanie | Instalacja | Działanie |
|---|---|---|
| Status | zawsze, co minutę | Czyta raporty i zapisuje stan dla menu. |
| Przypomnienie | zawsze, dni robocze | Alarmuje o niepełnych raportach. |
| Menu | zawsze, po zalogowaniu | Utrzymuje aplikację w pasku menu. |
| Synchronizacja | tylko po włączeniu | Kopiuje bieżący miesiąc do drugiej Jiry. |

Wyłączenie synchronizacji zatrzymuje jej agent i usuwa jego plist. Pozostałe trzy zadania działają
dalej.

## Konfiguracja

| Zmienna | Znaczenie |
|---|---|
| `SRC_URL`, `SRC_EMAIL`, `SRC_TOKEN` | Jira główna. |
| `WORKDAY_HOURS` | Norma pełnego dnia, domyślnie `8`. |
| `REMINDER_TIME` | Godzina przypomnienia. |
| `SYNC_ENABLED` | `1` włącza, `0` wyłącza synchronizację. |
| `DST_URL`, `DST_EMAIL`, `DST_TOKEN` | Opcjonalna Jira docelowa. |
| `DST_ISSUE` | Zbiorcze zadanie docelowe. |
| `COMMENT_KEYS` | `1` dodaje klucze zadań głównych do komentarza. |
| `SYNC_TIME` | Godzina automatycznego zapisu. |
| `THIS_IS_LOGGED_ENV` | Alternatywna ścieżka konfiguracji. |

Techniczne ścieżki, etykiety `launchd` i bundle ID również używają nazwy `this-is-logged`.

## Testy

```bash
pnpm test
```

Self-check nie łączy się z Jirą. Sprawdza oba tryby konfiguracji, analizę raportów, kalendarz,
sumowanie worklogów oraz bezpieczne planowanie synchronizacji.

## Budowanie paczki macOS

Dla dewelopera wymagane są Node.js 18+, pnpm oraz Command Line Tools for Xcode:

```bash
pnpm install
pnpm package:macos
```

Gotowy obraz trafia do `dist/This Is Logged.dmg`. Zawiera aplikację, backend, zależności i własny
runtime Node, więc na komputerze użytkownika repozytorium nie jest potrzebne.

Bez `MACOS_SIGN_IDENTITY` build jest podpisany ad hoc i nadaje się do testów lokalnych. Publiczna
dystrybucja wymaga certyfikatu Developer ID Application oraz notaryzacji Apple.

## Bezpieczeństwo

- monitoring wykonuje wyłącznie żądania odczytu;
- kod celu nie jest wywoływany przy `SYNC_ENABLED=0`;
- zapis wymaga aktywnej synchronizacji i polecenia interaktywnego albo `--commit`;
- automatyzacja nigdy nie nadpisuje różnic;
- sekrety i stan mają uprawnienia `600`;
- tokeny nie są umieszczane w argumentach procesów ani logach.

## Inne systemy

Interaktywny i bezobsługowy tryb synchronizacji Node.js działa również poza macOS. Aplikacja w
pasku menu, `launchd` oraz natywne powiadomienia są przeznaczone dla macOS.
