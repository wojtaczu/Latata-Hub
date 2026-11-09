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

function applyWindowModeUI(desktopWidgetMode, compactMode) {
  if (typeof desktopWidgetMode === 'boolean') {
    const isAlwaysOnTop = !desktopWidgetMode;
    $('btnPin').classList.toggle('active', isAlwaysOnTop);
    $('layerLabel').textContent = isAlwaysOnTop ? 'Przypięto' : 'Przypnij';
  }
  if (typeof compactMode === 'boolean') {
    $('appShell').classList.toggle('compact-mode', compactMode);
    $('btnCompact').classList.toggle('active', !compactMode);
    $('compactLabel').textContent = compactMode ? 'Rozwiń' : 'Zwiń';
    updateVisibleCards();
  }
}

let currentFilter = 'dashboard';
let procsSub = 'top-cpu';
const recentlyKilledPids = new Map();
const selectedJunkCats = new Set(['caches', 'dev', 'logs', 'trash', 'temp']);
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
    badge.textContent = usage.displayPath || '~ (Katalog domowy)';
    badge.title = usage.rootPath || '';
  }

  const dirs = Array.isArray(usage.topDirs) ? usage.topDirs : [];
  const files = Array.isArray(usage.topFiles) ? usage.topFiles : [];

  if ($('topDirsHeaderLabel')) {
    $('topDirsHeaderLabel').textContent = `📁 Największe katalogi (${dirs.length})`;
  }
  if ($('topFilesHeaderLabel')) {
    $('topFilesHeaderLabel').textContent = `📄 Największe pliki (${files.length})`;
  }

  const dirsEl = $('topDirsList');
  if (dirsEl) {
    if (dirs.length === 0) {
      dirsEl.innerHTML = `<div class="port-empty">Brak podkatalogów w tej lokalizacji</div>`;
    } else {
      const maxDirB = Math.max(1024, ...dirs.map((d) => Number(d.bytes) || 0));
      dirsEl.innerHTML = dirs
        .map((d, idx) => {
          const b = Number(d.bytes) || 0;
          const barW = Math.min(100, Math.max(3, (b / maxDirB) * 100));
          const icon = d.isApp ? '🚀' : '📁';
          const valColor = b >= 1024 * 1024 * 1024 ? '#fcd34d' : '#7dd3fc';
          return `
          <div class="proc-row dir-row-clickable" data-drill-dir="${esc(d.path)}" title="Kliknij, aby wejść w głąb katalogu: ${esc(d.shortPath)}">
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
              <button class="reveal-finder-btn" type="button" data-reveal-path="${esc(d.path)}" title="Pokaż w Finderze: ${esc(d.shortPath)}">📂</button>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  const filesEl = $('topFilesList');
  if (filesEl) {
    if (files.length === 0) {
      filesEl.innerHTML = `<div class="port-empty">Brak dużych plików w tej lokalizacji</div>`;
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
              <button class="reveal-finder-btn" type="button" data-reveal-path="${esc(f.path)}" title="Pokaż plik w Finderze: ${esc(f.shortPath)}">📂</button>
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
    hudBadge.textContent = totalBytes > 1024 * 1024 ? fmtBytes(totalBytes, 0) : 'Cleaner';
  }

  const totalBadge = $('junkTotalBadge');
  if (totalBadge) {
    totalBadge.textContent = `Do odzyskania: ${fmtBytes(selectedBytes, 1)}`;
    totalBadge.className = selectedBytes > 50 * 1024 * 1024 ? 'card-pill warn' : 'card-pill good';
  }

  const btnClean = $('btnCleanJunk');
  if (btnClean && !isCleaningOrScanning) {
    btnClean.textContent = selectedBytes > 0 ? `🧹 Wyczyść (${fmtBytes(selectedBytes, 0)})` : '🧹 Wyczyść';
  }

  const listEl = $('junkCategoriesList');
  if (!listEl) return;

  const maxCatBytes = Math.max(10 * 1024 * 1024, ...junk.categories.map((c) => Number(c.bytes) || 0));
  listEl.innerHTML = junk.categories
    .map((c) => {
      const b = Number(c.bytes) || 0;
      const checked = selectedJunkCats.has(c.id) ? 'checked' : '';
      const barW = b > 0 ? Math.min(100, Math.max(3, (b / maxCatBytes) * 100)) : 0;
      const valColor = b > 100 * 1024 * 1024 ? '#fcd34d' : b > 0 ? '#6ee7b7' : 'var(--text-muted)';
      return `
      <label class="proc-row junk-row" data-junk-id="${esc(c.id)}">
        <div class="proc-bar-bg ram-bar" style="width: ${barW.toFixed(1)}%"></div>
        <div class="proc-left">
          <input type="checkbox" class="junk-check" data-junk-check="${esc(c.id)}" ${checked} />
          <span class="proc-icon-fallback">${junkCatIcon(c.id)}</span>
          <div class="junk-text-wrap">
            <span class="proc-name">${esc(c.title)}</span>
            <span class="junk-sub" title="${esc(c.subtitle)}">${esc(c.subtitle)}</span>
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
  btn.title = isOn
    ? 'Tryb Caffeinate: AKTYWNY (Mac i ekran nie zasną — kliknij, aby wyłączyć)'
    : 'Tryb Caffeinate: blokuj usypianie ekranu i Maca (Wył.)';
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
  $('liveDot').classList.add('ok');

  const { cpu, memory, network, wifi, gpu, temps, battery, disk, dev, bluetooth } = snap;

  if (cpu?.model && $('headerChip')) {
    $('headerChip').textContent = cpu.model.replace('Apple ', '');
  }
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
  $('hudWifiDbm').textContent = wifi?.rssi ? `${wifi.rssi}dBm` : 'Brak';

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
      slotEl.title = `${devItem.name}: ${p}%${devItem.charging ? ' (Ładowanie)' : ''}`;
      setRing(ringEl, p);
      ringEl.setAttribute('class', ringStrokeClassForBattery(p, devItem.charging));
      iconEl.textContent = btKindIcon(devItem.kind);
      pctEl.textContent = `${p}%`;
      labelEl.textContent = shortBtName(devItem);
    } else {
      slotEl.classList.add('empty-slot');
      slotEl.title = 'Brak kolejnego urządzenia Bluetooth z raportowaniem baterii';
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
    $('hudDiskCap').textContent = `Wolne: ${fmtGB(disk?.free || 0, 1).replace(' GB', '')} / ${fmtGB(disk?.total || 0, 0)} (${diskPct.toFixed(0)}%)`;
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
      dockerBadge.textContent = devPortCount > 0 ? `Dev: ${devPortCount} aktywne` : 'Docker: Wył.';
      dockerBadge.className = devPortCount > 0 ? 'card-pill good' : 'card-pill';
    }
  }
  if ($('portsCountLabel')) {
    $('portsCountLabel').textContent = `Nasłuchujące porty TCP (${portsList.length})`;
  }
  if ($('procsPortsCount')) {
    $('procsPortsCount').textContent = portsList.length;
  }
  if ($('portsList')) {
    if (portsList.length === 0) {
      $('portsList').innerHTML = `<div class="port-empty">Brak aktywnych nasłuchujących portów TCP</div>`;
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
              <button class="proc-kill-btn" type="button" data-kill-pid="${esc(pt.pid)}" data-kill-name="${esc(pt.name)} (:${esc(pt.port)})" title="Zwolnij port :${esc(pt.port)} — zakończ ${esc(pt.name)} (PID ${esc(pt.pid)})">✕</button>
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
  const qBadge = $('wifiQualityBadge');
  qBadge.textContent = wifi?.ssid ? `${wifi.ssid} • ${wifi.label}` : `Jakość: ${wifi?.label || '—'}`;
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
  if (wifi?.channel) bandInfo.push(`Kanał ${wifi.channel}`);
  if (wifi?.widthMHz) bandInfo.push(`${wifi.widthMHz} MHz`);
  $('wifiBandLine').textContent = bandInfo.length > 0 ? bandInfo.join(' • ') : `Interfejs ${wifi?.interface || 'en0'}`;
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
            <button class="proc-kill-btn" type="button" data-kill-pid="${esc(p.pid)}" data-kill-name="${esc(p.name)}" title="Zakończ proces ${esc(p.name)} (PID ${esc(p.pid)}) • Kliknij z ⌥ Option aby wymusić (kill -9)">✕</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // 6. Memory (RAM) Card & Top 10 RAM Processes
  const pLevel = memory?.pressureLevel || 1;
  const pBadge = $('ramPressureBadge');
  if (pLevel >= 4) {
    pBadge.textContent = 'Ciśnienie: Kryt.';
    pBadge.className = 'card-pill crit';
  } else if (pLevel >= 2) {
    pBadge.textContent = 'Ciśnienie: Średnie';
    pBadge.className = 'card-pill warn';
  } else {
    pBadge.textContent = 'Ciśnienie: Niskie';
    pBadge.className = 'card-pill good';
  }

  const totalMem = memory?.total || 1;
  $('ramMainVal').innerHTML = `${esc(fmtGB(memory?.used || 0, 2).replace(' GB', ''))} <small>/ ${esc(fmtGB(totalMem, 1))}</small>`;
  $('ramFreeSub').textContent = `Wolne: ${fmtGB(memory?.free || 0, 2)} • Cache: ${fmtGB(memory?.cached || 0, 2)}`;
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
            <button class="proc-kill-btn" type="button" data-kill-pid="${esc(p.pid)}" data-kill-name="${esc(p.name)}" title="Zakończ proces ${esc(p.name)} (PID ${esc(p.pid)}) • Kliknij z ⌥ Option aby wymusić (kill -9)">✕</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // 7. GPU & Temperatures Card
  const tState = temps?.thermalState || 0;
  const tBadge = $('thermalStateBadge');
  if (tState === 0) {
    tBadge.textContent = 'Termika: OK';
    tBadge.className = 'card-pill good';
  } else if (tState === 1) {
    tBadge.textContent = 'Termika: Ciepło';
    tBadge.className = 'card-pill warn';
  } else {
    tBadge.textContent = 'Termika: Gorąco';
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
    bBadge.textContent = `Ładowanie ⚡ (${battery.adapterWatts || 65}W)`;
    bBadge.className = 'card-pill good';
  } else if (battery?.plugged) {
    bBadge.textContent = 'Zasilacz 🔌';
    bBadge.className = 'card-pill good';
  } else {
    bBadge.textContent = 'Na baterii 🔋';
    bBadge.className = bPct <= 20 ? 'card-pill crit' : 'card-pill warn';
  }

  $('battPctMain').textContent = `${bPct}%`;
  if (battery?.minutesRemaining != null && battery.minutesRemaining > 0 && battery.minutesRemaining < 1500) {
    const h = Math.floor(battery.minutesRemaining / 60);
    const m = battery.minutesRemaining % 60;
    const suffix = battery.charging ? 'do pełnego' : 'pozostało';
    $('battTimeSub').textContent = `${h > 0 ? h + 'h ' : ''}${m}m ${suffix}`;
  } else {
    $('battTimeSub').textContent = battery?.charging
      ? 'Ładowanie ogniwa'
      : battery?.plugged
      ? 'Zasilanie sieciowe'
      : 'Praca na baterii';
  }

  $('battHealthVal').textContent = `${battery?.healthPercent || 100}% (${battery?.nominalCapacity || 0} mAh)`;
  $('battCyclesVal').textContent = `${battery?.cycleCount || 0} cykli`;
  $('battBarFill').style.width = `${Math.min(100, Math.max(0, bPct))}%`;

  $('battSysWatts').textContent = battery?.systemLoadWatts > 0 ? `${battery.systemLoadWatts.toFixed(1)} W` : '-- W';
  $('battInWatts').textContent = battery?.powerInWatts > 0 ? `${battery.powerInWatts.toFixed(1)} W` : '0.0 W';
  $('battVoltAmp').textContent =
    battery?.voltageV > 0 ? `${battery.voltageV.toFixed(1)}V / ${battery.amperageA.toFixed(1)}A` : '--V / --A';

  if ($('btDevicesCountLabel')) {
    $('btDevicesCountLabel').textContent = `Baterie Bluetooth (${btList.length})`;
  }
  if ($('btDevicesList')) {
    if (btList.length === 0) {
      $('btDevicesList').innerHTML = `<div class="port-empty">Brak połączonych akcesoriów Bluetooth z baterią</div>`;
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
              <span class="proc-sub">${d.charging ? '⚡ Ładowanie' : d.hfpShared ? 'Słuchawka BT (HFP)' : 'Połączono'}</span>
              <span class="proc-primary" style="color: ${valColor}">${pct}%</span>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  // 9. Disk SSD/HDD & System Junk Cleaner Card
  $('diskName').textContent = disk?.name || 'Macintosh HD';
  $('diskPctBadge').textContent = `${(disk?.percent || 0).toFixed(1)}% zajęte`;
  $('diskFreeMain').innerHTML = `${esc(fmtGB(disk?.free || 0, 1).replace(' GB', ''))} <small>GB wolne</small>`;
  const purgeableBytes = Number(disk?.purgeable) || 0;
  const purgeableTxt = purgeableBytes > 100 * 1024 * 1024 ? ` • Bufory APFS: ${fmtGB(purgeableBytes, 1)}` : '';
  $('diskSubLine').textContent = `Zajęte: ${fmtGB(disk?.used || 0, 1)} z ${fmtGB(disk?.total || 0, 1)}${purgeableTxt}`;
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
        const kindLabel = v.isInternal ? 'Dysk systemowy' : `Dysk zewn. (${v.mountPoint})`;
        return `
        <div class="proc-row">
          <div class="proc-bar-bg cpu-bar" style="width: ${vPct}%"></div>
          <div class="proc-left">
            <span class="proc-icon-fallback">${icon}</span>
            <div class="junk-text-wrap">
              <span class="proc-name">${esc(v.name)}</span>
              <span class="junk-sub">${esc(kindLabel)} • Zajęte: ${fmtGB(v.used, 1)} / ${fmtGB(v.total, 1)} (${vPct}%)</span>
            </div>
          </div>
          <div class="proc-right">
            <span class="proc-primary" style="color: #d8b4fe">${fmtGB(v.free, 1)} wolne</span>
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
    if (maxTemp >= 80) $('homeChipTempSub').textContent = 'Wysoka temp.';
    else if (maxTemp >= 62) $('homeChipTempSub').textContent = 'Podwyższona';
    else if (maxTemp > 0) $('homeChipTempSub').textContent = 'W normie';
    else $('homeChipTempSub').textContent = 'W normie';
  }

  if ($('homeChipBatt')) {
    $('homeChipBatt').textContent = snap.battery ? `${snap.battery.percent}%` : '--%';
  }
  if ($('homeChipBattSub')) {
    if (snap.battery?.charging) {
      $('homeChipBattSub').textContent = 'Ładowanie ⚡';
    } else {
      const h = snap.battery?.healthPercent ?? 100;
      const cyc = snap.battery?.cycleCount ?? 0;
      $('homeChipBattSub').textContent = `Kondycja ${h}% (${cyc}c)`;
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
    $('homeDockerVal').textContent = dkRunning ? 'Aktywny' : 'Wył.';
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
  if (badge) badge.textContent = 'Skanowanie...';
  const refreshBtn = $('btnScanDiskUsage');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const res = await tiny.api.call('scanDiskUsage', { path: targetPath });
    if (res) {
      renderDiskUsage(res);
    }
  } catch (_) {
    if (badge) badge.textContent = 'Błąd skanowania';
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
    if (status) status.textContent = 'Skanowanie katalogów Cache, Logów, Kosza i Dev...';
    if (track) track.hidden = false;
    if (fill) fill.style.width = '45%';
    try {
      const scan = await tiny.api.call('scanSystemJunk');
      if (scan) {
        renderJunkCleaner(scan);
        if (status) {
          status.textContent = `Skan zakończony: wykryto ${fmtBytes(scan.totalBytes || 0, 1)} śmieci`;
        }
      }
    } catch (_) {
      if (status) status.textContent = 'Błąd podczas skanowania plików tymczasowych';
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
        $('cleanerStatusText').textContent = 'Zaznacz przynajmniej jedną kategorię do wyczyszczenia!';
      }
      return;
    }
    isCleaningOrScanning = true;
    const btn = $('btnCleanJunk');
    const status = $('cleanerStatusText');
    const track = $('cleanerProgTrack');
    const fill = $('cleanerProgFill');
    btn.disabled = true;
    btn.textContent = 'Czyszczenie...';
    if (status) status.textContent = 'Usuwanie zaznaczonych śmieci i czyszczenie DNS...';
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
            ? `✅ Oczyszczono ${fmtBytes(freed, 1)} (${items} elementów)!`
            : `✅ Wyczyszczono (${items} elementów + cache DNS)!`;
      }
    } catch (_) {
      if (status) status.textContent = 'Błąd podczas czyszczenia wybranych kategorii';
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
    btn.textContent = 'Czyszczenie...';
    if (status) status.textContent = 'Opróżnianie cache DNS i odświeżanie RAM...';
    try {
      const res = await tiny.api.call('cleanRamAndDns');
      if (status && res?.ok) {
        status.textContent = `Wyczyszczono DNS! Wolny RAM: ${fmtGB(res.afterFree || 0, 2)}`;
      }
    } catch (_) {
      if (status) status.textContent = 'Błąd podczas czyszczenia DNS';
    } finally {
      btn.disabled = false;
      btn.textContent = '🧹 Wyczyść RAM i DNS';
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
    if (label) label.textContent = 'Czyszczenie...';
    try {
      const res = await tiny.api.call('cleanRamAndDns');
      if (label) {
        label.textContent = res?.ok ? '✅ Wyczyszczono RAM i DNS!' : 'Wyczyszczono';
      }
    } catch (_) {
      if (label) label.textContent = 'Błąd czyszczenia';
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (label) label.textContent = 'Wyczyść RAM i DNS';
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
    btn.textContent = 'Czyszczenie...';
    if (status) status.textContent = 'Opróżnianie cache DNS i odświeżanie RAM...';
    try {
      const res = await tiny.api.call('cleanRamAndDns');
      if (status && res?.ok) {
        status.textContent = `Wyczyszczono DNS! Wolny RAM: ${fmtGB(res.afterFree || 0, 2)}`;
      }
    } catch (_) {
      if (status) status.textContent = 'Błąd podczas czyszczenia DNS';
    } finally {
      btn.disabled = false;
      btn.textContent = '🧹 Wyczyść RAM i DNS';
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

  const prevAttempt = recentlyKilledPids.get(pid) || 0;
  const force = Boolean(ev.altKey || ev.shiftKey || (Date.now() - prevAttempt < 5000));
  recentlyKilledPids.set(pid, Date.now());

  const row = btn.closest('.proc-row');
  if (row) {
    row.style.opacity = '0.45';
  }
  btn.textContent = '…';
  try {
    await tiny.api.call('killProcess', { pid, force });
  } catch (_) {}
});

// Speedtest button & progress events
$('btnSpeedtest').addEventListener('click', async () => {
  const btn = $('btnSpeedtest');
  btn.disabled = true;
  btn.textContent = 'Test...';
  $('speedtestTrack').hidden = false;
  $('speedtestFill').style.width = '5%';
  try {
    await tiny.api.call('runSpeedtest');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Testuj łącze';
  }
});

tiny.api.on('speedtest-progress', (info) => {
  if (!info) return;
  $('speedtestStatus').textContent = info.message || '';
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
    btn.title = tooltipsEnabled
      ? 'Wskazówki (Tooltipy): ON (kliknij, aby wyłączyć)'
      : 'Wskazówki (Tooltipy): OFF (kliknij, aby włączyć)';
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
    homeBtn.title = tooltipsEnabled
      ? 'Wskazówki (Tooltipy): ON (kliknij, aby wyłączyć)'
      : 'Wskazówki (Tooltipy): OFF (kliknij, aby włączyć)';
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
    title: '🟢 Połączenie z systemem',
    desc: 'Aktywna dwustronna komunikacja IPC z silnikiem txiki.js i natywnym modułem macmon.',
  },
  {
    match: (el) => el.id === 'btnToggleTooltips' || el.id === 'btnHomeToggleTooltips',
    title: '💡 Podpowiedzi (Tooltipy)',
    desc: 'Włącza lub całkowicie wyłącza dymki informacyjne z opisami funkcji przy najechaniu myszą.',
    hint: 'Kliknij, aby przełączyć tryb podpowiedzi',
  },
  {
    match: (el) => el.id === 'btnCaffeinate',
    title: '☕ Tryb Caffeinate',
    desc: 'Blokuje wygaszanie ekranu i uśpienie Maca (przydatne przy pobieraniu, renderowaniu lub prezentacjach).',
    hint: 'Kliknij: Włącz / Wyłącz',
  },
  {
    match: (el) => el.id === 'btnPin',
    title: '📌 Zawsze na wierzchu',
    desc: 'Utrzymuje okno monitora nad wszystkimi innymi aplikacjami i przestrzeniami roboczymi macOS.',
    hint: 'Kliknij: Przypnij / Tryb widżetu',
  },
  {
    match: (el) => el.id === 'btnCompact',
    title: '📏 Rozmiar widżetu',
    desc: 'Przełącza pomiędzy widokiem dopasowanym (356×548) a pełną kolumną (356×760).',
    hint: 'Kliknij: Rozwiń / Zwiń',
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'dashboard',
    title: '🏠 Ekran Home',
    desc: 'Pulpit podsumowania Maca: 4 wskaźniki kołowe, baterie akcesoriów, pojemność dysku i stan łącza.',
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'procs',
    title: '⚡ Menedżer procesów',
    desc: 'Top 10 procesów obciążających procesor (CPU), pamięć (RAM) oraz aktywne porty sieciowe.',
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'disk',
    title: '💾 Pamięć masowa (Dysk)',
    desc: 'Pojemność dysku SSD/HDD, wolne miejsce oraz eksplorator największych folderów i plików.',
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'cleaner',
    title: '🧹 Smart Cleaner',
    desc: 'Skanowanie i czyszczenie pamięci podręcznej aplikacji, logów, Kosza i plików tymczasowych.',
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'network',
    title: '🌐 Sieć i Wi-Fi',
    desc: 'Bieżący transfer danych, wykres pobierania/wysyłania, opóźnienie ping i wbudowany speedtest.',
  },
  {
    match: (el) => el.classList.contains('nav-tab') && el.dataset.tab === 'sensors',
    title: '🌡 Sensory i Zasilanie',
    desc: 'Temperatury procesora i GPU, stan ogniwa baterii, moc ładowarki USB-C i akcesoria Bluetooth.',
  },
  {
    match: (el) => el.id === 'subtabCpu',
    title: '💻 Procesor CPU',
    desc: 'Top 10 procesów najbardziej obciążających rdzenie procesora Apple Silicon.',
  },
  {
    match: (el) => el.id === 'subtabRam',
    title: '🧠 Pamięć RAM',
    desc: 'Top 10 procesów zużywających najwięcej fizycznej pamięci operacyjnej RAM.',
  },
  {
    match: (el) => el.id === 'subtabPorts',
    title: '⇄ Porty TCP',
    desc: 'Nasłuchujące porty sieciowe dev/localhost (serwery www, bazy danych, kontenery Docker).',
  },
  {
    match: (el) => el.dataset.jump === 'top-cpu' && el.classList.contains('hud-tile'),
    title: '💻 Procesor (CPU)',
    desc: 'Całkowite obciążenie rdzeni procesora oraz temperatura układu SoC.',
    hint: 'Kliknij: Zobacz listę procesów CPU',
  },
  {
    match: (el) => el.dataset.jump === 'top-ram' && el.classList.contains('hud-tile'),
    title: '🧠 Pamięć operacyjna (RAM)',
    desc: 'Pamięć zajęta przez aplikacje i system wraz z poziomem presji pamięci.',
    hint: 'Kliknij: Zobacz listę procesów RAM',
  },
  {
    match: (el) => el.dataset.jump === 'power' && el.classList.contains('hud-tile') && !el.id.startsWith('btSlot'),
    title: '⚡ Karta graficzna (GPU)',
    desc: 'Wykorzystanie rdzeni graficznych Apple Silicon, silnika renderowania i temperatura.',
    hint: 'Kliknij: Zobacz sensory i zasilanie',
  },
  {
    match: (el) => el.dataset.jump === 'network' && el.classList.contains('hud-tile'),
    title: '📶 Połączenie Wi-Fi',
    desc: 'Jakość sygnału bezprzewodowego wyliczona z poziomu RSSI oraz szumów tła.',
    hint: 'Kliknij: Zobacz szczegóły sieci',
  },
  {
    match: (el) => el.id === 'btSlot0',
    title: '🔋 Bateria MacBooka',
    desc: 'Bieżący poziom naładowania, moc zasilacza USB-C oraz kondycja ogniwa.',
    hint: 'Kliknij: Zobacz szczegóły zasilania',
  },
  {
    match: (el) => el.id === 'btSlot1' || el.id === 'btSlot2' || el.id === 'btSlot3',
    title: '🎧 Akcesorium Bluetooth',
    desc: 'Poziom naładowania podłączonego urządzenia (słuchawki lewa/prawa, mysz, klawiatura, etui).',
  },
  {
    match: (el) => el.id === 'diskHudBar',
    title: '💾 Dysk SSD / HDD',
    desc: 'Wolna i całkowita przestrzeń na dysku systemowym oraz bufory APFS.',
    hint: 'Kliknij: Zobacz największe katalogi i pliki',
  },
  {
    match: (el) => el.id === 'btnHudCleaner',
    title: '🧹 Szybki Cleaner',
    desc: 'Wykryte śmieci systemowe i pliki tymczasowe gotowe do bezpiecznego usunięcia.',
    hint: 'Kliknij: Otwórz Smart Cleaner',
  },
  {
    match: (el) => el.dataset.killPid,
    title: '✕ Zakończ proces',
    desc: 'Wysyła bezpieczny sygnał zakończenia SIGTERM do wybranego procesu.',
    hint: '<kbd>⌥ Option</kbd> + kliknięcie: Wymuś natychmiastowe zabicie (<kbd>kill -9</kbd>)',
  },
  {
    match: (el) => el.dataset.drillDir,
    title: '📁 Eksploruj folder',
    desc: 'Przejdź w głąb tego katalogu, aby sprawdzić które podfoldery zajmują najwięcej miejsca.',
    hint: 'Kliknij: Otwórz ten katalog w analizatorze',
  },
  {
    match: (el) => el.dataset.revealPath,
    title: '📂 Pokaż w Finderze',
    desc: 'Otwiera systemowe okno Findera i podświetla ten element na dysku.',
    hint: 'Kliknij: Otwórz w Finderze',
  },
  {
    match: (el) => el.id === 'btnHomeCleanRam' || el.id === 'btnCleanRam' || el.id === 'btnCleanRamAlt',
    title: '🧹 Czyszczenie RAM i DNS',
    desc: 'Opróżnia pamięć podręczną DNS (dscacheutil) i instruuje jądro XNU, aby zwolniło nieaktywny RAM.',
    hint: 'Kliknij: Wyczyść pamięć i DNS',
  },
  {
    match: (el) => el.id === 'btnSpeedtest',
    title: '⚡ Test prędkości łącza',
    desc: 'Mierzy rzeczywistą przepustowość pobierania i wysyłania łącząc się z brzegami CDN Cloudflare.',
    hint: 'Kliknij: Uruchom Speedtest',
  },
  {
    match: (el) => el.id === 'btnScanJunk',
    title: '🔍 Skanowanie śmieci',
    desc: 'Sprawdza katalogi pamięci podręcznej Caches, logi deweloperskie i Kosz pod kątem zbędnych plików.',
    hint: 'Kliknij: Rozpocznij skanowanie',
  },
  {
    match: (el) => el.id === 'btnCleanJunk',
    title: '🗑️ Oczyść system',
    desc: 'Trwale usuwa zaznaczone pliki tymczasowe, bufory aplikacji i opróżnia Kosz użytkownika.',
    hint: 'Kliknij: Usuń zaznaczone śmieci',
  },
  {
    match: (el) => el.classList.contains('home-chip') && el.dataset.jump === 'power' && el.querySelector('#homeChipTemp'),
    title: '🌡 Termika Apple Silicon',
    desc: 'Maksymalna temperatura układu scalonego SoC (rdzenie CPU, GPU i silnik Neural Engine).',
    hint: 'Kliknij: Przejdź do sensorów',
  },
  {
    match: (el) => el.classList.contains('home-chip') && el.dataset.jump === 'power' && el.querySelector('#homeChipBatt'),
    title: '🔋 Diagnostyka ogniwa',
    desc: 'Bieżąca kondycja baterii w stosunku do pojemności fabrycznej oraz łączna liczba cykli ładowania.',
    hint: 'Kliknij: Przejdź do zasilania',
  },
  {
    match: (el) => el.classList.contains('home-chip') && el.dataset.jump === 'network',
    title: '⚡ Jakość łącza (Ping)',
    desc: 'Średni czas podróży pakietu sieciowego w ms oraz aktualna prędkość pobierania.',
    hint: 'Kliknij: Przejdź do parametrów sieci',
  },
  {
    match: (el) => el.classList.contains('home-sys-pill') && el.dataset.jump === 'top-cpu',
    title: '📊 Obciążenie systemu (Load)',
    desc: 'Średnia liczba wątków oczekujących na procesor w oknie 1 minuty oraz 5 minut.',
  },
  {
    match: (el) => el.classList.contains('home-sys-pill') && el.dataset.jump === 'top-ram',
    title: '🔄 Pamięć wymiany (Swap)',
    desc: 'Ilość danych przeniesionych tymczasowo z pamięci RAM na szybki dysk SSD.',
  },
  {
    match: (el) => el.classList.contains('home-sys-pill') && el.dataset.jump === 'dev',
    title: '🐳 Środowisko Docker',
    desc: 'Status silnika kontenerów Docker Desktop / OrbStack i pamięć zaalokowana przez kontenery.',
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('.strip-icon.down'),
    title: '↓ Prędkość pobierania',
    desc: 'Aktualna przepustowość danych pobieranych z sieci w czasie rzeczywistym.',
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('.strip-icon.up'),
    title: '↑ Prędkość wysyłania',
    desc: 'Aktualna przepustowość danych wysyłanych do sieci w czasie rzeczywistym.',
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('#stripPing'),
    title: '⚡ Opóźnienie sieci (Ping)',
    desc: 'Czas odpowiedzi pakietu ICMP do najbliższego serwera DNS Cloudflare (1.1.1.1).',
  },
  {
    match: (el) => el.classList.contains('mini-strip-item') && el.querySelector('#stripPortsItem'),
    title: '⇄ Porty sieciowe',
    desc: 'Liczba aktywnych portów TCP nasłuchujących połączeń na Twoim Macu.',
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
        return entry;
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

  tiny.api.on('tooltips-mode', ({ tooltipsEnabled: val }) => {
    setTooltipsEnabled(val);
  });

  tiny.api.on('telemetry', (snap) => {
    renderTelemetry(snap);
  });

  tiny.api.call('setTooltipsState', { enabled: tooltipsEnabled }).catch(() => {});

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
