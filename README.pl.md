# Latata.Hub ⚡

> **Natywny, ultralekki widget monitorowania systemu i kontroli procesów dla macOS.**  
> Zbudowany na silniku [TinyJS](https://tinyjs.app) (txiki.js QuickJS + natywny WebKit WKWebView) z natywnym modułem pomocniczym w Objective-C. Całkowity brak narzutu powolnego Electrona.

---

[English Version (README.md)](README.md) • **Polski**

---

## ✨ Główne Możliwości

- **Pierścienie telemetryczne Apple**: Płynne, animowane pierścienie wskaźników obciążenia w czasie rzeczywistym dla procesora (CPU), pamięci RAM, grafiki (GPU) oraz siły sygnału Wi-Fi.
- **Baterie i akcesoria Bluetooth**: Odczyt na żywo poziomu naładowania baterii wewnętrznej MacBooka oraz podłączonych peryferiów Bluetooth (AirPods, Magic Mouse, Magic Trackpad, klawiatury bezprzewodowe).
- **Pojemność Dysku i Eksplorator pamięci masowej**: Szybki podgląd zajętości dysku SSD wraz z bezpiecznym skanerem największych folderów i plików w katalogu domowym i aplikacjach.
- **Smart Cleaner (Czyszczenie Systemu)**: Jedno kliknięcie, aby opróżnić pamięć podręczną aplikacji (cache), logi systemowe, pamięć podręczną DNS (`dscacheutil`) oraz Kosz.
- **Top 10 Procesów**: Lista procesów najbardziej obciążających CPU i RAM, zintegrowana z natywnymi ikonami aplikacji macOS oraz natychmiastowym przyciskiem zakończenia procesu (1-Click Kill).
- **Inspektor portów Localhost dla deweloperów**: Podgląd na żywo nasłuchujących portów TCP, procesów deweloperskich, stanu silnika Docker oraz możliwość zwalniania zablokowanych portów.
- **Interaktywny silnik podpowiedzi (Tooltipy)**: Pływające dymki informacyjne z ciemnego szkła z wygodnym przełącznikiem `[ 💡 ON / OFF ]` na pasku tytułowym.
- **Zarządzanie oknem widgetu**:
  - **Zawsze na wierzchu (`Przypnij`)**: Przypnij widget nad wszystkimi oknami lub trzymaj go na standardowej warstwie biurka.
  - **Dopasowany / Pełny (`Zwiń / Rozwiń`)**: Przełączaj między kompaktowym widokiem (356×548) a pełną kolumną (356×760).
  - **Tryb Caffeinate (`☕`)**: Zablokuj usypianie Maca i wygaszanie ekranu podczas pobierania, renderowania lub kompilacji.
- **Prywatność i bezpieczeństwo (TCC Compliant)**: Pełna ochrona prywatności – aplikacja nie przeszukuje prywatnych folderów użytkownika (`Biurko`, `Dokumenty`, `Zdjęcia`).

---

## 🏗 Architektura Projektu

```
                    ┌────────────────────────┐
                    │      Interfejs UI      │
                    │   (HTML5, CSS, JS)     │
                    └───────────┬────────────┘
                                │ Dwustronne IPC
                    ┌───────────▼────────────┐
                    │     Silnik txiki.js    │
                    │  (QuickJS + libuv)     │
                    └───────────┬────────────┘
                                │ Szybki potok IPC
                    ┌───────────▼────────────┐
                    │     macmon (Obj-C)     │
                    │ (libproc, IOKit, WLAN) │
                    └────────────────────────┘
```

1. **Frontend**: Czysty HTML5, nowoczesny CSS3 (efekt szklanego rozmycia macOS vibrancy hud, płynne animacje SVG) oraz JavaScript bez ciężkich frameworków.
2. **Backend**: `src/backend/main.js` działający na `txiki.js`, zarządzający agregacją danych telemetrycznych, alertami i menu w pasku menu macOS (Tray).
3. **Moduł natywny (`macmon`)**: Plik wykonywalny w Objective-C skompilowany z Cocoa, IOKit i CoreWLAN, pobierający parametry bezpośrednio z jądra macOS w czasie poniżej 1 milisekundy.

---

## 🚀 Uruchomienie i Rozwój

### Wymagania wstępne

- macOS (rekomendowany Apple Silicon M1/M2/M3/M4).
- Zainstalowane narzędzie [TinyJS CLI](https://tinyjs.app):
  ```bash
  curl -fsSL https://tinyjs.app/install | bash
  ```
- Narzędzia wiersza poleceń macOS (`xcode-select --install`).

### Uruchomienie w trybie deweloperskim

```bash
git clone https://github.com/wojtaczu/Latata-Hub.git
cd Latata-Hub
tinyjs dev
```

### Uruchamianie testów E2E

Latata.Hub posiada pełen pakiet automatycznych testów weryfikujących poprawność backendu i interfejsu WebKit:

```bash
# Testy warstwy backendowej i natywnej w terminalu
./test/run-e2e.sh

# Testy interfejsu UI na żywo w oknie WebKit (animacje i symulacje kliknięć)
./test/run-e2e.sh --ui
```

### Budowanie gotowej aplikacji (`.app`)

Aby utworzyć gotowy plik aplikacji dla macOS:
```bash
tinyjs build
```
Skompilowana aplikacja zostanie wygenerowana w katalogu `dist/Latata.Hub.app`.

### Kompilacja modułu pomocniczego `macmon`

W przypadku edycji pliku `src/native/macmon.m`, rekompilację wykonasz poleceniem:
```bash
npm run build:native
```

---

## 🛡 Prywatność i Bezpieczeństwo

Latata.Hub respektuje mechanizmy bezpieczeństwa macOS TCC:
- Ikony programów pobierane są wyłącznie z systemowych katalogów `/Applications` i `/System`.
- Skaner dysku nie odpytuje chronionych katalogów osobistych użytkownika, zapobiegając uciążliwym pytaniom systemu o dostęp.
- Aplikacja nie wysyła żadnych danych telemetrycznych na zewnętrzne serwery (pomiar pingu odpytuje wyłącznie publiczny serwer Cloudflare `1.1.1.1`).

---

## 📄 Licencja

Projekt jest udostępniany na zasadach licencji MIT — szczegóły w pliku [LICENSE](LICENSE).
