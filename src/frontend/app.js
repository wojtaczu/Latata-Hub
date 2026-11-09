const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const HISTORY_LEN = 45;
const cpuHistory = new Array(HISTORY_LEN).fill(0);
const netDownHistory = new Array(HISTORY_LEN).fill(0);
const netUpHistory = new Array(HISTORY_LEN).fill(0);

const RING_CIRCUMFERENCE = 2 * Math.PI * 22; // ~138.23

function setRing(el, percent) {
  if (!el) return;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
  el.style.strokeDashoffset = offset.toFixed(2);
}

function fmtBytes(bytes, decimals = 1) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(k)));
  const val = b / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

function fmtGB(bytes, decimals = 1) {
  const gb = (Number(bytes) || 0) / (1024 * 1024 * 1024);
  return `${gb.toFixed(decimals)} GB`;
}

function fmtSpeedParts(bytesPerSec) {
  const bps = Number(bytesPerSec) || 0;
  if (bps >= 1024 * 1024) {
    return {
      num: (bps / (1024 * 1024)).toFixed(2),
      unit: 'MB/s',
      short: `${(bps / (1024 * 1024)).toFixed(1)} MB/s`,
    };
  }
  if (bps >= 1024) {
    return {
      num: (bps / 1024).toFixed(1),
      unit: 'KB/s',
      short: `${Math.round(bps / 1024)} KB/s`,
    };
  }
  return {
    num: String(Math.round(bps)),
    unit: 'B/s',
    short: `${Math.round(bps)} B/s`,
  };
}

function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function tempClass(tempC) {
  if (!tempC || tempC <= 0) return '';
  if (tempC >= 80) return 'hot';
  if (tempC >= 62) return 'warm';
  return 'cool';
}

function applyTempEl(el, tempC, prefix = '') {
  if (!el) return;
  if (!tempC || tempC <= 0) {
    el.textContent = `${prefix}--°C`;
    el.className = 't-val';
    return;
  }
  el.textContent = `${prefix}${tempC.toFixed(1)}°C`;
  el.className = `t-val ${tempClass(tempC)}`;
}

function drawSparkline(canvas, seriesList, maxFloor = 100) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 310;
  const h = rect.height || 42;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const y = (h / 3) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  let peak = maxFloor;
  for (const s of seriesList) {
    for (const v of s.data) {
      if (v > peak) peak = v;
    }
  }
  if (peak <= 0) peak = 1;

  for (const s of seriesList) {
    const pts = s.data;
    const len = pts.length;
    if (len < 2) continue;

    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * w;
      const y = h - 3 - Math.min(1, Math.max(0, pts[i] / peak)) * (h - 7);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (s.fill) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, s.fillTop);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  ctx.restore();
}


let currentLang = localStorage.getItem('latata_lang') || 'pl';
let latestTelemetrySnap = null;

const I18N = {
  pl: {
    langToggle: '🇬🇧 EN',
    langToggleTitle: 'Przełącz język na angielski (Switch to English)',
    liveDotTitle: 'Połączono z backendem txiki.js',
    tooltipsOnTitle: 'Wskazówki (Tooltipy): Włączone (kliknij, aby wyłączyć)',
    tooltipsOffTitle: 'Wskazówki (Tooltipy): Wyłączone (kliknij, aby włączyć)',
    caffeinateOnTitle: 'Tryb Caffeinate: AKTYWNY (Mac i ekran nie zasną — kliknij, aby wyłączyć)',
    caffeinateOffTitle: 'Tryb Caffeinate: blokuj usypianie ekranu i Maca (Wył.)',
    pin: 'Przypnij',
    pinned: 'Przypięto',
    pinTitle: 'Przypnij zawsze na wierzchu (Always on Top)',
    expand: 'Rozwiń',
    collapse: 'Zwiń',
    compactTitle: 'Dopasowany rozmiar (356×548) / Pełna kolumna (356×760)',

    tabHome: '🏠 Home',
    tabHomeTitle: 'Home — podsumowanie Maca, kółka i baterie',
    tabProcs: '⚡ Procesy',
    tabProcsTitle: 'Procesy — CPU, RAM i Porty TCP',
    tabDisk: '💾 Dysk',
    tabDiskTitle: 'Dysk — pojemność, największe katalogi i pliki',
    tabCleaner: '🧹 Cleaner',
    tabCleanerTitle: 'Cleaner — czyszczenie pamięci podręcznej i śmieci',
    tabNetwork: '🌐 Sieć',
    tabNetworkTitle: 'Sieć — prędkość łącza i sygnał Wi-Fi',
    tabSensors: '🌡 Sensory',
    tabSensorsTitle: 'Sensory — temperatury, GPU i zasilanie',

    subtabCpu: '💻 Procesor CPU',
    subtabCpuTitle: 'Top 10 procesów obciążających procesor',
    subtabRam: '🧠 Pamięć RAM',
    subtabRamTitle: 'Top 10 procesów zużywających pamięć RAM',
    subtabPorts: '⇄ Porty TCP',
    subtabPortsTitle: 'Nasłuchujące porty deweloperskie i Docker',

    hudCpuJumpTitle: 'Kliknij, aby zobaczyć Top 10 procesów CPU',
    hudRamJumpTitle: 'Kliknij, aby zobaczyć Top 10 procesów RAM',
    hudGpuJumpTitle: 'Kliknij, aby zobaczyć GPU i Temperatury',
    hudWifiJumpTitle: 'Kliknij, aby zobaczyć Prędkość Internetu i Wi-Fi',
    hudBatt0JumpTitle: 'Bateria MacBooka — kliknij, aby otworzyć Bateria i Zasilanie',
    hudBtDevice: 'Urządzenie Bluetooth',
    hudBtEmpty: 'Brak kolejnego urządzenia Bluetooth z raportowaniem baterii',
    hudDiskJumpTitle: 'Pojemność Dysku SSD — kliknij, aby przejść do szczegółów',
    hudCleanerBtnTitle: 'Oczyść system ze śmieci (w stylu CCleaner / Mac Sai)',
    hudFree: 'Wolne',
    hudFrom: 'z',
    hudCleaner: 'Cleaner',

    stripDownTitle: 'Prędkość pobierania (kliknij, aby otworzyć sekcję Sieć)',
    stripUpTitle: 'Prędkość wysyłania (kliknij, aby otworzyć sekcję Sieć)',
    stripPingTitle: 'Opóźnienie sieci Ping (kliknij, aby otworzyć sekcję Sieć)',
    stripBattTitle: 'Stan baterii (kliknij, aby otworzyć sensory)',
    stripDiskTitle: 'Pojemność dysku SSD/HDD i System Cleaner (kliknij, aby otworzyć)',
    stripPortsTitle: 'Aktywne porty TCP Localhost / Dev (kliknij, aby otworzyć Port Inspector)',

    glanceMac: 'Mac:',
    glanceUptime: 'Uptime:',
    glanceNet: 'Sieć:',
    glanceTooltips: 'Tooltipy:',
    glanceTooltipsTitle: 'Wskazówki (Tooltipy) — kliknij, aby włączyć lub wyłączyć',
    chipThermalTitle: 'Sensory termiczne i temperatury — kliknij, aby otworzyć',
    chipThermalName: '🌡 Termika SoC',
    chipThermalOk: 'W normie',
    chipThermalWarm: 'Podwyższona',
    chipThermalHot: 'Wysoka temp.',
    chipBattTitle: 'Diagnostyka baterii i zasilanie — kliknij, aby otworzyć',
    chipBattName: '🔋 Bateria',
    chipBattHealth: 'Kondycja',
    chipBattCharging: 'Ładowanie ⚡',
    chipNetTitle: 'Parametry łącza i opóźnienie — kliknij, aby otworzyć',
    chipNetName: '⚡ Ping / Łącze',
    pillLoadTitle: 'Poziom obciążenia systemu (Load Average 1m / 5m)',
    pillSwapTitle: 'Użycie pliku wymiany Swap',
    pillDockerTitle: 'Status środowiska deweloperskiego Docker',
    dockerOn: 'Aktywny',
    dockerOff: 'Wył.',
    homeCleanRamBtn: '🧹 Odśwież RAM i DNS',
    homeCleanRamTitle: 'Odświeżenie pamięci podręcznej DNS (dscacheutil) i aktualizacja stanu pamięci RAM',
    homeProcsBtn: '⚡ Procesy',
    homeCleanerBtn: '🔍 Smart Cleaner',

    portsTitle: 'Porty Localhost & Dev',
    portsHeaderLabel: (n) => `Nasłuchujące porty TCP (${n})`,
    portsCols: 'Adres • RAM • Kill',
    portsEmpty: 'Brak aktywnych nasłuchujących portów TCP',
    killPortTitle: (name, pid, port) => `Zwolnij port :${port} — zakończ ${name} (PID ${pid})`,

    cpuTitle: 'Procesor (CPU) — Top 10',
    cpuHeaderLabel: 'Top 10 procesów (CPU)',
    cpuCols: 'RAM • % CPU',
    cpuCoresTitle: 'Rdzenie (Efficiency E + Performance P)',
    killProcTitle: (name, pid) => `Zakończ proces ${name} (PID ${pid}) • Kliknij z ⌥ Option aby wymusić (kill -9)`,

    ramTitle: 'Pamięć RAM — Top 10',
    ramHeaderLabel: 'Top 10 procesów (Pamięć RAM)',
    ramCols: 'Udział • Zużycie',
    ramPressureNorm: 'Ciśnienie: Niskie',
    ramPressureMed: 'Ciśnienie: Średnie',
    ramPressureCrit: 'Ciśnienie: Kryt.',
    ramFree: 'Wolne',
    ramCache: 'Cache',
    ramUsage: 'Zużycie',
    ramSwap: 'Swap',
    ramLegendApp: 'App:',
    ramLegendSys: 'Sys:',
    ramLegendComp: 'Komp:',
    ramCleanStatusDefault: 'Optymalizacja pamięci podręcznej i DNS',
    ramCleanBtn: '🧹 Wyczyść RAM i DNS',
    ramCleanBtnTitle: 'Opróżnij pamięć podręczną DNS (dscacheutil) i odśwież bufory RAM',
    ramCleanRunning: 'Odświeżanie...',
    ramCleanDone: (free) => `Odświeżono DNS! Wolny RAM: ${free}`,
    ramCleanError: 'Błąd podczas odświeżania DNS',

    netTitle: 'Prędkość Internetu',
    netDownLabel: 'POBIERANIE',
    netUpLabel: 'WYSYŁANIE',
    netLegendDown: 'Pobieranie',
    netLegendUp: 'Wysyłanie',
    speedtestReady: 'Speedtest Cloudflare gotowy',
    speedtestBtn: 'Testuj łącze',
    speedtestRunning: 'Test...',
    speedtestMeasuringPing: 'Pomiar opóźnienia HTTP (Ping)...',
    speedtestDownloading: (mbps) => `Pobieranie próbki testowej: ${mbps} Mbps...`,
    speedtestDoneResult: (mbps, mBps, lat) => `Wynik: ${mbps} Mbps (${mBps} MB/s) • Ping ${lat} ms`,
    speedtestError: (err) => `Błąd testu prędkości: ${err}`,

    wifiTitle: 'Siła sygnału Wi-Fi',
    wifiQuality: 'Jakość',
    wifiQuality_none: 'Brak sygnału',
    wifiQuality_excellent: 'Doskonała',
    wifiQuality_very_good: 'Bardzo dobra',
    wifiQuality_good: 'Dobra',
    wifiQuality_fair: 'Średnia',
    wifiQuality_poor: 'Słaba',
    wifiInterface: 'Interfejs',
    killFailed: 'Błąd zakończenia procesu',
    wifiBand: 'Pasmo',
    wifiChannel: 'Kanał',
    wifiSignal: 'Sygnał (RSSI)',
    wifiNoise: 'Szum (Noise)',
    wifiSnr: 'Odstęp SNR',
    wifiNone: 'Brak sieci',

    gpuTitle: 'GPU i Temperatury',
    thermalOk: 'Termika: OK',
    thermalWarm: 'Termika: Ciepło',
    thermalHot: 'Termika: Gorąco',
    vramUsed: 'VRAM',
    vramAlloc: 'Alokacja',
    tempCpuAvg: 'CPU Średnia',
    tempCoresPE: 'Rdzenie P/E',
    tempGpu: 'Grafika GPU',
    tempSoc: 'SoC Max Die',
    tempSsd: 'Dysk SSD',
    tempBatt: 'Bateria',

    battTitle: 'Bateria i Zasilanie',
    battCharging: (w) => `Ładowanie ⚡ (${w}W)`,
    battAdapter: 'Zasilacz 🔌',
    battOnBattery: 'Na baterii 🔋',
    battHealth: 'Kondycja',
    battCycles: 'Cykle',
    battPowerLoad: 'Pobór mocy',
    battPowerIn: 'Wejście USB-C',
    battVoltAmp: 'Napięcie/Prąd',
    battBtHeader: (n) => `Baterie Bluetooth (${n})`,
    battBtCols: 'Poziom naładowania',
    battBtEmpty: 'Brak połączonych akcesoriów Bluetooth z baterią',
    battCalculating: 'Obliczanie czasu...',
    battToFull: 'do pełnego',
    battRemaining: 'pozostało',
    battChargingCell: 'Ładowanie ogniwa',
    battMainsPower: 'Zasilanie sieciowe',
    battDischarging: 'Praca na baterii',
    btCharging: '⚡ Ładowanie',
    btHeadset: 'Słuchawka BT (HFP)',
    btConnected: 'Połączono',

    diskTitle: (name) => `Dysk (${name}) & Pojemność`,
    diskOccupied: 'zajęte',
    diskFreeSuffix: 'GB wolne',
    diskOccupiedLabel: 'Zajęte',
    diskPurgeableBuf: 'Bufory APFS',
    diskTemp: 'Temp. SSD',
    diskUptime: 'Uptime',
    diskSysVolume: 'Dysk systemowy',
    diskExtVolume: (m) => `Dysk zewn. (${m})`,
    diskFreeVolume: 'wolne',
    diskUsageTitle: 'Największe katalogi i pliki',
    diskScopeHome: '🏠 Domowy (~)',
    diskScopeApps: '🚀 Aplikacje',
    diskScopeDownloads: '📥 Pobrane',
    diskScopeDesktop: '🖥 Biurko',
    diskDirsHeader: (n) => `📁 Największe katalogi (${n})`,
    diskDirsCols: 'Kliknij = wejdź • Rozmiar',
    diskFilesHeader: (n) => `📄 Największe pliki (${n})`,
    diskFilesCols: 'Lokalizacja • Rozmiar',
    diskDirsEmpty: 'Brak podkatalogów w tej lokalizacji',
    diskFilesEmpty: 'Brak dużych plików w tej lokalizacji',
    diskScanning: 'Skanowanie...',
    diskScanError: 'Błąd skanowania',
    revealInFinder: 'Pokaż w Finderze',

    cleanerTitle: '🧹 Czyszczenie Systemu (Smart Cleaner)',
    cleanerScanning: 'Skanowanie...',
    cleanerToRecover: (bytes) => `Do odzyskania: ${bytes}`,
    cleanerPrompt: 'Zaznacz kategorie śmieci do usunięcia',
    cleanerScanBtn: '🔍 Skanuj',
    cleanerCleanBtn: '🧹 Wyczyść',
    cleanerCleanBtnBytes: (b) => `🧹 Wyczyść (${b})`,
    cleanerScanningProgress: 'Skanowanie katalogów Cache, Logów, Kosza i Dev...',
    cleanerScanFinished: (b) => `Skan zakończony: wykryto ${b} śmieci`,
    cleanerScanError: 'Błąd podczas skanowania plików tymczasowych',
    cleanerSelectWarning: 'Zaznacz przynajmniej jedną kategorię do wyczyszczenia!',
    cleanerConfirmBtn: '⚠️ Potwierdź usunięcie',
    cleanerConfirmBoth: 'Wybrano opróżnienie Kosza i pliki tymczasowe. Kliknij ponownie, aby potwierdzić.',
    cleanerConfirmTrash: 'Wybrano opróżnienie Kosza! Kliknij ponownie, aby potwierdzić.',
    cleanerConfirmTemp: 'Wybrano pliki tymczasowe (/tmp). Kliknij ponownie, aby potwierdzić.',
    cleanerTrashConfirm: 'Opróżnienie Kosza trwale usunie wszystkie pliki z folderu ~/.Trash.\n\nCzy na pewno chcesz kontynuować?',
    cleanerCleaning: 'Czyszczenie...',
    cleanerCleaningProgress: 'Usuwanie zaznaczonych śmieci i czyszczenie DNS...',
    cleanerSuccess: (freed, items) => `✅ Oczyszczono ${freed} (${items} elementów)!`,
    cleanerSuccessNoBytes: (items) => `✅ Wyczyszczono (${items} elementów + cache DNS)!`,
    cleanerError: 'Błąd podczas czyszczenia wybranych kategorii',
    cleanerDnsDesc: 'Szybkie czyszczenie pamięci podręcznej DNS i buforów',

    catCachesTitle: 'Pamięć podręczna aplikacji',
    catCachesSub: '~/Library/Caches (bufory aplikacji)',
    catDevTitle: 'Cache deweloperski i pakietów',
    catDevSub: 'npm, pip, Homebrew, Xcode DerivedData',
    catLogsTitle: 'Logi i raporty błędów',
    catLogsSub: '~/Library/Logs & CrashReporter',
    catTrashTitle: 'Kosz systemowy',
    catTrashSub: (count) => count > 0 ? `~/.Trash (${count} elementów)` : '~/.Trash (Kosz jest pusty)',
    catTempTitle: 'Pliki tymczasowe i Cache DNS',
    catTempSub: 'Pliki tymczasowe macOS + dscacheutil DNS',
  },
  en: {
    langToggle: '🇵🇱 PL',
    langToggleTitle: 'Switch language to Polish (Przełącz na polski)',
    liveDotTitle: 'Connected to txiki.js backend',
    tooltipsOnTitle: 'Tips & Tooltips: ON (click to disable)',
    tooltipsOffTitle: 'Tips & Tooltips: OFF (click to enable)',
    caffeinateOnTitle: 'Caffeinate Mode: ACTIVE (Mac & screen won\'t sleep — click to disable)',
    caffeinateOffTitle: 'Caffeinate Mode: prevent Mac & screen sleep (Off)',
    pin: 'Pin',
    pinned: 'Pinned',
    pinTitle: 'Keep Always on Top',
    expand: 'Expand',
    collapse: 'Collapse',
    compactTitle: 'Compact widget (356×548) / Full column (356×760)',

    tabHome: '🏠 Home',
    tabHomeTitle: 'Home — Mac overview, status rings & batteries',
    tabProcs: '⚡ Processes',
    tabProcsTitle: 'Processes — CPU, RAM & TCP Ports',
    tabDisk: '💾 Disk',
    tabDiskTitle: 'Disk — capacity, largest folders & files',
    tabCleaner: '🧹 Cleaner',
    tabCleanerTitle: 'Cleaner — cache & system junk removal',
    tabNetwork: '🌐 Network',
    tabNetworkTitle: 'Network — speed & Wi-Fi signal metrics',
    tabSensors: '🌡 Sensors',
    tabSensorsTitle: 'Sensors — thermals, GPU & power telemetry',

    subtabCpu: '💻 CPU Processor',
    subtabCpuTitle: 'Top 10 processes consuming CPU',
    subtabRam: '🧠 RAM Memory',
    subtabRamTitle: 'Top 10 processes consuming RAM memory',
    subtabPorts: '⇄ TCP Ports',
    subtabPortsTitle: 'Listening developer ports & Docker containers',

    hudCpuJumpTitle: 'Click to inspect Top 10 CPU processes',
    hudRamJumpTitle: 'Click to inspect Top 10 RAM processes',
    hudGpuJumpTitle: 'Click to inspect GPU & Thermals',
    hudWifiJumpTitle: 'Click to inspect Network Speed & Wi-Fi',
    hudBatt0JumpTitle: 'MacBook Battery — click to open Battery & Power',
    hudBtDevice: 'Bluetooth Device',
    hudBtEmpty: 'No additional Bluetooth device reporting battery',
    hudDiskJumpTitle: 'SSD Storage Capacity — click for details',
    hudCleanerBtnTitle: 'Clean system junk (CCleaner / Mac Sai style)',
    hudFree: 'Free',
    hudFrom: 'of',
    hudCleaner: 'Cleaner',

    stripDownTitle: 'Download speed (click to open Network section)',
    stripUpTitle: 'Upload speed (click to open Network section)',
    stripPingTitle: 'Network Ping latency (click to open Network section)',
    stripBattTitle: 'Battery level (click to open Sensors)',
    stripDiskTitle: 'SSD/HDD Storage & System Cleaner (click to open)',
    stripPortsTitle: 'Active Localhost / Dev TCP ports (click to open Port Inspector)',

    glanceMac: 'Mac:',
    glanceUptime: 'Uptime:',
    glanceNet: 'Net:',
    glanceTooltips: 'Tooltips:',
    glanceTooltipsTitle: 'Tips & Tooltips — click to toggle ON/OFF',
    chipThermalTitle: 'Thermal sensors & temperatures — click to inspect',
    chipThermalName: '🌡 SoC Thermals',
    chipThermalOk: 'Nominal',
    chipThermalWarm: 'Warm',
    chipThermalHot: 'High temp',
    chipBattTitle: 'Battery health & power telemetry — click to inspect',
    chipBattName: '🔋 Battery',
    chipBattHealth: 'Health',
    chipBattCharging: 'Charging ⚡',
    chipNetTitle: 'Link latency & throughput — click to inspect',
    chipNetName: '⚡ Ping / Link',
    pillLoadTitle: 'System Load Average (1m / 5m)',
    pillSwapTitle: 'Swap file memory usage',
    pillDockerTitle: 'Docker development environment status',
    dockerOn: 'Active',
    dockerOff: 'Off',
    homeCleanRamBtn: '🧹 Flush RAM & DNS',
    homeCleanRamTitle: 'Flush DNS cache (dscacheutil) and update RAM buffers',
    homeProcsBtn: '⚡ Processes',
    homeCleanerBtn: '🔍 Smart Cleaner',

    portsTitle: 'Localhost & Dev Ports',
    portsHeaderLabel: (n) => `Listening TCP Ports (${n})`,
    portsCols: 'Address • RAM • Kill',
    portsEmpty: 'No active listening TCP ports',
    killPortTitle: (name, pid, port) => `Release port :${port} — terminate ${name} (PID ${pid})`,

    cpuTitle: 'Processor (CPU) — Top 10',
    cpuHeaderLabel: 'Top 10 Processes (CPU)',
    cpuCols: 'RAM • % CPU',
    cpuCoresTitle: 'Cores (Efficiency E + Performance P)',
    killProcTitle: (name, pid) => `Terminate ${name} (PID ${pid}) • ⌥ Option-click to force kill (kill -9)`,

    ramTitle: 'RAM Memory — Top 10',
    ramHeaderLabel: 'Top 10 Processes (RAM Memory)',
    ramCols: 'Share • Memory',
    ramPressureNorm: 'Pressure: Low',
    ramPressureMed: 'Pressure: Medium',
    ramPressureCrit: 'Pressure: Crit.',
    ramFree: 'Free',
    ramCache: 'Cache',
    ramUsage: 'Usage',
    ramSwap: 'Swap',
    ramLegendApp: 'App:',
    ramLegendSys: 'Sys:',
    ramLegendComp: 'Comp:',
    ramCleanStatusDefault: 'Cache optimization & DNS cache flush',
    ramCleanBtn: '🧹 Flush RAM & DNS',
    ramCleanBtnTitle: 'Flush DNS cache (dscacheutil) and refresh RAM buffers',
    ramCleanRunning: 'Flushing...',
    ramCleanDone: (free) => `DNS flushed! Free RAM: ${free}`,
    ramCleanError: 'Error flushing DNS cache',

    netTitle: 'Internet Speed',
    netDownLabel: 'DOWNLOAD',
    netUpLabel: 'UPLOAD',
    netLegendDown: 'Download',
    netLegendUp: 'Upload',
    speedtestReady: 'Cloudflare Speedtest ready',
    speedtestBtn: 'Run Speedtest',
    speedtestRunning: 'Testing...',
    speedtestMeasuringPing: 'Measuring HTTP latency (Ping)...',
    speedtestDownloading: (mbps) => `Downloading test sample: ${mbps} Mbps...`,
    speedtestDoneResult: (mbps, mBps, lat) => `Result: ${mbps} Mbps (${mBps} MB/s) • Ping ${lat} ms`,
    speedtestError: (err) => `Speedtest error: ${err}`,

    wifiTitle: 'Wi-Fi Signal Strength',
    wifiQuality: 'Quality',
    wifiQuality_none: 'No Signal',
    wifiQuality_excellent: 'Excellent',
    wifiQuality_very_good: 'Very Good',
    wifiQuality_good: 'Good',
    wifiQuality_fair: 'Fair',
    wifiQuality_poor: 'Poor',
    wifiInterface: 'Interface',
    killFailed: 'Failed to terminate process',
    wifiBand: 'Band',
    wifiChannel: 'Channel',
    wifiSignal: 'Signal (RSSI)',
    wifiNoise: 'Noise',
    wifiSnr: 'SNR Margin',
    wifiNone: 'No network',

    gpuTitle: 'GPU & Temperatures',
    thermalOk: 'Thermals: OK',
    thermalWarm: 'Thermals: Warm',
    thermalHot: 'Thermals: Hot',
    vramUsed: 'VRAM',
    vramAlloc: 'Allocated',
    tempCpuAvg: 'CPU Avg',
    tempCoresPE: 'P/E Cores',
    tempGpu: 'GPU Graphics',
    tempSoc: 'SoC Max Die',
    tempSsd: 'SSD Drive',
    tempBatt: 'Battery',

    battTitle: 'Battery & Power',
    battCharging: (w) => `Charging ⚡ (${w}W)`,
    battAdapter: 'AC Adapter 🔌',
    battOnBattery: 'On Battery 🔋',
    battHealth: 'Health',
    battCycles: 'Cycles',
    battPowerLoad: 'Power Draw',
    battPowerIn: 'USB-C Input',
    battVoltAmp: 'Voltage/Current',
    battBtHeader: (n) => `Bluetooth Batteries (${n})`,
    battBtCols: 'Battery Level',
    battBtEmpty: 'No connected Bluetooth accessories with battery reporting',
    battCalculating: 'Calculating time...',
    battToFull: 'to full',
    battRemaining: 'remaining',
    battChargingCell: 'Charging battery',
    battMainsPower: 'AC connected',
    battDischarging: 'On battery power',
    btCharging: '⚡ Charging',
    btHeadset: 'BT Headset (HFP)',
    btConnected: 'Connected',

    diskTitle: (name) => `Disk (${name}) & Capacity`,
    diskOccupied: 'used',
    diskFreeSuffix: 'GB free',
    diskOccupiedLabel: 'Used',
    diskPurgeableBuf: 'APFS buffers',
    diskTemp: 'SSD Temp.',
    diskUptime: 'Uptime',
    diskSysVolume: 'System Volume',
    diskExtVolume: (m) => `Ext. Drive (${m})`,
    diskFreeVolume: 'free',
    diskUsageTitle: 'Largest Folders & Files',
    diskScopeHome: '🏠 Home (~)',
    diskScopeApps: '🚀 Applications',
    diskScopeDownloads: '📥 Downloads',
    diskScopeDesktop: '🖥 Desktop',
    diskDirsHeader: (n) => `📁 Largest Folders (${n})`,
    diskDirsCols: 'Click = explore • Size',
    diskFilesHeader: (n) => `📄 Largest Files (${n})`,
    diskFilesCols: 'Location • Size',
    diskDirsEmpty: 'No subfolders in this location',
    diskFilesEmpty: 'No large files in this location',
    diskScanning: 'Scanning...',
    diskScanError: 'Scan error',
    revealInFinder: 'Reveal in Finder',

    cleanerTitle: '🧹 System Cleanup (Smart Cleaner)',
    cleanerScanning: 'Scanning...',
    cleanerToRecover: (bytes) => `Reclaimable: ${bytes}`,
    cleanerPrompt: 'Select junk categories to clean',
    cleanerScanBtn: '🔍 Scan',
    cleanerCleanBtn: '🧹 Clean',
    cleanerCleanBtnBytes: (b) => `🧹 Clean (${b})`,
    cleanerScanningProgress: 'Scanning Caches, Logs, Trash and Dev folders...',
    cleanerScanFinished: (b) => `Scan completed: found ${b} junk`,
    cleanerScanError: 'Error scanning temporary files',
    cleanerSelectWarning: 'Select at least one category to clean!',
    cleanerConfirmBtn: '⚠️ Confirm Deletion',
    cleanerConfirmBoth: 'Trash and temporary files selected. Click again to confirm deletion.',
    cleanerConfirmTrash: 'Empty Trash selected! Click again to confirm permanent deletion.',
    cleanerConfirmTemp: 'Temporary files (/tmp) selected. Click again to confirm.',
    cleanerTrashConfirm: 'Emptying the Trash permanently deletes all files in ~/.Trash.\n\nAre you sure you want to proceed?',
    cleanerCleaning: 'Cleaning...',
    cleanerCleaningProgress: 'Removing selected junk files & flushing DNS...',
    cleanerSuccess: (freed, items) => `✅ Cleaned ${freed} (${items} items)!`,
    cleanerSuccessNoBytes: (items) => `✅ Cleaned (${items} items + DNS cache)!`,
    cleanerError: 'Error cleaning selected categories',
    cleanerDnsDesc: 'Quick DNS cache flush & buffer release',

    catCachesTitle: 'App Caches',
    catCachesSub: '~/Library/Caches (application buffers)',
    catDevTitle: 'Developer & Package Cache',
    catDevSub: 'npm, pip, Homebrew, Xcode DerivedData',
    catLogsTitle: 'Logs & Crash Reports',
    catLogsSub: '~/Library/Logs & CrashReporter',
    catTrashTitle: 'User Trash',
    catTrashSub: (count) => count > 0 ? `~/.Trash (${count} items)` : '~/.Trash (Trash is empty)',
    catTempTitle: 'Temporary Files & DNS Cache',
    catTempSub: 'macOS temporary buffers + dscacheutil DNS',
  }
};

function t(key, ...args) {
  const dict = I18N[currentLang] || I18N.pl;
  const val = dict[key] ?? I18N.pl[key] ?? key;
  if (typeof val === 'function') {
    return val(...args);
  }
  return val;
}

function setLanguage(lang) {
  currentLang = lang === 'en' ? 'en' : 'pl';
  localStorage.setItem('latata_lang', currentLang);
  document.documentElement.lang = currentLang;

  const btnLang = $('btnToggleLang');
  if (btnLang) {
    btnLang.textContent = t('langToggle');
    btnLang.title = t('langToggleTitle');
  }

  if ($('liveDot')) $('liveDot').title = t('liveDotTitle');
  if ($('btnPin')) $('btnPin').title = t('pinTitle');
  if ($('btnCompact')) $('btnCompact').title = t('compactTitle');

  const isPinned = $('btnPin')?.classList.contains('active');
  if ($('layerLabel') && typeof isPinned === 'boolean') {
    $('layerLabel').textContent = isPinned ? t('pinned') : t('pin');
  }
  const isCompact = $('appShell')?.classList.contains('compact-mode');
  if ($('compactLabel') && typeof isCompact === 'boolean') {
    $('compactLabel').textContent = isCompact ? t('expand') : t('collapse');
  }
  updateTooltipsToggleUI();

  const tabDashboard = document.querySelector('.nav-tab[data-tab="dashboard"]');
  if (tabDashboard) { tabDashboard.textContent = t('tabHome'); tabDashboard.title = t('tabHomeTitle'); }
  const tabProcs = document.querySelector('.nav-tab[data-tab="procs"]');
  if (tabProcs) { tabProcs.textContent = t('tabProcs'); tabProcs.title = t('tabProcsTitle'); }
  const tabDisk = document.querySelector('.nav-tab[data-tab="disk"]');
  if (tabDisk) { tabDisk.textContent = t('tabDisk'); tabDisk.title = t('tabDiskTitle'); }
  const tabCleaner = document.querySelector('.nav-tab[data-tab="cleaner"]');
  if (tabCleaner) { tabCleaner.textContent = t('tabCleaner'); tabCleaner.title = t('tabCleanerTitle'); }
  const tabNetwork = document.querySelector('.nav-tab[data-tab="network"]');
  if (tabNetwork) { tabNetwork.textContent = t('tabNetwork'); tabNetwork.title = t('tabNetworkTitle'); }
  const tabSensors = document.querySelector('.nav-tab[data-tab="sensors"]');
  if (tabSensors) { tabSensors.textContent = t('tabSensors'); tabSensors.title = t('tabSensorsTitle'); }

  const subCpu = $('subtabCpu');
  if (subCpu) { subCpu.textContent = t('subtabCpu'); subCpu.title = t('subtabCpuTitle'); }
  const subRam = $('subtabRam');
  if (subRam) { subRam.textContent = t('subtabRam'); subRam.title = t('subtabRamTitle'); }
  const subPorts = $('subtabPorts');
  if (subPorts) {
    const pCount = $('procsPortsCount')?.textContent || '0';
    subPorts.innerHTML = `${t('subtabPorts')} (<span id="procsPortsCount">${pCount}</span>)`;
    subPorts.title = t('subtabPortsTitle');
  }

  const hudCpu = document.querySelector('#miniHudSystem .hud-tile[data-jump="top-cpu"]');
  if (hudCpu) hudCpu.title = t('hudCpuJumpTitle');
  const hudRam = document.querySelector('#miniHudSystem .hud-tile[data-jump="top-ram"]');
  if (hudRam) hudRam.title = t('hudRamJumpTitle');
  const hudGpu = document.querySelector('#miniHudSystem .hud-tile[data-jump="power"]');
  if (hudGpu) hudGpu.title = t('hudGpuJumpTitle');
  const hudWifi = document.querySelector('#miniHudSystem .hud-tile[data-jump="network"]');
  if (hudWifi) hudWifi.title = t('hudWifiJumpTitle');
  const hudBatt0 = $('btSlot0');
  if (hudBatt0) hudBatt0.title = t('hudBatt0JumpTitle');
  const diskHudBar = $('diskHudBar');
  if (diskHudBar) diskHudBar.title = t('hudDiskJumpTitle');
  const btnHudCleaner = $('btnHudCleaner');
  if (btnHudCleaner) btnHudCleaner.title = t('hudCleanerBtnTitle');

  const stripItems = document.querySelectorAll('.mini-strip-item');
  if (stripItems[0]) stripItems[0].title = t('stripDownTitle');
  if (stripItems[1]) stripItems[1].title = t('stripUpTitle');
  if (stripItems[2]) stripItems[2].title = t('stripPingTitle');
  if (stripItems[3]) stripItems[3].title = t('stripBattTitle');
  const stripDisk = $('stripDiskItem');
  if (stripDisk) stripDisk.title = t('stripDiskTitle');
  const stripPorts = $('stripPortsItem');
  if (stripPorts) stripPorts.title = t('stripPortsTitle');

  const glanceLabels = document.querySelectorAll('.home-meta-bar .meta-label');
  if (glanceLabels[0]) glanceLabels[0].textContent = t('glanceMac');
  if (glanceLabels[1]) glanceLabels[1].textContent = t('glanceUptime');
  if (glanceLabels[2]) glanceLabels[2].textContent = t('glanceNet');
  if (glanceLabels[3]) glanceLabels[3].textContent = t('glanceTooltips');
  const btnHomeTips = $('btnHomeToggleTooltips');
  if (btnHomeTips) btnHomeTips.title = t('glanceTooltipsTitle');

  const chips = document.querySelectorAll('.home-chips-grid .home-chip');
  if (chips[0]) {
    chips[0].title = t('chipThermalTitle');
    const ct = chips[0].querySelector('.chip-title');
    if (ct) ct.textContent = t('chipThermalName');
  }
  if (chips[1]) {
    chips[1].title = t('chipBattTitle');
    const ct = chips[1].querySelector('.chip-title');
    if (ct) ct.textContent = t('chipBattName');
  }
  if (chips[2]) {
    chips[2].title = t('chipNetTitle');
    const ct = chips[2].querySelector('.chip-title');
    if (ct) ct.textContent = t('chipNetName');
  }

  const sysPills = document.querySelectorAll('.home-system-status-row .home-sys-pill');
  if (sysPills[0]) sysPills[0].title = t('pillLoadTitle');
  if (sysPills[1]) sysPills[1].title = t('pillSwapTitle');
  if (sysPills[2]) sysPills[2].title = t('pillDockerTitle');

  const btnHomeClean = $('btnHomeCleanRam');
  if (btnHomeClean) {
    btnHomeClean.title = t('homeCleanRamTitle');
    const lbl = $('homeCleanRamLabel');
    if (lbl) lbl.textContent = t('homeCleanRamBtn');
  }
  const btnHomeP = $('btnHomeProcs');
  if (btnHomeP) btnHomeP.textContent = t('homeProcsBtn');
  const btnHomeC = $('btnHomeCleaner');
  if (btnHomeC) btnHomeC.textContent = t('homeCleanerBtn');

  const secPortsH2 = document.querySelector('#sec-ports h2');
  if (secPortsH2) secPortsH2.textContent = t('portsTitle');
  const portsCols = document.querySelector('.ports-block .top-procs-cols');
  if (portsCols) portsCols.textContent = t('portsCols');

  const secCpuH2 = document.querySelector('#sec-cpu h2');
  if (secCpuH2) secCpuH2.textContent = t('cpuTitle');
  const cpuProcHeader = document.querySelector('#sec-cpu .top-procs-header span:first-child');
  if (cpuProcHeader) cpuProcHeader.textContent = t('cpuHeaderLabel');
  const cpuCols = document.querySelector('#sec-cpu .top-procs-cols');
  if (cpuCols) cpuCols.textContent = t('cpuCols');
  const coresTitle = document.querySelector('.cores-section-title');
  if (coresTitle) coresTitle.textContent = t('cpuCoresTitle');

  const secRamH2 = document.querySelector('#sec-ram h2');
  if (secRamH2) secRamH2.textContent = t('ramTitle');
  const ramProcHeader = document.querySelector('#sec-ram .top-procs-header span:first-child');
  if (ramProcHeader) ramProcHeader.textContent = t('ramHeaderLabel');
  const ramCols = document.querySelector('#sec-ram .top-procs-cols');
  if (ramCols) ramCols.textContent = t('ramCols');
  const btnCleanRam = $('btnCleanRam');
  if (btnCleanRam) {
    btnCleanRam.textContent = t('ramCleanBtn');
    btnCleanRam.title = t('ramCleanBtnTitle');
  }
  const ramCleanStatus = $('ramCleanStatus');
  if (ramCleanStatus) ramCleanStatus.textContent = t('ramCleanStatusDefault');

  const secNetH2 = document.querySelector('#sec-net h2');
  if (secNetH2) secNetH2.textContent = t('netTitle');
  const downLabel = document.querySelector('.down-box .net-dir-label');
  if (downLabel) downLabel.innerHTML = `<span class="arrow-down">↓</span> ${t('netDownLabel')}`;
  const upLabel = document.querySelector('.up-box .net-dir-label');
  if (upLabel) upLabel.innerHTML = `<span class="arrow-up">↑</span> ${t('netUpLabel')}`;
  const netLegend = document.querySelectorAll('.sparkline-legend span');
  if (netLegend[0]) netLegend[0].innerHTML = `<i class="leg-dot bg-emerald"></i> ${t('netLegendDown')}`;
  if (netLegend[1]) netLegend[1].innerHTML = `<i class="leg-dot bg-sky"></i> ${t('netLegendUp')}`;
  const btnSpeedtest = $('btnSpeedtest');
  if (btnSpeedtest) btnSpeedtest.textContent = t('speedtestBtn');
  const speedtestStatus = $('speedtestStatus');
  if (speedtestStatus) speedtestStatus.textContent = t('speedtestReady');

  const secWifiH2 = document.querySelector('#sec-wifi h2');
  if (secWifiH2) secWifiH2.textContent = t('wifiTitle');
  const miniStats = document.querySelectorAll('#sec-wifi .mini-stat .m-label');
  if (miniStats[0]) miniStats[0].textContent = t('wifiSignal');
  if (miniStats[1]) miniStats[1].textContent = t('wifiNoise');
  if (miniStats[2]) miniStats[2].textContent = t('wifiSnr');

  const secGpuH2 = document.querySelector('#sec-gpu h2');
  if (secGpuH2) secGpuH2.textContent = t('gpuTitle');
  const gpuMetaPairs = document.querySelectorAll('#sec-gpu .meta-pair span');
  if (gpuMetaPairs[0]) gpuMetaPairs[0].textContent = t('vramUsed');
  if (gpuMetaPairs[1]) gpuMetaPairs[1].textContent = t('vramAlloc');
  const tempChips = document.querySelectorAll('.temps-grid .temp-chip .t-name');
  if (tempChips[0]) tempChips[0].textContent = t('tempCpuAvg');
  if (tempChips[1]) tempChips[1].textContent = t('tempCoresPE');
  if (tempChips[2]) tempChips[2].textContent = t('tempGpu');
  if (tempChips[3]) tempChips[3].textContent = t('tempSoc');
  if (tempChips[4]) tempChips[4].textContent = t('tempSsd');
  if (tempChips[5]) tempChips[5].textContent = t('tempBatt');

  const secBattH2 = document.querySelector('#sec-battery h2');
  if (secBattH2) secBattH2.textContent = t('battTitle');
  const battMetaPairs = document.querySelectorAll('#sec-battery .meta-pair span');
  if (battMetaPairs[0]) battMetaPairs[0].textContent = t('battHealth');
  if (battMetaPairs[1]) battMetaPairs[1].textContent = t('battCycles');
  const battMiniStats = document.querySelectorAll('#sec-battery .mini-stat .m-label');
  if (battMiniStats[0]) battMiniStats[0].textContent = t('battPowerLoad');
  if (battMiniStats[1]) battMiniStats[1].textContent = t('battPowerIn');
  if (battMiniStats[2]) battMiniStats[2].textContent = t('battVoltAmp');
  const btCols = document.querySelector('#btDevicesBlock .top-procs-cols');
  if (btCols) btCols.textContent = t('battBtCols');

  const diskUsageH2 = document.querySelector('#diskUsageBlock h2');
  if (diskUsageH2) diskUsageH2.textContent = t('diskUsageTitle');
  const scopeBtns = document.querySelectorAll('.disk-scope-pills [data-disk-scope]');
  if (scopeBtns[0]) scopeBtns[0].textContent = t('diskScopeHome');
  if (scopeBtns[1]) scopeBtns[1].textContent = t('diskScopeApps');
  if (scopeBtns[2]) scopeBtns[2].textContent = t('diskScopeDownloads');
  if (scopeBtns[3]) scopeBtns[3].textContent = t('diskScopeDesktop');

  const cleanerH2 = document.querySelector('#sec-cleaner h2');
  if (cleanerH2) cleanerH2.textContent = t('cleanerTitle');
  const btnScanJunk = $('btnScanJunk');
  if (btnScanJunk) btnScanJunk.textContent = t('cleanerScanBtn');
  const btnCleanRamAlt = $('btnCleanRamAlt');
  if (btnCleanRamAlt) {
    btnCleanRamAlt.textContent = t('ramCleanBtn');
    btnCleanRamAlt.title = t('ramCleanBtnTitle');
  }
  const cleanerDnsStatus = $('cleanerDnsStatus');
  if (cleanerDnsStatus) cleanerDnsStatus.textContent = t('cleanerDnsDesc');

  if (window.tiny?.api) {
    tiny.api.call('setLanguage', { lang: currentLang }).catch(() => {});
  }

  if (latestTelemetrySnap) {
    renderTelemetry(latestTelemetrySnap);
  }
  if (latestJunkData) {
    renderJunkCleaner(latestJunkData);
  }
  if (latestDiskUsageData) {
    renderDiskUsage(latestDiskUsageData);
  }
}

function applyWindowModeUI(desktopWidgetMode, compactMode) {
  if (typeof desktopWidgetMode === 'boolean') {
    const isAlwaysOnTop = !desktopWidgetMode;
    $('btnPin').classList.toggle('active', isAlwaysOnTop);
    $('layerLabel').textContent = isAlwaysOnTop ? t('pinned') : t('pin');
  }
  if (typeof compactMode === 'boolean') {
    $('appShell').classList.toggle('compact-mode', compactMode);
    $('btnCompact').classList.toggle('active', !compactMode);
    $('compactLabel').textContent = compactMode ? t('expand') : t('collapse');
    updateVisibleCards();
  }
}

let currentFilter = 'dashboard';
let procsSub = 'top-cpu';
const recentlyKilledPids = new Map();
const selectedJunkCats = new Set(['caches', 'dev', 'logs']);
let pendingCleanConfirm = false;
let cleanConfirmTimer = null;
let latestJunkData = null;
let isCleaningOrScanning = false;
let latestDiskUsageData = null;
let isScanningDiskUsageUI = false;
let activeDiskScopePath = '';

function fileIconForExt(ext) {
  switch (String(ext || '').toLowerCase()) {
    case 'dmg':
    case 'iso':
    case 'pkg':
      return '💿';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'tgz':
    case '7z':
    case 'rar':
      return '📦';
    case 'mp4':
    case 'mov':
    case 'mkv':
    case 'avi':
    case 'webm':
      return '🎬';
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'm4a':
      return '🎵';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'heic':
    case 'icns':
    case 'svg':
      return '🖼️';
    case 'db':
    case 'sqlite':
    case 'sqlite3':
    case 'sql':
      return '🗄️';
    case 'js':
    case 'ts':
    case 'py':
    case 'm':
    case 'c':
    case 'cpp':
    case 'rs':
    case 'go':
    case 'json':
    case 'html':
    case 'css':
      return '💻';
    default:
      return '📄';
  }
}

function renderDiskUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  latestDiskUsageData = usage;

  const badge = $('diskUsagePathBadge');
  if (badge) {
    badge.textContent = usage.displayPath || (currentLang === 'en' ? '~ (Home folder)' : '~ (Katalog domowy)');
    badge.title = usage.rootPath || '';
  }

  const dirs = Array.isArray(usage.topDirs) ? usage.topDirs : [];
  const files = Array.isArray(usage.topFiles) ? usage.topFiles : [];

  if ($('topDirsHeaderLabel')) {
    $('topDirsHeaderLabel').textContent = t('diskDirsHeader', dirs.length);
  }
  if ($('topFilesHeaderLabel')) {
    $('topFilesHeaderLabel').textContent = t('diskFilesHeader', files.length);
  }

  const dirsEl = $('topDirsList');
  if (dirsEl) {
    if (dirs.length === 0) {
      dirsEl.innerHTML = `<div class="port-empty">${esc(t('diskDirsEmpty'))}</div>`;
    } else {
      const maxDirB = Math.max(1024, ...dirs.map((d) => Number(d.bytes) || 0));
      dirsEl.innerHTML = dirs
        .map((d, idx) => {
          const b = Number(d.bytes) || 0;
          const barW = Math.min(100, Math.max(3, (b / maxDirB) * 100));
          const icon = d.isApp ? '🚀' : '📁';
          const valColor = b >= 1024 * 1024 * 1024 ? '#fcd34d' : '#7dd3fc';
          return `
          <div class="proc-row dir-row-clickable" data-drill-dir="${esc(d.path)}" title="${esc(t('revealInFinder'))}: ${esc(d.shortPath)}">
            <div class="proc-bar-bg disk-dir-bar" style="width: ${barW.toFixed(1)}%"></div>
            <div class="proc-left">
              <span class="proc-rank">#${idx + 1}</span>
              <span class="proc-icon-fallback">${icon}</span>
              <div class="junk-text-wrap">
                <span class="proc-name">${esc(d.name)}</span>
                <span class="junk-sub">${esc(d.shortPath)}</span>
              </div>
            </div>
            <div class="proc-right">
              <span class="proc-primary" style="color: ${valColor}">${esc(fmtBytes(b, 1))}</span>
              <button class="reveal-finder-btn" type="button" data-reveal-path="${esc(d.path)}" title="${esc(t('revealInFinder'))}: ${esc(d.shortPath)}">📂</button>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  const filesEl = $('topFilesList');
  if (filesEl) {
    if (files.length === 0) {
      filesEl.innerHTML = `<div class="port-empty">${esc(t('diskFilesEmpty'))}</div>`;
    } else {
      const maxFileB = Math.max(1024, ...files.map((f) => Number(f.bytes) || 0));
      filesEl.innerHTML = files
        .map((f, idx) => {
          const b = Number(f.bytes) || 0;
          const barW = Math.min(100, Math.max(3, (b / maxFileB) * 100));
          const valColor = b >= 500 * 1024 * 1024 ? '#fda4af' : b >= 100 * 1024 * 1024 ? '#fcd34d' : '#d8b4fe';
          return `
          <div class="proc-row" title="${esc(f.shortPath)} (${esc(fmtBytes(b, 2))})">
            <div class="proc-bar-bg disk-file-bar" style="width: ${barW.toFixed(1)}%"></div>
            <div class="proc-left">
              <span class="proc-rank">#${idx + 1}</span>
              <span class="proc-icon-fallback">${fileIconForExt(f.ext)}</span>
              <div class="junk-text-wrap">
                <span class="proc-name">${esc(f.name)}</span>
                <span class="junk-sub">${esc(f.shortPath)}</span>
              </div>
            </div>
            <div class="proc-right">
              <span class="proc-primary" style="color: ${valColor}">${esc(fmtBytes(b, 1))}</span>
              <button class="reveal-finder-btn" type="button" data-reveal-path="${esc(f.path)}" title="${esc(t('revealInFinder'))}: ${esc(f.shortPath)}">📂</button>
            </div>
          </div>`;
        })
        .join('');
    }
  }
}

function junkCatIcon(id) {
  switch (id) {
    case 'caches':
      return '🗂️';
    case 'dev':
      return '📦';
    case 'logs':
      return '📝';
    case 'trash':
      return '🗑️';
    case 'temp':
      return '🌐';
    default:
      return '🧹';
  }
}

function renderJunkCleaner(junk) {
  if (!junk || !Array.isArray(junk.categories)) return;
  latestJunkData = junk;

  const totalBytes = Number(junk.totalBytes) || 0;
  let selectedBytes = 0;
  for (const c of junk.categories) {
    if (selectedJunkCats.has(c.id)) {
      selectedBytes += Number(c.bytes) || 0;
    }
  }

  const hudBadge = $('hudJunkBadge');
  if (hudBadge) {
    hudBadge.textContent = totalBytes > 1024 * 1024 ? fmtBytes(totalBytes, 0) : t('hudCleaner');
  }

  const totalBadge = $('junkTotalBadge');
  if (totalBadge) {
    totalBadge.textContent = t('cleanerToRecover', fmtBytes(selectedBytes, 1));
    totalBadge.className = selectedBytes > 50 * 1024 * 1024 ? 'card-pill warn' : 'card-pill good';
  }

  const btnClean = $('btnCleanJunk');
  if (btnClean && !isCleaningOrScanning) {
    btnClean.textContent = selectedBytes > 0 ? t('cleanerCleanBtnBytes', fmtBytes(selectedBytes, 0)) : t('cleanerCleanBtn');
  }

  const listEl = $('junkCategoriesList');
  if (!listEl) return;

  const catKeyMap = {
    caches: { title: 'catCachesTitle', sub: 'catCachesSub' },
    dev: { title: 'catDevTitle', sub: 'catDevSub' },
    logs: { title: 'catLogsTitle', sub: 'catLogsSub' },
    trash: { title: 'catTrashTitle', sub: 'catTrashSub' },
    temp: { title: 'catTempTitle', sub: 'catTempSub' },
  };

  const maxCatBytes = Math.max(10 * 1024 * 1024, ...junk.categories.map((c) => Number(c.bytes) || 0));
  listEl.innerHTML = junk.categories
    .map((c) => {
      const b = Number(c.bytes) || 0;
      const checked = selectedJunkCats.has(c.id) ? 'checked' : '';
      const barW = b > 0 ? Math.min(100, Math.max(3, (b / maxCatBytes) * 100)) : 0;
      const valColor = b > 100 * 1024 * 1024 ? '#fcd34d' : b > 0 ? '#6ee7b7' : 'var(--text-muted)';
      const localized = catKeyMap[c.id];
      const title = localized ? t(localized.title) : c.title;
      const sub = localized ? (c.id === 'trash' ? t(localized.sub, c.count || 0) : t(localized.sub)) : c.subtitle;
      return `
      <label class="proc-row junk-row" data-junk-id="${esc(c.id)}">
        <div class="proc-bar-bg ram-bar" style="width: ${barW.toFixed(1)}%"></div>
        <div class="proc-left">
          <input type="checkbox" class="junk-check" data-junk-check="${esc(c.id)}" ${checked} />
          <span class="proc-icon-fallback">${junkCatIcon(c.id)}</span>
          <div class="junk-text-wrap">
            <span class="proc-name">${esc(title)}</span>
            <span class="junk-sub" title="${esc(sub)}">${esc(sub)}</span>
          </div>
        </div>
        <div class="proc-right">
          <span class="proc-primary" style="color: ${valColor}">${esc(fmtBytes(b, 1))}</span>
        </div>
      </label>`;
    })
    .join('');
}

function applyCaffeinateUI(active) {
  const btn = $('btnCaffeinate');
  if (!btn) return;
  const isOn = Boolean(active);
  btn.classList.toggle('active', isOn);
  btn.title = isOn ? t('caffeinateOnTitle') : t('caffeinateOffTitle');
}

function btKindIcon(kind) {
  switch (kind) {
    case 'earbud-left':
      return '🎧L';
    case 'earbud-right':
      return '🎧P';
    case 'case':
      return '🔋';
    case 'headphones':
      return '🎧';
    case 'mouse':
      return '🖱️';
    case 'keyboard':
      return '⌨️';
    case 'gamepad':
      return '🎮';
    case 'pencil':
      return '✏️';
    default:
      return '🔋';
  }
}

function ringStrokeClassForBattery(pct, charging) {
  if (charging) return 'ring-fg stroke-amber';
  if (pct <= 15) return 'ring-fg stroke-rose';
  if (pct <= 25) return 'ring-fg stroke-amber';
  return 'ring-fg stroke-emerald';
}

function shortBtName(devItem) {
  if (devItem && typeof devItem === 'object') {
    const base = String(devItem.baseName || devItem.name || 'Bluetooth')
      .replace(/^soundcore\s+/i, '')
      .replace(/^Apple\s+/i, '')
      .trim();
    const shortBase = base.length <= 7 ? base : base.slice(0, 6);
    if (devItem.part === 'left') return `Lewa (${shortBase})`;
    if (devItem.part === 'right') return `Prawa (${shortBase})`;
    if (devItem.part === 'case') return `Etui (${shortBase})`;
  }
  const raw = String((devItem && devItem.name) || devItem || 'Bluetooth').trim();
  if (raw.length <= 10) return raw;
  const cleaned = raw
    .replace(/^soundcore\s+/i, '')
    .replace(/^Apple\s+/i, '')
    .replace(/\s+Keyboard$/i, '')
    .replace(/\s+Mouse$/i, '')
    .replace(/\s+Trackpad$/i, '');
  return cleaned.length <= 11 ? cleaned : cleaned.slice(0, 10) + '…';
}

function renderProcIcon(iconDataUrl, name) {
  if (iconDataUrl && String(iconDataUrl).startsWith('data:image/')) {
    return `<img class="proc-icon" src="${esc(iconDataUrl)}" alt="" />`;
  }
  const initial = String(name || '?').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 2).toUpperCase() || '⚙';
  return `<span class="proc-icon-fallback">${esc(initial)}</span>`;
}

function updateVisibleCards() {
  const shell = $('appShell');
  shell.setAttribute('data-view', currentFilter);

  const isDashboard = currentFilter === 'dashboard';

  // 1. Tab Bar active states
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === currentFilter);
  });

  // 2. Rings Panel vs Cards Container toggle
  const ringsPanel = $('ringsPanel');
  const cardsContainer = $('cardsContainer');
  if (ringsPanel) {
    ringsPanel.classList.toggle('hidden-for-cards', !isDashboard);
  }
  if (cardsContainer) {
    cardsContainer.classList.toggle('hidden-for-dashboard', isDashboard);
  }

  // 3. Procs subnav toggle & states
  const procsSubnav = $('procsSubnav');
  if (procsSubnav) {
    procsSubnav.hidden = (currentFilter !== 'procs');
    document.querySelectorAll('[data-procs-sub]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.procsSub === procsSub);
    });
  }

  // 4. Cards visibility
  document.querySelectorAll('.card').forEach((card) => {
    if (isDashboard) {
      card.hidden = true;
      return;
    }
    const id = card.id;
    if (currentFilter === 'procs') {
      if (procsSub === 'top-cpu') card.hidden = (id !== 'sec-cpu');
      else if (procsSub === 'top-ram') card.hidden = (id !== 'sec-ram');
      else if (procsSub === 'dev') card.hidden = (id !== 'sec-ports');
      else card.hidden = true;
    } else if (currentFilter === 'disk') {
      card.hidden = (id !== 'sec-disk');
    } else if (currentFilter === 'cleaner') {
      card.hidden = (id !== 'sec-cleaner');
    } else if (currentFilter === 'network') {
      card.hidden = (id !== 'sec-net' && id !== 'sec-wifi');
    } else if (currentFilter === 'sensors' || currentFilter === 'power') {
      card.hidden = (id !== 'sec-gpu' && id !== 'sec-battery');
    } else {
      card.hidden = false;
    }
  });

  // 5. Ring tiles & Strip item active highlights
  document.querySelectorAll('.hud-tile').forEach((tile) => {
    const jump = tile.dataset.jump;
    let isActive = false;
    if (currentFilter === 'procs') {
      isActive = (jump === procsSub) || (jump === 'top-cpu' && procsSub === 'top-cpu') || (jump === 'top-ram' && procsSub === 'top-ram');
    } else if (currentFilter === 'sensors') {
      isActive = (jump === 'power');
    } else if (currentFilter === 'network') {
      isActive = (jump === 'network');
    } else if (currentFilter === 'disk') {
      isActive = (jump === 'disk');
    }
    tile.classList.toggle('active', isActive);
  });

  const stripPortsItem = $('stripPortsItem');
  if (stripPortsItem) {
    stripPortsItem.classList.toggle('active', currentFilter === 'procs' && procsSub === 'dev');
  }

  const stripDiskItem = $('stripDiskItem');
  if (stripDiskItem) {
    stripDiskItem.classList.toggle('active', currentFilter === 'disk');
  }

  const diskHudBar = $('diskHudBar');
  if (diskHudBar) {
    diskHudBar.classList.toggle('active', currentFilter === 'disk');
  }
}

function setProcsSub(sub) {
  currentFilter = 'procs';
  procsSub = sub;
  updateVisibleCards();
  const container = $('cardsContainer');
  if (container) container.scrollTop = 0;
  const rings = $('ringsPanel');
  if (rings) rings.scrollTop = 0;
}

function setActiveTab(target, sub = null) {
  if (target === 'dashboard') {
    currentFilter = 'dashboard';
  } else if (target === 'procs') {
    currentFilter = 'procs';
    if (sub) procsSub = sub;
  } else if (target === 'top-cpu') {
    currentFilter = 'procs';
    procsSub = 'top-cpu';
  } else if (target === 'top-ram') {
    currentFilter = 'procs';
    procsSub = 'top-ram';
  } else if (target === 'dev') {
    currentFilter = 'procs';
    procsSub = 'dev';
  } else if (target === 'disk') {
    currentFilter = 'disk';
    if (!latestDiskUsageData && !isScanningDiskUsageUI) {
      triggerDiskUsageScan('');
    }
  } else if (target === 'cleaner') {
    currentFilter = 'cleaner';
  } else if (target === 'network') {
    currentFilter = 'network';
  } else if (target === 'power' || target === 'sensors') {
    currentFilter = 'sensors';
  } else {
    currentFilter = target;
  }
  updateVisibleCards();
  const container = $('cardsContainer');
  if (container) container.scrollTop = 0;
  const rings = $('ringsPanel');
  if (rings) rings.scrollTop = 0;
}

function renderTelemetry(snap) {
  if (!snap) return;
  latestTelemetrySnap = snap;
  $('liveDot').classList.add('ok');

  const { cpu, memory, network, wifi, gpu, temps, battery, disk, dev, bluetooth } = snap;

  applyWindowModeUI(snap.desktopWidgetMode, snap.compactMode);
  if (typeof snap.caffeinateActive === 'boolean') {
    applyCaffeinateUI(snap.caffeinateActive);
  }

  // Low Battery Warning Theme (<10% / <=10% while discharging)
  const macBattPct = battery?.percent ?? 100;
  const isLowBattWarning = macBattPct <= 10 && !battery?.charging;
  $('appShell').classList.toggle('low-battery-warning', isLowBattWarning);

  // 1. Mini HUD 4 Gauges (macOS System Mode)
  const cpuPct = Math.round(cpu?.totalPercent || 0);
  setRing($('ringCpu'), cpuPct);
  $('hudCpuPct').textContent = `${cpuPct}%`;
  $('hudCpuTemp').textContent = temps?.cpu > 0 ? `${temps.cpu.toFixed(0)}°C` : `${cpu?.coreCount || 8}C`;

  const ramPct = Math.round(memory?.percent || 0);
  setRing($('ringRam'), ramPct);
  $('hudRamPct').textContent = `${ramPct}%`;
  $('hudRamUsed').textContent = fmtGB(memory?.used || 0, 1);

  const gpuPct = Math.round(gpu?.deviceUtilization || 0);
  setRing($('ringGpu'), gpuPct);
  $('hudGpuPct').textContent = `${gpuPct}%`;
  $('hudGpuTemp').textContent = temps?.gpu > 0 ? `${temps.gpu.toFixed(0)}°C` : 'GPU';

  const wifiPct = Math.round(wifi?.qualityPercent || 0);
  setRing($('ringWifi'), wifiPct);
  $('hudWifiPct').textContent = `${wifiPct}%`;
  $('hudWifiDbm').textContent = wifi?.rssi ? `${wifi.rssi}dBm` : t('wifiNone');

  // 1b. Mini HUD 4 Gauges (macOS Battery + Bluetooth Widget Mode)
  const ringBatt0 = $('ringBatt0');
  if (ringBatt0) {
    setRing(ringBatt0, macBattPct);
    ringBatt0.setAttribute('class', ringStrokeClassForBattery(macBattPct, battery?.charging));
    $('hudBattIcon0').textContent = battery?.charging ? '⚡' : '💻';
    $('hudBattPct0').textContent = `${macBattPct}%`;
    $('hudBattLabel0').textContent = 'MacBook';
  }
  const btList = Array.isArray(bluetooth) ? bluetooth : [];
  for (let i = 1; i <= 3; i++) {
    const devItem = btList[i - 1];
    const slotEl = $(`btSlot${i}`);
    const ringEl = $(`ringBatt${i}`);
    const iconEl = $(`hudBattIcon${i}`);
    const pctEl = $(`hudBattPct${i}`);
    const labelEl = $(`hudBattLabel${i}`);
    if (!slotEl || !ringEl) continue;

    if (devItem) {
      const p = Math.max(0, Math.min(100, Number(devItem.percent) || 0));
      slotEl.classList.remove('empty-slot');
      slotEl.title = `${devItem.name}: ${p}%${devItem.charging ? ` (${t('btCharging')})` : ''}`;
      setRing(ringEl, p);
      ringEl.setAttribute('class', ringStrokeClassForBattery(p, devItem.charging));
      iconEl.textContent = btKindIcon(devItem.kind);
      pctEl.textContent = `${p}%`;
      labelEl.textContent = shortBtName(devItem);
    } else {
      slotEl.classList.add('empty-slot');
      slotEl.title = t('hudBtEmpty');
      setRing(ringEl, 0);
      ringEl.setAttribute('class', 'ring-fg stroke-emerald');
      iconEl.textContent = '';
      pctEl.textContent = '—';
      labelEl.textContent = 'Bluetooth';
    }
  }

  // 1c. Always-Visible Disk Capacity Bar in Top HUD
  const diskPct = Math.min(100, Math.max(0, Number(disk?.percent) || 0));
  if ($('hudDiskName')) {
    const rawDiskName = disk?.name || 'SSD';
    $('hudDiskName').textContent = rawDiskName.length > 10 ? 'Dysk SSD' : rawDiskName;
  }
  if ($('hudDiskCap')) {
    $('hudDiskCap').textContent = `${t('hudFree')}: ${fmtGB(disk?.free || 0, 1).replace(' GB', '')} / ${fmtGB(disk?.total || 0, 0)} (${diskPct.toFixed(0)}%)`;
  }
  if ($('hudDiskBarFill')) {
    $('hudDiskBarFill').style.width = `${diskPct.toFixed(1)}%`;
  }

  // 2. Mini Strip
  const downParts = fmtSpeedParts(network?.rxBytesPerSec || 0);
  const upParts = fmtSpeedParts(network?.txBytesPerSec || 0);
  $('stripDown').textContent = downParts.short;
  $('stripUp').textContent = upParts.short;
  $('stripPing').textContent = network?.pingMs != null ? `${network.pingMs}ms` : '--';
  $('stripBattIcon').textContent = battery?.charging ? '⚡' : (battery?.plugged ? '🔌' : '🔋');
  $('stripBatt').textContent = battery?.percent != null ? `${battery.percent}%` : '--%';
  $('stripDisk').textContent = fmtGB(disk?.free || 0, 0);
  const portsList = Array.isArray(dev?.ports) ? dev.ports : [];
  if ($('stripPorts')) {
    $('stripPorts').textContent = `${portsList.length}`;
  }

  // 2b. Developer & Localhost Port Inspector Card
  const dockerInfo = dev?.docker || { running: false, memoryBytes: 0, engine: 'Docker' };
  const dockerBadge = $('dockerStateBadge');
  if (dockerBadge) {
    if (dockerInfo.running) {
      dockerBadge.textContent = `${dockerInfo.engine}: ${fmtBytes(dockerInfo.memoryBytes, 1)}`;
      dockerBadge.className = 'card-pill good';
    } else {
      const devPortCount = portsList.filter((p) => p.isDevPort).length;
      dockerBadge.textContent = devPortCount > 0 ? `Dev: ${devPortCount} ${t('dockerOn').toLowerCase()}` : `Docker: ${t('dockerOff')}`;
      dockerBadge.className = devPortCount > 0 ? 'card-pill good' : 'card-pill';
    }
  }
  if ($('portsCountLabel')) {
    $('portsCountLabel').textContent = t('portsHeaderLabel', portsList.length);
  }
  if ($('procsPortsCount')) {
    $('procsPortsCount').textContent = portsList.length;
  }
  if ($('portsList')) {
    if (portsList.length === 0) {
      $('portsList').innerHTML = `<div class="port-empty">${esc(t('portsEmpty'))}</div>`;
    } else {
      $('portsList').innerHTML = portsList
        .map((pt) => {
          const badgeClass = pt.isDevPort ? 'port-badge dev-port' : 'port-badge';
          return `
          <div class="proc-row">
            <div class="proc-left">
              <span class="${badgeClass}">:${esc(pt.port)}</span>
              ${renderProcIcon(pt.icon, pt.name)}
              <span class="proc-name" title="${esc(pt.name)} (PID ${esc(pt.pid)})">${esc(pt.name)}</span>
              <span class="proc-pid">${esc(pt.pid)}</span>
            </div>
            <div class="proc-right">
              <span class="proc-sub">${esc(pt.address)}</span>
              <span class="proc-sub">${esc(fmtBytes(pt.memBytes, 0))}</span>
              <button class="proc-kill-btn" type="button" data-kill-pid="${esc(pt.pid)}" data-kill-name="${esc(pt.name)} (:${esc(pt.port)})" title="${esc(t('killPortTitle', pt.name, pt.pid, pt.port))}">✕</button>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  // 3. Network Card
  $('netIpBadge').textContent = `${network?.interface || 'en0'} • ${network?.ip || '—'}`;
  $('netDownMain').innerHTML = `${esc(downParts.num)} <small>${esc(downParts.unit)}</small>`;
  $('netUpMain').innerHTML = `${esc(upParts.num)} <small>${esc(upParts.unit)}</small>`;
  $('netDownMbps').textContent = `${(network?.rxMbps || 0).toFixed(2)} Mbps • ${fmtBytes(network?.totalRxBytes || 0, 1)}`;
  $('netUpMbps').textContent = `${(network?.txMbps || 0).toFixed(2)} Mbps • ${fmtBytes(network?.totalTxBytes || 0, 1)}`;
  $('netPingLabel').textContent = network?.pingMs != null ? `Ping: ${network.pingMs} ms` : 'Ping: ...';

  netDownHistory.push((network?.rxBytesPerSec || 0) / 1024);
  if (netDownHistory.length > HISTORY_LEN) netDownHistory.shift();
  netUpHistory.push((network?.txBytesPerSec || 0) / 1024);
  if (netUpHistory.length > HISTORY_LEN) netUpHistory.shift();

  drawSparkline(
    $('canvasNet'),
    [
      {
        data: netDownHistory,
        stroke: '#22c55e',
        fill: true,
        fillTop: 'rgba(34, 197, 94, 0.28)',
      },
      {
        data: netUpHistory,
        stroke: '#38bdf8',
        fill: false,
      },
    ],
    64
  );

  // 4. Wi-Fi Card
  const qualityLabel = (wifi?.qualityCode && t('wifiQuality_' + wifi.qualityCode)) || wifi?.label || '—';
  const qBadge = $('wifiQualityBadge');
  qBadge.textContent = wifi?.ssid ? `${wifi.ssid} • ${qualityLabel}` : `${t('wifiQuality')}: ${qualityLabel}`;
  qBadge.className = `card-pill ${wifiPct >= 70 ? 'good' : wifiPct >= 40 ? 'warn' : 'crit'}`;

  const barsEl = $('wifiBars');
  if (barsEl) {
    const barNodes = barsEl.querySelectorAll('.w-bar');
    barNodes.forEach((b, idx) => {
      b.classList.toggle('on', idx < (wifi?.bars || 0));
    });
  }

  $('wifiPctVal').textContent = `${wifiPct}%`;
  $('wifiDbmVal').textContent = wifi?.rssi ? `${wifi.rssi} dBm` : '-- dBm';
  const bandInfo = [];
  if (wifi?.band && wifi.band !== '—') bandInfo.push(wifi.band);
  if (wifi?.channel) bandInfo.push(`${t('wifiChannel')} ${wifi.channel}`);
  if (wifi?.widthMHz) bandInfo.push(`${wifi.widthMHz} MHz`);
  $('wifiBandLine').textContent = bandInfo.length > 0 ? bandInfo.join(' • ') : `${t('wifiInterface')} ${wifi?.interface || 'en0'}`;
  $('wifiTxRate').textContent = wifi?.txRate ? Math.round(wifi.txRate) : 0;
  $('wifiRssi').textContent = wifi?.rssi ? `${wifi.rssi} dBm` : '-- dBm';
  $('wifiNoise').textContent = wifi?.noise ? `${wifi.noise} dBm` : '-- dBm';
  $('wifiSnr').textContent = wifi?.snr ? `+${wifi.snr} dB` : '-- dB';

  // 5. CPU Card & Top 10 CPU Processes
  const coreDesc =
    cpu?.pCores && cpu?.eCores
      ? `${cpu.model} (${cpu.pCores}P+${cpu.eCores}E)`
      : `${cpu?.model || 'CPU'} (${cpu?.coreCount || 0}C)`;
  $('cpuModelBadge').textContent = coreDesc;
  $('cpuTotalMain').textContent = `${(cpu?.totalPercent || 0).toFixed(1)}%`;
  $('cpuBreakdown').textContent = `User: ${(cpu?.userPercent || 0).toFixed(1)}% • Sys: ${(cpu?.sysPercent || 0).toFixed(1)}% • Idle: ${(cpu?.idlePercent || 0).toFixed(1)}%`;
  $('cpuTempBadge').textContent = temps?.cpu > 0 ? `${temps.cpu.toFixed(1)}°C` : '--°C';
  const lAvg = cpu?.loadAvg || [0, 0, 0];
  $('cpuLoadBadge').textContent = `${Number(lAvg[0] || 0).toFixed(2)} / ${Number(lAvg[1] || 0).toFixed(2)}`;

  cpuHistory.push(cpu?.totalPercent || 0);
  if (cpuHistory.length > HISTORY_LEN) cpuHistory.shift();
  drawSparkline(
    $('canvasCpu'),
    [
      {
        data: cpuHistory,
        stroke: '#60a5fa',
        fill: true,
        fillTop: 'rgba(96, 165, 250, 0.3)',
      },
    ],
    100
  );

  if (Array.isArray(cpu?.cores)) {
    $('coresGrid').innerHTML = cpu.cores
      .map(
        (c) => `
        <div class="core-pill">
          <div class="core-top">
            <span class="core-name type-${esc(c.type)}">${esc(c.label)}</span>
            <span class="core-pct">${esc(c.percent)}%</span>
          </div>
          <div class="core-bar-bg">
            <div class="core-bar-fg type-${esc(c.type)}" style="width: ${Math.min(100, Math.max(0, Number(c.percent) || 0))}%"></div>
          </div>
        </div>`
      )
      .join('');
  }

  if (Array.isArray(cpu?.topProcesses) && $('topCpuList')) {
    const maxCpu = Math.max(20, ...(cpu.topProcesses.map((p) => Number(p.cpuPercent) || 0)));
    $('topCpuList').innerHTML = cpu.topProcesses
      .map((p) => {
        const barW = Math.min(100, Math.max(2, ((Number(p.cpuPercent) || 0) / maxCpu) * 100));
        return `
        <div class="proc-row">
          <div class="proc-bar-bg cpu-bar" style="width: ${barW.toFixed(1)}%"></div>
          <div class="proc-left">
            <span class="proc-rank">#${esc(p.rank)}</span>
            ${renderProcIcon(p.icon, p.name)}
            <span class="proc-name" title="${esc(p.name)} (PID ${esc(p.pid)})">${esc(p.name)}</span>
            <span class="proc-pid">${esc(p.pid)}</span>
          </div>
          <div class="proc-right">
            <span class="proc-sub">${esc(fmtBytes(p.memBytes, 0))}</span>
            <span class="proc-primary cpu-val">${esc(Number(p.cpuPercent || 0).toFixed(1))}%</span>
            <button class="proc-kill-btn" type="button" data-kill-pid="${esc(p.pid)}" data-kill-name="${esc(p.name)}" title="${esc(t('killProcTitle', p.name, p.pid))}">✕</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // 6. Memory (RAM) Card & Top 10 RAM Processes
  const pLevel = memory?.pressureLevel || 1;
  const pBadge = $('ramPressureBadge');
  if (pLevel >= 4) {
    pBadge.textContent = t('ramPressureCrit');
    pBadge.className = 'card-pill crit';
  } else if (pLevel >= 2) {
    pBadge.textContent = t('ramPressureMed');
    pBadge.className = 'card-pill warn';
  } else {
    pBadge.textContent = t('ramPressureNorm');
    pBadge.className = 'card-pill good';
  }

  const totalMem = memory?.total || 1;
  $('ramMainVal').innerHTML = `${esc(fmtGB(memory?.used || 0, 2).replace(' GB', ''))} <small>/ ${esc(fmtGB(totalMem, 1))}</small>`;
  $('ramFreeSub').textContent = `${t('ramFree')}: ${fmtGB(memory?.free || 0, 2)} • ${t('ramCache')}: ${fmtGB(memory?.cached || 0, 2)}`;
  $('ramPctBadge').textContent = `${(memory?.percent || 0).toFixed(1)}%`;
  $('ramSwapBadge').textContent = `${fmtGB(memory?.swapUsed || 0, 1)} / ${fmtGB(memory?.swapTotal || 0, 1)}`;

  const appW = Math.min(100, ((memory?.app || 0) / totalMem) * 100);
  const wiredW = Math.min(100 - appW, ((memory?.wired || 0) / totalMem) * 100);
  const compW = Math.min(100 - appW - wiredW, ((memory?.compressed || 0) / totalMem) * 100);
  $('segApp').style.width = `${appW.toFixed(1)}%`;
  $('segWired').style.width = `${wiredW.toFixed(1)}%`;
  $('segComp').style.width = `${compW.toFixed(1)}%`;

  $('ramAppVal').textContent = fmtGB(memory?.app || 0, 1);
  $('ramWiredVal').textContent = fmtGB(memory?.wired || 0, 1);
  $('ramCompVal').textContent = fmtGB(memory?.compressed || 0, 1);

  if (Array.isArray(memory?.topProcesses) && $('topRamList')) {
    const maxMem = Math.max(1, ...(memory.topProcesses.map((p) => Number(p.memBytes) || 0)));
    $('topRamList').innerHTML = memory.topProcesses
      .map((p) => {
        const barW = Math.min(100, Math.max(3, ((Number(p.memBytes) || 0) / maxMem) * 100));
        return `
        <div class="proc-row">
          <div class="proc-bar-bg ram-bar" style="width: ${barW.toFixed(1)}%"></div>
          <div class="proc-left">
            <span class="proc-rank">#${esc(p.rank)}</span>
            ${renderProcIcon(p.icon, p.name)}
            <span class="proc-name" title="${esc(p.name)} (PID ${esc(p.pid)})">${esc(p.name)}</span>
            <span class="proc-pid">${esc(p.pid)}</span>
          </div>
          <div class="proc-right">
            <span class="proc-sub">${esc(Number(p.memPercent || 0).toFixed(1))}%</span>
            <span class="proc-primary ram-val">${esc(fmtBytes(p.memBytes, 1))}</span>
            <button class="proc-kill-btn" type="button" data-kill-pid="${esc(p.pid)}" data-kill-name="${esc(p.name)}" title="${esc(t('killProcTitle', p.name, p.pid))}">✕</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // 7. GPU & Temperatures Card
  const tState = temps?.thermalState || 0;
  const tBadge = $('thermalStateBadge');
  if (tState === 0) {
    tBadge.textContent = t('thermalOk');
    tBadge.className = 'card-pill good';
  } else if (tState === 1) {
    tBadge.textContent = t('thermalWarm');
    tBadge.className = 'card-pill warn';
  } else {
    tBadge.textContent = t('thermalHot');
    tBadge.className = 'card-pill crit';
  }

  $('gpuMainVal').innerHTML = `${esc(gpuPct)}% <small>${esc(gpu?.model || 'GPU')}</small>`;
  $('gpuSubLine').textContent = `Renderer: ${gpu?.rendererUtilization || 0}% • Tiler: ${gpu?.tilerUtilization || 0}%`;
  $('gpuVramUsed').textContent = fmtBytes(gpu?.vramUsed || 0, 0);
  $('gpuVramAlloc').textContent = fmtGB(gpu?.vramAlloc || 0, 2);
  $('gpuBarFill').style.width = `${gpuPct}%`;

  applyTempEl($('tempCpu'), temps?.cpu);
  if (temps?.pCore > 0 || temps?.eCore > 0) {
    const elPE = $('tempPE');
    elPE.textContent = `${temps.pCore.toFixed(0)}° / ${temps.eCore.toFixed(0)}°C`;
    elPE.className = `t-val ${tempClass(Math.max(temps.pCore, temps.eCore))}`;
  }
  applyTempEl($('tempGpu'), temps?.gpu);
  applyTempEl($('tempSoc'), temps?.maxDie || temps?.soc);
  applyTempEl($('tempSsd'), temps?.ssd);
  applyTempEl($('tempBatt'), temps?.battery);

  // 8. Battery & Power Card
  const bPct = battery?.percent ?? 100;
  const bBadge = $('battStateBadge');
  if (battery?.charging) {
    bBadge.textContent = t('battCharging', battery.adapterWatts || 65);
    bBadge.className = 'card-pill good';
  } else if (battery?.plugged) {
    bBadge.textContent = t('battAdapter');
    bBadge.className = 'card-pill good';
  } else {
    bBadge.textContent = t('battOnBattery');
    bBadge.className = bPct <= 20 ? 'card-pill crit' : 'card-pill warn';
  }

  $('battPctMain').textContent = `${bPct}%`;
  if (battery?.minutesRemaining != null && battery.minutesRemaining > 0 && battery.minutesRemaining < 1500) {
    const h = Math.floor(battery.minutesRemaining / 60);
    const m = battery.minutesRemaining % 60;
    const suffix = battery.charging ? t('battToFull') : t('battRemaining');
    $('battTimeSub').textContent = `${h > 0 ? h + 'h ' : ''}${m}m ${suffix}`;
  } else {
    $('battTimeSub').textContent = battery?.charging
      ? t('battChargingCell')
      : battery?.plugged
      ? t('battMainsPower')
      : t('battDischarging');
  }

  $('battHealthVal').textContent = `${battery?.healthPercent || 100}% (${battery?.nominalCapacity || 0} mAh)`;
  $('battCyclesVal').textContent = `${battery?.cycleCount || 0} ${t('battCycles').toLowerCase()}`;
  $('battBarFill').style.width = `${Math.min(100, Math.max(0, bPct))}%`;

  $('battSysWatts').textContent = battery?.systemLoadWatts > 0 ? `${battery.systemLoadWatts.toFixed(1)} W` : '-- W';
  $('battInWatts').textContent = battery?.powerInWatts > 0 ? `${battery.powerInWatts.toFixed(1)} W` : '0.0 W';
  $('battVoltAmp').textContent =
    battery?.voltageV > 0 ? `${battery.voltageV.toFixed(1)}V / ${battery.amperageA.toFixed(1)}A` : '--V / --A';

  if ($('btDevicesCountLabel')) {
    $('btDevicesCountLabel').textContent = t('battBtHeader', btList.length);
  }
  if ($('btDevicesList')) {
    if (btList.length === 0) {
      $('btDevicesList').innerHTML = `<div class="port-empty">${esc(t('battBtEmpty'))}</div>`;
    } else {
      $('btDevicesList').innerHTML = btList
        .map((d) => {
          const pct = Math.max(0, Math.min(100, Number(d.percent) || 0));
          const valColor = pct <= 15 ? '#fda4af' : pct <= 25 ? '#fcd34d' : '#6ee7b7';
          return `
          <div class="proc-row">
            <div class="proc-bar-bg ram-bar" style="width: ${pct}%"></div>
            <div class="proc-left">
              <span class="proc-icon-fallback">${btKindIcon(d.kind)}</span>
              <span class="proc-name" title="${esc(d.name)}">${esc(d.name)}</span>
            </div>
            <div class="proc-right">
              <span class="proc-sub">${d.charging ? t('btCharging') : d.hfpShared ? t('btHeadset') : t('btConnected')}</span>
              <span class="proc-primary" style="color: ${valColor}">${pct}%</span>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  // 9. Disk SSD/HDD & System Junk Cleaner Card
  $('diskName').textContent = disk?.name || 'Macintosh HD';
  $('diskPctBadge').textContent = `${(disk?.percent || 0).toFixed(1)}% ${t('diskOccupied')}`;
  $('diskFreeMain').innerHTML = `${esc(fmtGB(disk?.free || 0, 1).replace(' GB', ''))} <small>${t('diskFreeSuffix')}</small>`;
  const purgeableBytes = Number(disk?.purgeable) || 0;
  const purgeableTxt = purgeableBytes > 100 * 1024 * 1024 ? ` • ${t('diskPurgeableBuf')}: ${fmtGB(purgeableBytes, 1)}` : '';
  $('diskSubLine').textContent = `${t('diskOccupiedLabel')}: ${fmtGB(disk?.used || 0, 1)} ${t('hudFrom')} ${fmtGB(disk?.total || 0, 1)}${purgeableTxt}`;
  $('diskTempVal').textContent = temps?.ssd > 0 ? `${temps.ssd.toFixed(1)}°C` : '--°C';
  $('sysUptimeVal').textContent = fmtUptime(cpu?.uptime || 0);
  const usedBarPct = Math.min(100, Math.max(0, disk?.percent || 0));
  const purgeBarPct = disk?.total > 0 ? Math.min(100 - usedBarPct, (purgeableBytes / disk.total) * 100) : 0;
  $('diskBarFill').style.width = `${usedBarPct.toFixed(1)}%`;
  if ($('diskPurgeableFill')) {
    $('diskPurgeableFill').style.width = `${purgeBarPct.toFixed(1)}%`;
  }

  if ($('volumesList')) {
    const vols = Array.isArray(disk?.volumes) ? disk.volumes : [];
    $('volumesList').innerHTML = vols
      .map((v) => {
        const vPct = v.total > 0 ? Math.min(100, Math.round((v.used / v.total) * 100)) : 0;
        const icon = v.isInternal ? '💾' : '📀';
        const kindLabel = v.isInternal ? t('diskSysVolume') : t('diskExtVolume', v.mountPoint);
        return `
        <div class="proc-row">
          <div class="proc-bar-bg cpu-bar" style="width: ${vPct}%"></div>
          <div class="proc-left">
            <span class="proc-icon-fallback">${icon}</span>
            <div class="junk-text-wrap">
              <span class="proc-name">${esc(v.name)}</span>
              <span class="junk-sub">${esc(kindLabel)} • ${t('diskOccupiedLabel')}: ${fmtGB(v.used, 1)} / ${fmtGB(v.total, 1)} (${vPct}%)</span>
            </div>
          </div>
          <div class="proc-right">
            <span class="proc-primary" style="color: #d8b4fe">${fmtGB(v.free, 1)} ${t('diskFreeVolume')}</span>
          </div>
        </div>`;
      })
      .join('');
  }

  // 10. Home Glance & System Status Overview
  if ($('homeMacModel')) {
    const rawModel = snap.cpu?.model || 'Apple Silicon';
    $('homeMacModel').textContent = rawModel.replace(/^Apple\s+/, '');
  }
  if ($('homeUptime')) {
    $('homeUptime').textContent = fmtUptime(snap.cpu?.uptime || 0);
  }
  if ($('homeWifiSsid')) {
    const ssid = snap.wifi?.ssid;
    if (ssid) {
      $('homeWifiSsid').textContent = ssid.length <= 14 ? ssid : ssid.slice(0, 13) + '…';
    } else if (snap.network?.interface) {
      $('homeWifiSsid').textContent = `${snap.network.interface} (LAN)`;
    } else {
      $('homeWifiSsid').textContent = 'Brak sieci';
    }
  }

  const maxTemp = (temps && (temps.maxDie || temps.cpu || temps.soc)) || 0;
  if ($('homeChipTemp')) {
    applyTempEl($('homeChipTemp'), maxTemp);
  }
  if ($('homeChipTempSub')) {
    if (maxTemp >= 80) $('homeChipTempSub').textContent = t('chipThermalHot');
    else if (maxTemp >= 62) $('homeChipTempSub').textContent = t('chipThermalWarm');
    else if (maxTemp > 0) $('homeChipTempSub').textContent = t('chipThermalOk');
    else $('homeChipTempSub').textContent = t('chipThermalOk');
  }

  if ($('homeChipBatt')) {
    $('homeChipBatt').textContent = snap.battery ? `${snap.battery.percent}%` : '--%';
  }
  if ($('homeChipBattSub')) {
    if (snap.battery?.charging) {
      $('homeChipBattSub').textContent = t('chipBattCharging');
    } else {
      const h = snap.battery?.healthPercent ?? 100;
      const cyc = snap.battery?.cycleCount ?? 0;
      $('homeChipBattSub').textContent = `${t('chipBattHealth')} ${h}% (${cyc}c)`;
    }
  }

  if ($('homeChipPing')) {
    $('homeChipPing').textContent = snap.network?.pingMs != null ? `${snap.network.pingMs} ms` : '-- ms';
  }
  if ($('homeChipNetSub')) {
    const rxSpd = fmtSpeedParts(snap.network?.rxBytesPerSec || 0);
    $('homeChipNetSub').textContent = `↓ ${rxSpd.short}`;
  }

  if ($('homeLoadAvg')) {
    const loads = snap.cpu?.loadAvg || [];
    if (loads.length >= 2) {
      $('homeLoadAvg').textContent = `${loads[0].toFixed(2)} / ${loads[1].toFixed(2)}`;
    } else {
      $('homeLoadAvg').textContent = `${(snap.cpu?.totalPercent || 0).toFixed(1)}%`;
    }
  }
  if ($('homeSwapVal')) {
    const swapU = snap.memory?.swapUsed || 0;
    $('homeSwapVal').textContent = swapU > 0 ? fmtBytes(swapU, 0) : '0 MB';
  }
  if ($('homeDockerVal')) {
    const dkRunning = Boolean(snap.dev?.docker?.running);
    $('homeDockerVal').textContent = dkRunning ? t('dockerOn') : t('dockerOff');
    const dkDot = $('homeDockerDot');
    if (dkDot) {
      dkDot.className = dkRunning ? 'sys-dot dot-green' : 'sys-dot';
    }
  }

  if (snap.junk) {
    renderJunkCleaner(snap.junk);
  }
  if (snap.diskUsage && !isScanningDiskUsageUI) {
    renderDiskUsage(snap.diskUsage);
  }
}

async function triggerDiskUsageScan(targetPath = '') {
  if (isScanningDiskUsageUI) return;
  isScanningDiskUsageUI = true;
  activeDiskScopePath = targetPath;

  document.querySelectorAll('[data-disk-scope]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.diskScope === targetPath);
  });

  const badge = $('diskUsagePathBadge');
  if (badge) badge.textContent = t('diskScanning');
  const refreshBtn = $('btnScanDiskUsage');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const res = await tiny.api.call('scanDiskUsage', { path: targetPath });
    if (res) {
      renderDiskUsage(res);
    }
  } catch (_) {
    if (badge) badge.textContent = t('diskScanError');
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    isScanningDiskUsageUI = false;
  }
}

if ($('diskUsageBlock')) {
  $('diskUsageBlock').addEventListener('click', async (ev) => {
    const revealBtn = ev.target.closest('[data-reveal-path]');
    if (revealBtn) {
      ev.stopPropagation();
      const p = revealBtn.dataset.revealPath;
      if (p) {
        try {
          await tiny.api.call('revealInFinder', { path: p });
        } catch (_) {}
      }
      return;
    }

    const scopeBtn = ev.target.closest('[data-disk-scope]');
    if (scopeBtn) {
      await triggerDiskUsageScan(scopeBtn.dataset.diskScope || '');
      return;
    }

    const refreshBtn = ev.target.closest('#btnScanDiskUsage');
    if (refreshBtn) {
      await triggerDiskUsageScan(activeDiskScopePath);
      return;
    }

    const dirRow = ev.target.closest('[data-drill-dir]');
    if (dirRow && dirRow.dataset.drillDir) {
      await triggerDiskUsageScan(dirRow.dataset.drillDir);
    }
  });
}

// Toggle Caffeinate ('Nie usypiaj Maca')
if ($('btnCaffeinate')) {
  $('btnCaffeinate').addEventListener('click', async () => {
    try {
      const res = await tiny.api.call('toggleCaffeinate');
      if (res && typeof res.caffeinateActive === 'boolean') {
        applyCaffeinateUI(res.caffeinateActive);
      }
    } catch (_) {}
  });
}

// System Junk Cleaner (CCleaner / Mac Sai style): Scan & Clean handlers
if ($('junkCategoriesList')) {
  $('junkCategoriesList').addEventListener('change', (ev) => {
    const chk = ev.target.closest('[data-junk-check]');
    if (!chk) return;
    const catId = chk.dataset.junkCheck;
    if (chk.checked) selectedJunkCats.add(catId);
    else selectedJunkCats.delete(catId);
    if (pendingCleanConfirm) {
      pendingCleanConfirm = false;
      if (cleanConfirmTimer) clearTimeout(cleanConfirmTimer);
      const btn = $('btnCleanJunk');
      if (btn) {
        btn.style.borderColor = '';
        btn.style.boxShadow = '';
      }
    }
    if (latestJunkData) renderJunkCleaner(latestJunkData);
  });
}

if ($('btnScanJunk')) {
  $('btnScanJunk').addEventListener('click', async () => {
    if (isCleaningOrScanning) return;
    isCleaningOrScanning = true;
    const btn = $('btnScanJunk');
    const status = $('cleanerStatusText');
    const track = $('cleanerProgTrack');
    const fill = $('cleanerProgFill');
    btn.disabled = true;
    if (status) status.textContent = t('cleanerScanningProgress');
    if (track) track.hidden = false;
    if (fill) fill.style.width = '45%';
    try {
      const scan = await tiny.api.call('scanSystemJunk');
      if (scan) {
        renderJunkCleaner(scan);
        if (status) {
          status.textContent = t('cleanerScanFinished', fmtBytes(scan.totalBytes || 0, 1));
        }
      }
    } catch (_) {
      if (status) status.textContent = t('cleanerScanError');
    } finally {
      if (fill) fill.style.width = '100%';
      setTimeout(() => {
        if (track) track.hidden = true;
      }, 600);
      btn.disabled = false;
      isCleaningOrScanning = false;
    }
  });
}

if ($('btnCleanJunk')) {
  $('btnCleanJunk').addEventListener('click', async () => {
    if (isCleaningOrScanning) return;
    const categories = Array.from(selectedJunkCats);
    if (categories.length === 0) {
      if ($('cleanerStatusText')) {
        $('cleanerStatusText').textContent = t('cleanerSelectWarning');
      }
      return;
    }

    const hasSensitive = categories.includes('trash') || categories.includes('temp');
    if (hasSensitive && !pendingCleanConfirm) {
      pendingCleanConfirm = true;
      const btn = $('btnCleanJunk');
      const status = $('cleanerStatusText');
      btn.textContent = t('cleanerConfirmBtn');
      btn.style.borderColor = '#f59e0b';
      btn.style.boxShadow = '0 0 12px rgba(245, 158, 11, 0.4)';
      if (status) {
        status.textContent =
          categories.includes('trash') && categories.includes('temp')
            ? t('cleanerConfirmBoth')
            : categories.includes('trash')
            ? t('cleanerConfirmTrash')
            : t('cleanerConfirmTemp');
      }
      if (cleanConfirmTimer) clearTimeout(cleanConfirmTimer);
      cleanConfirmTimer = setTimeout(() => {
        pendingCleanConfirm = false;
        btn.style.borderColor = '';
        btn.style.boxShadow = '';
        if (latestJunkData) renderJunkCleaner(latestJunkData);
      }, 5000);
      return;
    }

    pendingCleanConfirm = false;
    if (cleanConfirmTimer) clearTimeout(cleanConfirmTimer);
    const btn = $('btnCleanJunk');
    if (btn) {
      btn.style.borderColor = '';
      btn.style.boxShadow = '';
      btn.disabled = true;
      btn.textContent = t('cleanerCleaning');
    }
    isCleaningOrScanning = true;
    const status = $('cleanerStatusText');
    const track = $('cleanerProgTrack');
    const fill = $('cleanerProgFill');
    if (status) status.textContent = t('cleanerCleaningProgress');
    if (track) track.hidden = false;
    if (fill) fill.style.width = '60%';
    try {
      const res = await tiny.api.call('cleanSystemJunk', { categories });
      if (res?.scan) {
        renderJunkCleaner(res.scan);
      }
      if (status) {
        const freed = Number(res?.freedBytes) || 0;
        const items = Number(res?.removedItems) || 0;
        status.textContent =
          freed > 0
            ? t('cleanerSuccess', fmtBytes(freed, 1), items)
            : t('cleanerSuccessNoBytes', items);
      }
    } catch (_) {
      if (status) status.textContent = t('cleanerError');
    } finally {
      if (fill) fill.style.width = '100%';
      setTimeout(() => {
        if (track) track.hidden = true;
      }, 800);
      btn.disabled = false;
      isCleaningOrScanning = false;
      if (latestJunkData) renderJunkCleaner(latestJunkData);
    }
  });
}

// Quick RAM & DNS Cache Cleaner
if ($('btnCleanRam')) {
  $('btnCleanRam').addEventListener('click', async () => {
    const btn = $('btnCleanRam');
    const status = $('ramCleanStatus');
    btn.disabled = true;
    btn.textContent = t('ramCleanRunning');
    if (status) status.textContent = t('ramCleanRunning');
    try {
      const res = await tiny.api.call('cleanRamAndDns');
      if (status && res?.ok) {
        status.textContent = t('ramCleanDone', fmtGB(res.freeBytes || 0, 2));
      }
    } catch (_) {
      if (status) status.textContent = t('ramCleanError');
    } finally {
      btn.disabled = false;
      btn.textContent = t('ramCleanBtn');
    }
  });
}

// Toggle Always on Top ('Przypnij' vs Desktop Widget)
$('btnPin').addEventListener('click', async () => {
  const res = await tiny.api.call('toggleWidgetLayer');
  const isAlwaysOnTop = !res.desktopWidgetMode;
  try {
    await tiny.win.setAlwaysOnTop(isAlwaysOnTop);
  } catch (_) {}
  applyWindowModeUI(res.desktopWidgetMode, undefined);
});

// Toggle Compact (348x268) vs Expanded (348x660)
$('btnCompact').addEventListener('click', async () => {
  const res = await tiny.api.call('toggleCompactMode');
  applyWindowModeUI(undefined, res.compactMode);
});

// Clicking any gauge ring or status strip item switches directly to its detailed section
document.querySelectorAll('[data-jump]').forEach((el) => {
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const targetTab = el.dataset.jump;
    if (targetTab) {
      setActiveTab(targetTab);
    }
  });
});

if ($('btnToggleLang')) {
  $('btnToggleLang').addEventListener('click', (ev) => {
    ev.stopPropagation();
    setLanguage(currentLang === 'pl' ? 'en' : 'pl');
  });
}

// Main Tab Bar listener (Variant A)
if ($('mainTabBar')) {
  $('mainTabBar').addEventListener('click', (ev) => {
    const tabBtn = ev.target.closest('[data-tab]');
    if (!tabBtn) return;
    setActiveTab(tabBtn.dataset.tab);
  });
}

// Processes sub-navigation listener (CPU / RAM / Ports)
if ($('procsSubnav')) {
  $('procsSubnav').addEventListener('click', (ev) => {
    const subBtn = ev.target.closest('[data-procs-sub]');
    if (!subBtn) return;
    setProcsSub(subBtn.dataset.procsSub);
  });
}

if ($('subtabCpu')) $('subtabCpu').addEventListener('click', () => setProcsSub('top-cpu'));
if ($('subtabRam')) $('subtabRam').addEventListener('click', () => setProcsSub('top-ram'));
if ($('subtabPorts')) $('subtabPorts').addEventListener('click', () => setProcsSub('dev'));

// Home Quick Clean RAM & DNS button
if ($('btnHomeCleanRam')) {
  $('btnHomeCleanRam').addEventListener('click', async () => {
    const btn = $('btnHomeCleanRam');
    const label = $('homeCleanRamLabel');
    btn.disabled = true;
    if (label) label.textContent = t('ramCleanRunning');
    try {
      const res = await tiny.api.call('cleanRamAndDns');
      if (label) {
        label.textContent = res?.ok ? t('ramCleanDone', fmtGB(res.freeBytes || 0, 2)) : t('homeCleanRamBtn');
      }
    } catch (_) {
      if (label) label.textContent = t('ramCleanError');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (label) label.textContent = t('homeCleanRamBtn');
      }, 2000);
    }
  });
}

// Quick RAM & DNS cleaner button inside Smart Cleaner card
if ($('btnCleanRamAlt')) {
  $('btnCleanRamAlt').addEventListener('click', async () => {
    const btn = $('btnCleanRamAlt');
    const status = $('cleanerDnsStatus');
    btn.disabled = true;
    btn.textContent = t('ramCleanRunning');
    if (status) status.textContent = t('ramCleanRunning');
    try {
      const res = await tiny.api.call('cleanRamAndDns');
      if (status && res?.ok) {
        status.textContent = t('ramCleanDone', fmtGB(res.freeBytes || 0, 2));
      }
    } catch (_) {
      if (status) status.textContent = t('ramCleanError');
    } finally {
      btn.disabled = false;
      btn.textContent = t('ramCleanBtn');
    }
  });
}

// One-Click Kill Process / Port Handler (delegated on cardsContainer)
$('cardsContainer').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-kill-pid]');
  if (!btn) return;
  ev.stopPropagation();
  const pid = Number(btn.dataset.killPid);
  if (!pid || pid <= 1) return;
  const procName = btn.dataset.killName || '';

  const force = Boolean(ev.altKey);

  const row = btn.closest('.proc-row');
  if (row) {
    row.style.opacity = '0.45';
  }
  btn.textContent = '…';
  try {
    const res = await tiny.api.call('killProcess', { pid, force, name: procName });
    if (!res?.ok) {
      if (row) row.style.opacity = '';
      btn.textContent = '✕';
      const errMsg = res?.error || 'Error';
      btn.title = `${t('killFailed')}: ${errMsg}`;
      btn.style.color = '#f43f5e';
      setTimeout(() => {
        btn.style.color = '';
        btn.title = t('killProcTitle', procName, pid);
      }, 3000);
    }
  } catch (_) {
    if (row) row.style.opacity = '';
    btn.textContent = '✕';
  }
});

// Speedtest button & progress events
$('btnSpeedtest').addEventListener('click', async () => {
  const btn = $('btnSpeedtest');
  btn.disabled = true;
  btn.textContent = t('speedtestRunning');
  $('speedtestTrack').hidden = false;
  $('speedtestFill').style.width = '5%';
  try {
    await tiny.api.call('runSpeedtest');
  } finally {
    btn.disabled = false;
    btn.textContent = t('speedtestBtn');
  }
});

tiny.api.on('speedtest-progress', (info) => {
  if (!info) return;
  const statusEl = $('speedtestStatus');
  if (statusEl) {
    if (info.phase === 'ping') {
      statusEl.textContent = t('speedtestMeasuringPing');
    } else if (info.phase === 'download') {
      const mbps = typeof info.downloadMbps === 'number' ? info.downloadMbps.toFixed(1) : '...';
      statusEl.textContent = t('speedtestDownloading', mbps);
    } else if (info.phase === 'done') {
      const mbps = (Number(info.downloadMbps) || 0).toFixed(1);
      const mBps = (Number(info.downloadMBps) || 0).toFixed(1);
      const lat = info.latencyMs || 0;
      statusEl.textContent = t('speedtestDoneResult', mbps, mBps, lat);
    } else if (info.phase === 'error') {
      statusEl.textContent = t('speedtestError', info.error || 'HTTP Error');
    } else if (info.message) {
      statusEl.textContent = info.message;
    }
  }
  if (info.phase === 'done' || info.phase === 'error') {
    $('speedtestFill').style.width = info.phase === 'done' ? '100%' : '0%';
  } else {
    $('speedtestTrack').hidden = false;
    $('speedtestFill').style.width = `${Math.min(100, Math.max(5, info.progress || 10))}%`;
  }
});

// =========================================================================
// Modern Floating Dark-Glass Tooltip Engine (Variant A)
// =========================================================================
const tooltipEl = $('customTooltip');
const tipTitleEl = $('tooltipTitle');
const tipDescEl = $('tooltipDesc');
const tipHintEl = $('tooltipHint');

let tipTimeout = null;
let activeTipTarget = null;
let tooltipsEnabled = localStorage.getItem('latata_tooltips_enabled') !== 'false';

function updateTooltipsToggleUI() {
  const btn = $('btnToggleTooltips');
  if (btn) {
    btn.classList.toggle('active', tooltipsEnabled);
    btn.classList.toggle('off', !tooltipsEnabled);
    const textEl = $('tooltipToggleText');
    if (textEl) {
      textEl.textContent = tooltipsEnabled ? 'ON' : 'OFF';
    }
    btn.title = tooltipsEnabled ? t('tooltipsOnTitle') : t('tooltipsOffTitle');
    btn.setAttribute('aria-pressed', tooltipsEnabled ? 'true' : 'false');
  }

  const homeBtn = $('btnHomeToggleTooltips');
  const homeStatus = $('homeTooltipsStatus');
  if (homeStatus) {
    homeStatus.textContent = tooltipsEnabled ? 'ON' : 'OFF';
  }
  if (homeBtn) {
    homeBtn.classList.toggle('active', tooltipsEnabled);
    homeBtn.classList.toggle('off', !tooltipsEnabled);
    homeBtn.title = tooltipsEnabled ? t('tooltipsOnTitle') : t('tooltipsOffTitle');
  }
}

function setTooltipsEnabled(enabled) {
  tooltipsEnabled = !!enabled;
  localStorage.setItem('latata_tooltips_enabled', tooltipsEnabled ? 'true' : 'false');
  updateTooltipsToggleUI();
  if (!tooltipsEnabled) {
    hideTooltip();
  }
  if (window.tiny?.api) {
    tiny.api.call('setTooltipsState', { enabled: tooltipsEnabled }).catch(() => {});
  }
}

function hideTooltip() {
  if (tipTimeout) {
    clearTimeout(tipTimeout);
    tipTimeout = null;
  }
  activeTipTarget = null;
  if (tooltipEl) {
    tooltipEl.classList.remove('visible');
    tooltipEl.hidden = true;
  }
}

const TOOLTIP_DICTIONARY = [
  {
    match: (el) => el.id === 'liveDot',
    pl: {
      title: '🟢 Połączenie z systemem',
      desc: 'Aktywna dwustronna komunikacja IPC z silnikiem txiki.js i natywnym modułem macmon.',
    },
    en: {
      title: '🟢 System IPC Connection',
      desc: 'Active bidirectional IPC communication with the txiki.js engine and native macmon helper.',
    },
  },
  {
    match: (el) => el.id === 'btnToggleTooltips' || el.id === 'btnHomeToggleTooltips',
    pl: {
      title: '💡 Podpowiedzi (Tooltipy)',
      desc: 'Włącza lub całkowicie wyłącza dymki informacyjne z opisami funkcji przy najechaniu myszą.',
      hint: 'Kliknij, aby przełączyć tryb podpowiedzi',
    },
    en: {
      title: '💡 Tips & Tooltips',
      desc: 'Enables or completely disables dark-glass hover tooltip descriptions across the entire interface.',
      hint: 'Click to toggle tooltips ON / OFF',
    },
  },
  {
    match: (el) => el.id === 'btnCaffeinate',
    pl: {
      title: '☕ Tryb Caffeinate',
      desc: 'Blokuje wygaszanie ekranu i uśpienie Maca (przydatne przy pobieraniu, renderowaniu lub prezentacjach).',
      hint: 'Kliknij: Włącz / Wyłącz',
    },
    en: {
      title: '☕ Caffeinate Mode',
      desc: 'Prevents display sleep and Mac system idle sleep (useful for long renders, downloads, and presentations).',
      hint: 'Click: Toggle Caffeinate ON / OFF',
    },
  },
  {
    match: (el) => el.id === 'btnPin',
    pl: {
      title: '📌 Zawsze na wierzchu',
      desc: 'Utrzymuje okno monitora nad wszystkimi innymi aplikacjami i przestrzeniami roboczymi macOS.',
      hint: 'Kliknij: Przypnij / Tryb widżetu',
    },
    en: {
      title: '📌 Always on Top',
      desc: 'Keeps the widget floating above all other windows and across all macOS Spaces.',
      hint: 'Click: Pin / Desktop widget mode',
    },
  },
  {
    match: (el) => el.id === 'btnCompact',
    pl: {
      title: '📏 Rozmiar widżetu',
      desc: 'Przełącza pomiędzy widokiem dopasowanym (356×548) a pełną kolumną (356×760).',
      hint: 'Kliknij: Rozwiń / Zwiń',
    },
    en: {
      title: '📏 Widget Size',
      desc: 'Toggles between compact fitted mode (356×548) and full expanded column (356×760).',
      hint: 'Click: Expand / Collapse',
    },
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'dashboard',
    pl: {
      title: '🏠 Ekran Home',
      desc: 'Pulpit podsumowania Maca: 4 wskaźniki kołowe, baterie akcesoriów, pojemność dysku i stan łącza.',
    },
    en: {
      title: '🏠 Home Dashboard',
      desc: 'Mac overview dashboard: 4 activity rings, accessory batteries, storage capacity, and live glance.',
    },
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'procs',
    pl: {
      title: '⚡ Menedżer procesów',
      desc: 'Top 10 procesów obciążających procesor (CPU), pamięć (RAM) oraz aktywne porty sieciowe.',
    },
    en: {
      title: '⚡ Process Manager',
      desc: 'Top 10 CPU-heavy and memory-heavy processes plus active developer listening TCP ports.',
    },
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'disk',
    pl: {
      title: '💾 Pamięć masowa (Dysk)',
      desc: 'Pojemność dysku SSD/HDD, wolne miejsce oraz eksplorator największych folderów i plików.',
    },
    en: {
      title: '💾 Disk Storage',
      desc: 'SSD/HDD volume capacity, APFS purgeable space, and largest directories/files explorer.',
    },
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'cleaner',
    pl: {
      title: '🧹 Smart Cleaner',
      desc: 'Skanowanie i czyszczenie pamięci podręcznej aplikacji, logów, Kosza i plików tymczasowych.',
    },
    en: {
      title: '🧹 Smart Cleaner',
      desc: 'Scan and safely clean application caches, developer artifacts, logs, and user Trash.',
    },
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'network',
    pl: {
      title: '🌐 Sieć i Wi-Fi',
      desc: 'Bieżący transfer danych, wykres pobierania/wysyłania, opóźnienie ping i wbudowany speedtest.',
    },
    en: {
      title: '🌐 Network & Wi-Fi',
      desc: 'Real-time transfer rates, sparkline graph, Cloudflare ping latency, and built-in speedtest.',
    },
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'sensors',
    pl: {
      title: '🌡 Sensory i Zasilanie',
      desc: 'Temperatury procesora i GPU, stan ogniwa baterii, moc ładowarki USB-C i akcesoria Bluetooth.',
    },
    en: {
      title: '🌡 Sensors & Power',
      desc: 'CPU/GPU die thermals, battery pack health, USB-C adapter wattage, and Bluetooth accessories.',
    },
  },
  {
    match: (el) => el.id === 'subtabCpu',
    pl: {
      title: '💻 Procesor CPU',
      desc: 'Top 10 procesów najbardziej obciążających rdzenie procesora Apple Silicon.',
    },
    en: {
      title: '💻 CPU Processor',
      desc: 'Top 10 processes consuming the most Apple Silicon CPU core cycles.',
    },
  },
  {
    match: (el) => el.id === 'subtabRam',
    pl: {
      title: '🧠 Pamięć RAM',
      desc: 'Top 10 procesów zużywających najwięcej fizycznej pamięci operacyjnej RAM.',
    },
    en: {
      title: '🧠 RAM Memory',
      desc: 'Top 10 processes consuming the most physical and resident RAM memory.',
    },
  },
  {
    match: (el) => el.id === 'subtabPorts',
    pl: {
      title: '⇄ Porty TCP',
      desc: 'Nasłuchujące porty sieciowe dev/localhost (serwery www, bazy danych, kontenery Docker).',
    },
    en: {
      title: '⇄ TCP Ports',
      desc: 'Listening developer and localhost ports (web servers, databases, Docker containers).',
    },
  },
  {
    match: (el) => el.dataset.jump === 'top-cpu' && el.classList.contains('hud-tile'),
    pl: {
      title: '💻 Procesor (CPU)',
      desc: 'Całkowite obciążenie rdzeni procesora oraz temperatura układu SoC.',
      hint: 'Kliknij: Zobacz listę procesów CPU',
    },
    en: {
      title: '💻 CPU Processor',
      desc: 'Total core load and Apple Silicon SoC die temperature.',
      hint: 'Click: View CPU Top 10',
    },
  },
  {
    match: (el) => el.dataset.jump === 'top-ram' && el.classList.contains('hud-tile'),
    pl: {
      title: '🧠 Pamięć operacyjna (RAM)',
      desc: 'Pamięć zajęta przez aplikacje i system wraz z poziomem presji pamięci.',
      hint: 'Kliknij: Zobacz listę procesów RAM',
    },
    en: {
      title: '🧠 RAM Memory',
      desc: 'Active application and wired memory usage along with memory pressure level.',
      hint: 'Click: View RAM Top 10',
    },
  },
  {
    match: (el) => el.dataset.jump === 'power' && el.classList.contains('hud-tile') && !el.id.startsWith('btSlot'),
    pl: {
      title: '⚡ Karta graficzna (GPU)',
      desc: 'Wykorzystanie rdzeni graficznych Apple Silicon, silnika renderowania i temperatura.',
      hint: 'Kliknij: Zobacz sensory i zasilanie',
    },
    en: {
      title: '⚡ GPU Graphics',
      desc: 'Apple Silicon GPU core utilization, renderer/tiler loads, and thermal metrics.',
      hint: 'Click: View GPU & Thermals',
    },
  },
  {
    match: (el) => el.dataset.jump === 'network' && el.classList.contains('hud-tile'),
    pl: {
      title: '📶 Połączenie Wi-Fi',
      desc: 'Jakość sygnału bezprzewodowego wyliczona z poziomu RSSI oraz szumów tła.',
      hint: 'Kliknij: Zobacz szczegóły sieci',
    },
    en: {
      title: '📶 Wi-Fi Connection',
      desc: 'Wireless signal quality calculated from live RSSI signal strength and noise floor.',
      hint: 'Click: View Network details',
    },
  },
  {
    match: (el) => el.id === 'btSlot0',
    pl: {
      title: '🔋 Bateria MacBooka',
      desc: 'Bieżący poziom naładowania, moc zasilacza USB-C oraz kondycja ogniwa.',
      hint: 'Kliknij: Zobacz szczegóły zasilania',
    },
    en: {
      title: '🔋 MacBook Battery',
      desc: 'Current battery percentage, USB-C adapter wattage, and cycle health.',
      hint: 'Click: View Power details',
    },
  },
  {
    match: (el) => el.id === 'btSlot1' || el.id === 'btSlot2' || el.id === 'btSlot3',
    pl: {
      title: '🎧 Akcesorium Bluetooth',
      desc: 'Poziom naładowania podłączonego urządzenia (słuchawki lewa/prawa, mysz, klawiatura, etui).',
    },
    en: {
      title: '🎧 Bluetooth Accessory',
      desc: 'Battery level of connected peripheral (earbuds L/R, mouse, keyboard, charging case).',
    },
  },
  {
    match: (el) => el.id === 'diskHudBar',
    pl: {
      title: '💾 Dysk SSD / HDD',
      desc: 'Wolna i całkowita przestrzeń na dysku systemowym oraz bufory APFS.',
      hint: 'Kliknij: Zobacz największe katalogi i pliki',
    },
    en: {
      title: '💾 SSD Storage',
      desc: 'Free and total space on the macOS boot volume plus APFS purgeable buffers.',
      hint: 'Click: View Disk analyzer',
    },
  },
  {
    match: (el) => el.id === 'btnHudCleaner',
    pl: {
      title: '🧹 Szybki Cleaner',
      desc: 'Wykryte śmieci systemowe i pliki tymczasowe gotowe do bezpiecznego usunięcia.',
      hint: 'Kliknij: Otwórz Smart Cleaner',
    },
    en: {
      title: '🧹 Quick Cleaner',
      desc: 'Scanned system junk and caches ready for safe cleanup.',
      hint: 'Click: Open Smart Cleaner',
    },
  },
  {
    match: (el) => el.dataset.killPid,
    pl: {
      title: '✕ Zakończ proces',
      desc: 'Wysyła bezpieczny sygnał zakończenia SIGTERM do wybranego procesu.',
      hint: '<kbd>⌥ Option</kbd> + kliknięcie: Wymuś natychmiastowe zabicie (<kbd>kill -9</kbd>)',
    },
    en: {
      title: '✕ Terminate Process',
      desc: 'Sends a standard SIGTERM signal to gently terminate the process.',
      hint: '<kbd>⌥ Option</kbd> + click: Force kill (<kbd>kill -9</kbd>)',
    },
  },
  {
    match: (el) => el.dataset.drillDir,
    pl: {
      title: '📁 Eksploruj folder',
      desc: 'Przejdź w głąb tego katalogu, aby sprawdzić które podfoldery zajmują najwięcej miejsca.',
      hint: 'Kliknij: Otwórz ten katalog w analizatorze',
    },
    en: {
      title: '📁 Drill into Folder',
      desc: 'Inspect this directory to identify which subfolders consume the most space.',
      hint: 'Click: Open this directory in analyzer',
    },
  },
  {
    match: (el) => el.dataset.revealPath,
    pl: {
      title: '📂 Pokaż w Finderze',
      desc: 'Otwiera systemowe okno Findera i podświetla ten element na dysku.',
      hint: 'Kliknij: Otwórz w Finderze',
    },
    en: {
      title: '📂 Reveal in Finder',
      desc: 'Opens a native macOS Finder window highlighting this file or directory.',
      hint: 'Click: Reveal in Finder',
    },
  },
  {
    match: (el) => el.id === 'btnHomeCleanRam' || el.id === 'btnCleanRam' || el.id === 'btnCleanRamAlt',
    pl: {
      title: '🧹 Czyszczenie RAM i DNS',
      desc: 'Opróżnia pamięć podręczną DNS (dscacheutil) i instruuje jądro XNU, aby zwolniło nieaktywny RAM.',
      hint: 'Kliknij: Wyczyść pamięć i DNS',
    },
    en: {
      title: '🧹 Flush RAM & DNS',
      desc: 'Flushes DNS responder cache via dscacheutil and updates system RAM buffer statistics.',
      hint: 'Click: Flush memory and DNS',
    },
  },
  {
    match: (el) => el.id === 'btnSpeedtest',
    pl: {
      title: '⚡ Test prędkości łącza',
      desc: 'Mierzy rzeczywistą przepustowość pobierania i wysyłania łącząc się z brzegami CDN Cloudflare.',
      hint: 'Kliknij: Uruchom Speedtest',
    },
    en: {
      title: '⚡ Network Speedtest',
      desc: 'Measures live download throughput against Cloudflare Edge CDN servers.',
      hint: 'Click: Run Speedtest',
    },
  },
  {
    match: (el) => el.id === 'btnScanJunk',
    pl: {
      title: '🔍 Skanowanie śmieci',
      desc: 'Sprawdza katalogi pamięci podręcznej Caches, logi deweloperskie i Kosz pod kątem zbędnych plików.',
      hint: 'Kliknij: Rozpocznij skanowanie',
    },
    en: {
      title: '🔍 Scan Junk Files',
      desc: 'Scans application caches, developer build artifacts, logs, and Trash.',
      hint: 'Click: Start scan',
    },
  },
  {
    match: (el) => el.id === 'btnCleanJunk',
    pl: {
      title: '🗑️ Oczyść system',
      desc: 'Trwale usuwa zaznaczone pliki tymczasowe, bufory aplikacji i opróżnia Kosz użytkownika.',
      hint: 'Kliknij: Usuń zaznaczone śmieci',
    },
    en: {
      title: '🗑️ Clean System',
      desc: 'Permanently deletes selected temporary caches, application buffers, and empties Trash.',
      hint: 'Click: Clean selected junk',
    },
  },
  {
    match: (el) => el.classList.contains('home-chip') && el.dataset.jump === 'power' && el.querySelector('#homeChipTemp'),
    pl: {
      title: '🌡 Termika Apple Silicon',
      desc: 'Maksymalna temperatura układu scalonego SoC (rdzenie CPU, GPU i silnik Neural Engine).',
      hint: 'Kliknij: Przejdź do sensorów',
    },
    en: {
      title: '🌡 SoC Thermals',
      desc: 'Peak package temperature across CPU, GPU, and Neural Engine cores.',
      hint: 'Click: View Sensors',
    },
  },
  {
    match: (el) => el.classList.contains('home-chip') && el.dataset.jump === 'power' && el.querySelector('#homeChipBatt'),
    pl: {
      title: '🔋 Diagnostyka ogniwa',
      desc: 'Bieżąca kondycja baterii w stosunku do pojemności fabrycznej oraz łączna liczba cykli ładowania.',
      hint: 'Kliknij: Przejdź do zasilania',
    },
    en: {
      title: '🔋 Battery Health',
      desc: 'Current battery health against design capacity and total charge cycle count.',
      hint: 'Click: View Battery',
    },
  },
  {
    match: (el) => el.classList.contains('home-chip') && el.dataset.jump === 'network',
    pl: {
      title: '⚡ Jakość łącza (Ping)',
      desc: 'Średni czas podróży pakietu sieciowego w ms oraz aktualna prędkość pobierania.',
      hint: 'Kliknij: Przejdź do parametrów sieci',
    },
    en: {
      title: '⚡ Network Latency (Ping)',
      desc: 'Round-trip ICMP packet latency in milliseconds and real-time download throughput.',
      hint: 'Click: View Network',
    },
  },
  {
    match: (el) => el.classList.contains('home-sys-pill') && el.dataset.jump === 'top-cpu',
    pl: {
      title: '📊 Obciążenie systemu (Load)',
      desc: 'Średnia liczba wątków oczekujących na procesor w oknie 1 minuty oraz 5 minut.',
    },
    en: {
      title: '📊 System Load Average',
      desc: 'Average number of runnable threads waiting for CPU scheduling over 1m and 5m.',
    },
  },
  {
    match: (el) => el.classList.contains('home-sys-pill') && el.dataset.jump === 'top-ram',
    pl: {
      title: '🔄 Pamięć wymiany (Swap)',
      desc: 'Ilość danych przeniesionych tymczasowo z pamięci RAM na szybki dysk SSD.',
    },
    en: {
      title: '🔄 Swap Memory',
      desc: 'Virtual memory pages temporarily swapped from RAM out to SSD storage.',
    },
  },
  {
    match: (el) => el.classList.contains('home-sys-pill') && el.dataset.jump === 'dev',
    pl: {
      title: '🐳 Środowisko Docker',
      desc: 'Status silnika kontenerów Docker Desktop / OrbStack i pamięć zaalokowana przez kontenery.',
    },
    en: {
      title: '🐳 Docker Environment',
      desc: 'Status of Docker Desktop / OrbStack runtime and container allocated memory.',
    },
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('.strip-icon.down'),
    pl: {
      title: '↓ Prędkość pobierania',
      desc: 'Aktualna przepustowość danych pobieranych z sieci w czasie rzeczywistym.',
    },
    en: {
      title: '↓ Download Rate',
      desc: 'Current inbound network throughput in real time.',
    },
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('.strip-icon.up'),
    pl: {
      title: '↑ Prędkość wysyłania',
      desc: 'Aktualna przepustowość danych wysyłanych do sieci w czasie rzeczywistym.',
    },
    en: {
      title: '↑ Upload Rate',
      desc: 'Current outbound network throughput in real time.',
    },
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('#stripPing'),
    pl: {
      title: '⚡ Opóźnienie sieci (Ping)',
      desc: 'Czas odpowiedzi pakietu ICMP do najbliższego serwera DNS Cloudflare (1.1.1.1).',
    },
    en: {
      title: '⚡ Ping Latency',
      desc: 'ICMP round-trip latency to the nearest Cloudflare DNS resolver (1.1.1.1).',
    },
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('#stripPortsItem'),
    pl: {
      title: '⇄ Porty sieciowe',
      desc: 'Liczba aktywnych portów TCP nasłuchujących połączeń na Twoim Macu.',
    },
    en: {
      title: '⇄ Listening Ports',
      desc: 'Count of active TCP ports listening for incoming connections.',
    },
  },
];

function resolveTooltipInfo(target) {
  if (!target) return null;

  // 1. Explicit data attributes
  if (target.dataset.tipTitle || target.dataset.tipDesc) {
    return {
      title: target.dataset.tipTitle || '',
      desc: target.dataset.tipDesc || '',
      hint: target.dataset.tipHint || null,
    };
  }

  // 2. Dictionary match
  for (const entry of TOOLTIP_DICTIONARY) {
    try {
      if (entry.match(target)) {
        const loc = (currentLang === 'en' ? entry.en : entry.pl) || entry[currentLang] || entry;
        return {
          title: loc.title || entry.title,
          desc: loc.desc || entry.desc,
          hint: loc.hint !== undefined ? loc.hint : entry.hint,
        };
      }
    } catch (_) {}
  }

  // 3. Fallback to existing title or nativeTitle
  const rawTitle = target.dataset.nativeTitle || target.getAttribute('title');
  if (rawTitle && rawTitle.trim()) {
    const text = rawTitle.trim();
    if (text.includes(' — ')) {
      const [title, desc] = text.split(' — ');
      return { title: title.trim(), desc: desc.trim() };
    }
    if (text.includes(': ')) {
      const [title, desc] = text.split(': ');
      return { title: title.trim(), desc: desc.trim() };
    }
    return { title: text, desc: '' };
  }

  return null;
}

function showTooltipFor(target, info) {
  if (!tooltipEl || !info) return;
  activeTipTarget = target;

  tipTitleEl.textContent = info.title || '';
  tipDescEl.textContent = info.desc || '';
  if (info.hint && String(info.hint).trim().length > 0) {
    tipHintEl.hidden = false;
    tipHintEl.style.display = 'inline-flex';
    tipHintEl.innerHTML = info.hint;
  } else {
    tipHintEl.hidden = true;
    tipHintEl.style.display = 'none';
    tipHintEl.innerHTML = '';
  }

  tooltipEl.hidden = false;
  // Position calculation
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const pad = 8;
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  // Horizontal position: center on target, clamped within screen
  let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
  left = Math.max(pad, Math.min(winW - tipRect.width - pad, left));

  // Vertical position: prefer below if room, else above
  let top = 0;
  if (rect.bottom + tipRect.height + 6 < winH) {
    top = rect.bottom + 6;
  } else if (rect.top - tipRect.height - 6 > 0) {
    top = rect.top - tipRect.height - 6;
  } else {
    top = Math.max(pad, Math.min(winH - tipRect.height - pad, rect.top));
  }

  tooltipEl.style.left = `${Math.round(left)}px`;
  tooltipEl.style.top = `${Math.round(top)}px`;

  requestAnimationFrame(() => {
    if (activeTipTarget === target) {
      tooltipEl.classList.add('visible');
    }
  });
}

const TOOLTIP_SELECTORS = [
  '[data-tip-title]',
  '.nav-tab',
  '.subnav-pill',
  '.scope-pill',
  '[data-procs-sub]',
  '[data-kill-pid]',
  '[data-drill-dir]',
  '[data-reveal-path]',
  '[data-disk-scope]',
  'button',
  '.hud-tile',
  '.mini-strip-item',
  '.home-chip',
  '.home-sys-pill',
  '#liveDot',
  '[title]',
].join(', ');

document.addEventListener('mouseover', (ev) => {
  if (!tooltipsEnabled) return;
  const target = ev.target.closest(TOOLTIP_SELECTORS);
  if (!target || target === tooltipEl || tooltipEl.contains(target)) return;

  // Ignore window/large background containers
  if (
    target === document.body ||
    target.id === 'appShell' ||
    target.id === 'cardsContainer' ||
    target.id === 'ringsPanel' ||
    target.id === 'mainTabBar' ||
    target.id === 'procsSubnav' ||
    target.id === 'homeGlancePanel' ||
    target.classList.contains('cards-container') ||
    target.classList.contains('rings-panel') ||
    target.classList.contains('card') ||
    target.classList.contains('app-shell') ||
    target.classList.contains('disk-hud-bar')
  ) {
    return;
  }

  const info = resolveTooltipInfo(target);
  if (!info) return;

  // Suppress native slow title popup
  if (target.hasAttribute('title')) {
    target.dataset.nativeTitle = target.getAttribute('title');
    target.removeAttribute('title');
  }

  if (activeTipTarget === target) return;

  if (tipTimeout) clearTimeout(tipTimeout);
  tipTimeout = setTimeout(() => {
    showTooltipFor(target, info);
  }, 160);
}, true);

document.addEventListener('mouseout', (ev) => {
  const target = ev.target.closest(TOOLTIP_SELECTORS);
  if (target && target.dataset.nativeTitle) {
    target.setAttribute('title', target.dataset.nativeTitle);
    delete target.dataset.nativeTitle;
  }
  if (!ev.relatedTarget || !ev.relatedTarget.closest) {
    hideTooltip();
    return;
  }
  const nextTarget = ev.relatedTarget.closest(TOOLTIP_SELECTORS);
  if (nextTarget !== activeTipTarget) {
    hideTooltip();
  }
}, true);

window.addEventListener('scroll', hideTooltip, true);
document.addEventListener('click', hideTooltip, true);

if ($('btnToggleTooltips')) {
  $('btnToggleTooltips').addEventListener('click', (ev) => {
    ev.stopPropagation();
    setTooltipsEnabled(!tooltipsEnabled);
  });
}

if ($('btnHomeToggleTooltips')) {
  $('btnHomeToggleTooltips').addEventListener('click', (ev) => {
    ev.stopPropagation();
    setTooltipsEnabled(!tooltipsEnabled);
  });
}

updateTooltipsToggleUI();

async function boot() {
  while (typeof window.tiny === 'undefined' || !window.tiny?.api) {
    await new Promise((r) => setTimeout(r, 25));
  }

  tiny.api.on('window-mode', ({ desktopWidgetMode, compactMode }) => {
    applyWindowModeUI(desktopWidgetMode, compactMode);
  });

  tiny.api.on('caffeinate-mode', ({ caffeinateActive }) => {
    applyCaffeinateUI(caffeinateActive);
  });

  tiny.api.on('caffeinate-state', ({ caffeinateActive }) => {
    applyCaffeinateUI(caffeinateActive);
  });

  tiny.api.on('tooltips-mode', ({ tooltipsEnabled: val }) => {
    setTooltipsEnabled(val);
  });

  tiny.api.on('telemetry', (snap) => {
    renderTelemetry(snap);
  });

  tiny.api.call('setTooltipsState', { enabled: tooltipsEnabled }).catch(() => {});

  setLanguage(currentLang);
  updateVisibleCards();
  try {
    const snap = await tiny.api.call('getSnapshot');
    renderTelemetry(snap);
  } catch (err) {
    console.error('Initial snapshot error:', err);
  }
}

boot().catch((err) => {
  console.error('Boot error:', err);
});
