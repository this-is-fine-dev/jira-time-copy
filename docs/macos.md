# This Is Logged na macOS

Ten przewodnik opisuje aplikację w pasku menu, monitoring raportów, opcjonalną synchronizację,
zadania `launchd`, powiadomienia i diagnostykę.

## Instalacja i aktualizacja

Otwórz `This Is Logged.dmg`, przeciągnij aplikację do katalogu **Applications** i uruchom ją.
Pierwszy start automatycznie pokazuje natywny konfigurator. Nie jest potrzebny Terminal, Node.js,
ani pnpm.

```text
/Applications/This Is Logged.app
```

Konfigurator zachowuje dotychczasowe wartości, sprawdza wymagane połączenia przed zapisem i
uzgadnia właściwy zestaw agentów `launchd`. Wszystkie agenty używają backendu oraz runtime Node
dołączonego do aplikacji, dlatego repozytorium może zostać usunięte po instalacji.

## Tryby

### Monitoring

Wymaga tylko Jiry głównej. Aplikacja odczytuje worklogi, liczy kompletność raportów i przypomina o
brakach. Nie łączy się z drugą Jirą i nie instaluje procesu wykonującego zapis.

### Monitoring i synchronizacja

Dodatkowo wymaga Jiry docelowej oraz zbiorczego zadania. Oprócz monitoringu porównuje dzienne sumy
i może je kopiować automatycznie lub interaktywnie.

## Pliki

Techniczne ścieżki zachowują poprzednią nazwę, aby aktualizacja nie utraciła konfiguracji i
historii.

| Element | Lokalizacja |
|---|---|
| Konfiguracja | `~/.jira-time-copy.env` |
| Aplikacja | `/Applications/This Is Logged.app` |
| Stan | `~/Library/Application Support/jira-time-copy/status.json` |
| Agenty | `~/Library/LaunchAgents/dev.this-is-fine.jira-time-copy.*.plist` |
| Logi | `~/Library/Logs/jira-time-copy*.log` |

Konfiguracja, stan i logi mają uprawnienia `600`.

## Zadania `launchd`

### Status — zawsze

`dev.this-is-fine.jira-time-copy.status` startuje po instalacji, a później co 60 sekund.

Sprawdza:

- dzisiaj;
- wczoraj;
- zakończone dni aktualnego tygodnia;
- w poniedziałek cały poprzedni tydzień;
- zakończone dni bieżącego miesiąca;
- miesięczny plan oraz sumę zaraportowaną do dzisiaj.

W trybie synchronizacji dodatkowo czyta cel i wylicza różnice. Awaria celu nie usuwa poprawnego
stanu Jiry głównej.

### Przypomnienie — zawsze

`dev.this-is-fine.jira-time-copy.reminder` działa od poniedziałku do piątku o `REMINDER_TIME`.

| Czas przy normie 8 h | Wynik |
|---:|---|
| `0.00 h` | Powiadomienie o pustym dniu. |
| `2.00 h` | Powiadomienie `2.00/8.00 h`. |
| `8.00 h` lub więcej | Brak powiadomienia. |

Komunikat wymienia również wcześniejsze niepełne dni miesiąca. Weekendy i polskie święta ustawowe
są pomijane. Urlopy wymagają osobnego kalendarza.

### Menu — zawsze

`dev.this-is-fine.jira-time-copy.menu` utrzymuje ikonę w pasku, czyta `status.json`, obsługuje
ustawienia i powiadomienia.

### Synchronizacja — opcjonalna

`dev.this-is-fine.jira-time-copy.sync` istnieje tylko przy `SYNC_ENABLED=1`. O ustawionej godzinie
kopiuje brakujące dzienne sumy bieżącego miesiąca do zadania docelowego.

Wyłączenie dodatku powoduje `bootout` agenta i usunięcie jego plista. Stary log i dane celu zostają
zachowane, ale nic ich nie uruchamia.

## Menu

Nagłówek zawsze pokazuje:

- aktualny miesiąc;
- godziny zaraportowane względem planu;
- kompletność zamkniętych dni;
- raport dzisiejszy względem dziennej normy.

Sekcja **Raporty** pozwala rozwinąć konkretny zakres i zobaczyć daty braków. W trybie jednej Jiry
nie pojawiają się żadne ostrzeżenia o niesprawdzonym celu.

Sekcja **Monitoring** pokazuje harmonogram przypomnienia i pozwala wymusić odczyt.

Sekcja **Synchronizacja** pojawia się wyłącznie po skonfigurowaniu drugiej Jiry. Zawiera:

- ostatni wynik automatycznego zapisu;
- harmonogram;
- synchronizację natychmiastową;
- tryb interaktywny dla dnia lub miesiąca;
- pięć ostatnich uruchomień.

W sekcji **Aplikacja** można otworzyć ustawienia, uruchomić kreator połączeń, zobaczyć właściwy log
i zakończyć aplikację.

## Ustawienia

Okno **Ustawienia i połączenia** obejmuje Jirę główną, godzinę przypomnienia i długość pełnego dnia.
Przełącznik synchronizacji odsłania Jirę docelową, zadanie, komentarze oraz godzinę automatycznego
zapisu. Tokeny są polami chronionymi.

Przycisk **Sprawdź i zapisz** najpierw loguje się do wymaganych instancji oraz sprawdza zadanie
docelowe. Dopiero poprawna konfiguracja zastępuje plik z sekretami i przeładowuje `launchd`.

## Powiadomienia

Tytuł powiadomień to **This Is Logged**.

Monitoring może zgłosić:

- pusty lub niepełny dzisiejszy raport;
- braki z poprzednich dni;
- błąd połączenia z Jirą główną.

Synchronizacja może dodatkowo zgłosić błąd celu lub różnice wymagające ręcznej decyzji.

Jeśli komunikat znika automatycznie:

1. otwórz **Ustawienia systemowe → Powiadomienia → This Is Logged**;
2. włącz powiadomienia;
3. wybierz styl **Stałe** zamiast **Tymczasowe**.

Kreator odczytuje faktyczne ustawienie. macOS nie pozwala aplikacji samodzielnie kliknąć tej opcji.

## Logi

| Plik | Zawartość |
|---|---|
| `jira-time-copy-status.log` | Odczyty i analiza raportów. |
| `jira-time-copy-reminder.log` | Kontrola braków i powiadomienia. |
| `jira-time-copy.log` | Wyłącznie opcjonalna synchronizacja. |
| `jira-time-copy-menu.log` | Błędy aplikacji AppKit. |

W trybie monitoringu akcja otwarcia logu prowadzi do logu statusu. Przy aktywnej synchronizacji
prowadzi do logu zapisu.

## Diagnostyka

```bash
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.menu
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.status
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.reminder
```

Agent synchronizacji powinien istnieć tylko po jej włączeniu:

```bash
launchctl print gui/$(id -u)/dev.this-is-fine.jira-time-copy.sync
```

Zadania kalendarzowe zwykle pokazują `not running` pomiędzy wykonaniami. Agent menu powinien mieć
stan `running`.

## Typowe problemy

### Menu pokazuje stare dane

Wybierz **Odśwież dane** i sprawdź `jira-time-copy-status.log`. Menu odświeża widok co 30 sekund,
a agent pobiera nowe worklogi co minutę.

### Brak drugiej Jiry jest pokazywany jako błąd

Otwórz **Ustawienia i połączenia** i wyłącz synchronizację. W tym trybie brak celu jest poprawnym
stanem.

### Synchronizacja nadal uruchamia się po wyłączeniu

Zapisz ponownie ustawienia. Aplikacja zatrzyma stary agent i usunie dokładnie
`dev.this-is-fine.jira-time-copy.sync.plist`.

### Zmieniła się wersja Node.js

Nie wymaga działania. Paczka zawiera własny runtime, a plisty nie używają Node.js zainstalowanego
w systemie.

### Powiadomienie pojawia się i znika

W ustawieniach powiadomień wybierz styl **Stałe**.

### Automatyzacja zgłasza różnicę

Nic nie zostało nadpisane. Otwórz synchronizację interaktywną i wybierz „Zsumuj”, „Pomiń” albo
„Nadpisz”.
