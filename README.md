# Latata.Hub ⚡

> **A native, lightweight macOS desktop system monitor & control widget.**  
> Built with [TinyJS](https://tinyjs.app) (txiki.js QuickJS engine + native WebKit WKWebView) and an Objective-C helper sidecar. Zero Electron overhead.

---

## ✨ Features

- **Circular Status Rings**: Real-time Apple-style circular gauges for CPU, RAM, GPU, and Wi-Fi signal.
- **Battery & Peripheral Telemetry**: Live status for internal MacBook battery and connected Bluetooth accessories (AirPods, Magic Mouse, Trackpad, Keyboards).
- **Disk Capacity & Storage Analyzer**: Fast disk usage overview with safe scanning for largest directories and files.
- **Smart Cleaner**: One-click cleanup for user cache, system logs, DNS cache (`dscacheutil`), and Trash.
- **Top 10 Processes**: Ranked live CPU and RAM consumption with extracted native macOS application icons and 1-Click Process Kill.
- **Developer Localhost Port Inspector**: Real-time listing of listening TCP ports, bound services, Docker daemon status, and process termination.
- **Interactive Tooltip Engine**: Informative floating dark-glass tooltips with a quick titlebar `[ 💡 ON / OFF ]` toggle.
- **Window Management**:
  - **Always on Top (`Przypnij`)**: Pin the widget above all windows or keep it in the normal desktop layer.
  - **Compact / Expand (`Zwiń / Rozwiń`)**: Toggle between compact (356×548) and full expanded (356×760) view.
  - **Caffeinate Mode (`☕`)**: Prevent system sleep during heavy downloads or tasks with one click.
- **Privacy-First Architecture (TCC Compliant)**: Safely inspects system metrics without probing personal directories (`Desktop`, `Documents`, `Photos`).

---

## 🏗 Architecture

```
                    ┌────────────────────────┐
                    │      WebKit UI         │
                    │   (HTML5, CSS, JS)     │
                    └───────────┬────────────┘
                                │ JSON IPC
                    ┌───────────▼────────────┐
                    │     txiki.js Engine    │
                    │  (QuickJS + libuv)     │
                    └───────────┬────────────┘
                                │ High-speed IPC
                    ┌───────────▼────────────┐
                    │     macmon (Obj-C)     │
                    │ (libproc, IOKit, WLAN) │
                    └────────────────────────┘
```

1. **Frontend**: Pure HTML5, modern CSS3 (vibrancy glass, custom scrollbars, SVG animations), and vanilla JavaScript.
2. **Backend**: `src/backend/main.js` running on `txiki.js`, handling IPC dispatch, telemetry aggregation, alerts, and system tray.
3. **Native Sidecar (`macmon`)**: Objective-C binary compiled with Cocoa, IOKit, and CoreWLAN for direct kernel and hardware telemetry with sub-millisecond execution.

---

## 🚀 Getting Started

### Prerequisites

- macOS (Apple Silicon arm64 recommended).
- [TinyJS CLI](https://tinyjs.app) installed:
  ```bash
  curl -fsSL https://tinyjs.app/install | bash
  ```
- Command Line Tools for compilation (`xcode-select --install`).

### Development

To start the live development widget:
```bash
git clone https://github.com/your-username/latata-hub.git
cd latata-hub
tinyjs dev
```

### Running Tests

Latata.Hub includes a full End-to-End test suite covering native contracts, backend IPC, and frontend WebKit interactions:

```bash
# Run backend & native telemetry tests in Terminal
./test/run-e2e.sh

# Run live UI test runner inside a WebKit window
./test/run-e2e.sh --ui
```

### Building Application Bundle

To build a standalone `.app` bundle:
```bash
tinyjs build
```
The compiled application will be generated in `dist/Latata.Hub.app`.

### Compiling Native Helper

If you modify `src/native/macmon.m`, recompile the binary helper with:
```bash
npm run build:native
```

---

## 🛡 Privacy & Security

Latata.Hub is designed with strict respect for macOS Transparency, Consent, and Control (TCC):
- Application icons are only resolved for system-approved binaries located in `/Applications` or `/System`.
- Disk scanners skip protected personal folders to avoid triggering unexpected permission prompts.
- No network requests are made to third-party tracking services (all latency ping measurements query Cloudflare `1.1.1.1` strictly for ping/DNS diagnosis).

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
