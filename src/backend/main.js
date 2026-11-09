// TinyMonitor Backend — runs on txiki.js (QuickJS + libuv)
// Collects real-time hardware & network telemetry and pushes updates to the UI.

let prevCpus = null;
let prevNet = null;
let prevProcs = new Map();
let prevProcsAt = 0;
let sessionStartNet = null;
let macmonBinPath = null;
let latestPingMs = null;
let lastPingAt = 0;
let isPinging = false;
let isSpeedtesting = false;
let desktopWidgetMode = true; // true = 'normal' desktop widget, false = 'floating' (Always on Top)
let compactMode = true;       // true = 356x548 widget size, false = 356x760 expanded widget
const iconCache = new Map();
let caffeinateProc = null;
let caffeinateActive = false;
let caffeinatePid = 0;
let latestJunkScan = null;
let lastJunkScanAt = 0;
let isScanningJunk = false;
let latestDiskUsage = null;
let lastDiskUsageAt = 0;
let isScanningDiskUsage = false;
let currentDiskUsagePath = '';
let tooltipsEnabled = true;
const caseBatteryCache = new Map();

// Smart Alerts state
const alertCooldowns = new Map();
let highTempSec = 0;
let pingFailStreak = 0;
let wasOffline = false;
let prevBattPct = null;
let alertedBatt15 = false;
let alertedBatt10 = false;
let alertedBatt80 = false;

function readCpuUsage(cpuMeta) {
  const cpus = tjs.system.cpus || [];
  let totalUser = 0;
  let totalSys = 0;
  let totalIdle = 0;
  let totalAll = 0;

  const coreLoads = cpus.map((cpu, i) => {
    const t = cpu.times;
    const user = (t.user || 0) + (t.nice || 0);
    const sys = (t.sys || 0) + (t.irq || 0);
    const idle = t.idle || 0;
    const total = user + sys + idle;

    let dUser = user;
    let dSys = sys;
    let dIdle = idle;
    let dTotal = total;

    if (prevCpus && prevCpus[i]) {
      const p = prevCpus[i];
      dUser = Math.max(0, user - p.user);
      dSys = Math.max(0, sys - p.sys);
      dIdle = Math.max(0, idle - p.idle);
      dTotal = dUser + dSys + dIdle;
    }

    totalUser += dUser;
    totalSys += dSys;
    totalIdle += dIdle;
    totalAll += dTotal;

    const pct = dTotal > 0 ? Math.min(100, Math.max(0, Math.round(((dUser + dSys) / dTotal) * 100))) : 0;
    const eCores = cpuMeta?.eCores || 0;
    const pCores = cpuMeta?.pCores || 0;
    let label = `C${i + 1}`;
    let coreType = 'C';
    if (eCores > 0 && pCores > 0 && eCores + pCores === cpus.length) {
      if (i < eCores) {
        coreType = 'E';
        label = `E${i + 1}`;
      } else {
        coreType = 'P';
        label = `P${i - eCores + 1}`;
      }
    }
    return { index: i, label, type: coreType, percent: pct };
  });

  prevCpus = cpus.map((cpu) => {
    const t = cpu.times;
    return {
      user: (t.user || 0) + (t.nice || 0),
      sys: (t.sys || 0) + (t.irq || 0),
      idle: t.idle || 0,
    };
  });

  const totalPct = totalAll > 0 ? Math.min(100, Math.max(0, Math.round(((totalUser + totalSys) / totalAll) * 1000) / 10)) : 0;
  const userPct = totalAll > 0 ? Math.min(100, Math.max(0, Math.round((totalUser / totalAll) * 1000) / 10)) : 0;
  const sysPct = totalAll > 0 ? Math.min(100, Math.max(0, Math.round((totalSys / totalAll) * 1000) / 10)) : 0;

  return {
    model: cpuMeta?.brand || (cpus[0] ? cpus[0].model : 'Apple Silicon'),
    hwModel: cpuMeta?.hwModel || 'Mac',
    coreCount: cpus.length,
    pCores: cpuMeta?.pCores || 0,
    eCores: cpuMeta?.eCores || 0,
    totalPercent: totalPct,
    userPercent: userPct,
    sysPercent: sysPct,
    idlePercent: Math.max(0, Math.round((100 - totalPct) * 10) / 10),
    loadAvg: tjs.system.loadAvg || [0, 0, 0],
    uptime: Math.floor(tjs.system.uptime || 0),
    cores: coreLoads,
  };
}

async function resolveMacmonPath(app) {
  if (macmonBinPath) return macmonBinPath;
  try {
    const paths = await app.paths();
    if (paths && paths.executables) {
      const candidate = paths.executables + '/macmon';
      try {
        await tjs.stat(candidate);
        macmonBinPath = candidate;
        return macmonBinPath;
      } catch (_) {}
    }
  } catch (_) {}

  const devCandidate = tjs.cwd + '/executables/macmon';
  try {
    await tjs.stat(devCandidate);
    macmonBinPath = devCandidate;
    return macmonBinPath;
  } catch (_) {}

  return null;
}

async function runMacmon(app) {
  const bin = await resolveMacmonPath(app);
  if (!bin) return null;
  try {
    const proc = tjs.spawn([bin], { stdout: 'pipe', stderr: 'ignore' });
    const text = proc.stdout ? await proc.stdout.text() : '';
    await proc.wait();
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function runJunkScanOnce(app) {
  if (isScanningJunk) return latestJunkScan;
  isScanningJunk = true;
  try {
    const bin = await resolveMacmonPath(app);
    if (!bin) return latestJunkScan;
    const proc = tjs.spawn([bin, '--scan-junk'], { stdout: 'pipe', stderr: 'ignore' });
    const text = proc.stdout ? await proc.stdout.text() : '';
    await proc.wait();
    if (text) {
      latestJunkScan = JSON.parse(text);
      lastJunkScanAt = Date.now();
    }
  } catch (_) {} finally {
    isScanningJunk = false;
  }
  return latestJunkScan;
}

async function runDiskUsageScanOnce(app, targetPath = '', force = false) {
  if (isScanningDiskUsage && !force) return latestDiskUsage;
  isScanningDiskUsage = true;
  try {
    const bin = await resolveMacmonPath(app);
    if (!bin) return latestDiskUsage;
    const args = targetPath ? [bin, '--scan-disk', String(targetPath)] : [bin, '--scan-disk'];
    const proc = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
    const text = proc.stdout ? await proc.stdout.text() : '';
    await proc.wait();
    if (text) {
      latestDiskUsage = JSON.parse(text);
      lastDiskUsageAt = Date.now();
    }
  } catch (_) {} finally {
    isScanningDiskUsage = false;
  }
  return latestDiskUsage;
}

async function resolveMissingIcons(paths, app) {
  const missing = [];
  const seen = new Set();
  for (const p of paths) {
    if (p && !iconCache.has(p) && !seen.has(p)) {
      if (!p.startsWith('/Applications') && !p.startsWith('/System')) {
        iconCache.set(p, null);
        continue;
      }
      seen.add(p);
      missing.push(p);
      if (missing.length >= 16) break;
    }
  }
  if (missing.length === 0) return;

  const bin = await resolveMacmonPath(app);
  if (!bin) return;
  try {
    const proc = tjs.spawn([bin, '--icons', ...missing], { stdout: 'pipe', stderr: 'ignore' });
    const text = proc.stdout ? await proc.stdout.text() : '';
    await proc.wait();
    if (text) {
      const parsed = JSON.parse(text);
      for (const m of missing) {
        iconCache.set(m, parsed?.[m] || null);
      }
    }
  } catch (_) {
    for (const m of missing) {
      if (!iconCache.has(m)) iconCache.set(m, null);
    }
  }
}

function isKnownDevPort(port) {
  if (port >= 3000 && port <= 9999) return true;
  const known = new Set([80, 443, 1433, 3306, 4000, 4200, 5000, 5173, 5174, 5432, 6379, 8000, 8080, 8443, 8888, 9000, 11434, 27017]);
  return known.has(port);
}

async function measurePingOnce() {
  if (isPinging) return;
  isPinging = true;
  try {
    const t0 = Date.now();
    const sock = await tjs.connect('tcp', '1.1.1.1', 53);
    const rtt = Date.now() - t0;
    try { sock.close(); } catch (_) {}
    if (rtt >= 1 && rtt < 5000) {
      latestPingMs = rtt;
      pingFailStreak = 0;
    }
  } catch (_) {
    try {
      const proc = tjs.spawn(['/sbin/ping', '-c', '1', '-W', '1000', '1.1.1.1'], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const out = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      const m = out.match(/time=([0-9.]+)\s*ms/);
      if (m) {
        latestPingMs = Math.round(parseFloat(m[1]) * 10) / 10;
        pingFailStreak = 0;
      } else {
        pingFailStreak++;
        if (pingFailStreak >= 2) latestPingMs = null;
      }
    } catch (__) {
      pingFailStreak++;
      if (pingFailStreak >= 2) latestPingMs = null;
    }
  } finally {
    lastPingAt = Date.now();
    isPinging = false;
  }
}

function computeWifiQuality(rssi, noise) {
  if (typeof rssi !== 'number' || rssi === 0 || rssi < -110) {
    return { qualityPercent: 0, bars: 0, label: 'Brak sygnału' };
  }
  const qualityPercent = Math.max(0, Math.min(100, Math.round(2 * (rssi + 100))));
  let bars = 1;
  let label = 'Słaba';
  if (rssi >= -55) {
    bars = 5;
    label = 'Doskonała';
  } else if (rssi >= -65) {
    bars = 4;
    label = 'Bardzo dobra';
  } else if (rssi >= -72) {
    bars = 3;
    label = 'Dobra';
  } else if (rssi >= -80) {
    bars = 2;
    label = 'Średnia';
  }
  return { qualityPercent, bars, label };
}

async function collectTelemetry(app) {
  const now = Date.now();
  if (now - lastPingAt > 4000 && !isPinging) {
    measurePingOnce();
  }

  const [nativeData, sysBatt, sysWifi] = await Promise.all([
    runMacmon(app),
    app.system.battery().catch(() => null),
    app.system.wifi().catch(() => null),
  ]);

  const cpu = readCpuUsage(nativeData?.cpuMeta);

  // Memory
  const memRaw = nativeData?.memory || {
    total: 8589934592,
    used: 0,
    app: 0,
    wired: 0,
    compressed: 0,
    cached: 0,
    free: 8589934592,
    swapTotal: 0,
    swapUsed: 0,
    pressureLevel: 1,
  };
  const memPercent = memRaw.total > 0 ? Math.min(100, Math.round((memRaw.used / memRaw.total) * 1000) / 10) : 0;
  const memory = {
    ...memRaw,
    percent: memPercent,
    topProcesses: [],
  };

  // Top 10 Processes by CPU & RAM (from libproc rusage_info_v4)
  const rawProcs = Array.isArray(nativeData?.processes) ? nativeData.processes : [];
  const nextProcsMap = new Map();
  const dtProcsMs = prevProcsAt > 0 ? Math.max(100, now - prevProcsAt) : 0;
  const dtProcsNs = dtProcsMs * 1_000_000;
  const enrichedProcs = [];

  for (const p of rawProcs) {
    if (!p || !p.pid) continue;
    const cpuNs = Number(p.cpuNs) || 0;
    const memBytes = Number(p.mem) || 0;
    nextProcsMap.set(p.pid, cpuNs);

    let cpuPct = 0;
    if (dtProcsNs > 0 && prevProcs.has(p.pid)) {
      const prevNs = prevProcs.get(p.pid);
      const deltaNs = Math.max(0, cpuNs - prevNs);
      cpuPct = Math.round(((deltaNs / dtProcsNs) * 100) * 10) / 10;
    }

    const memPct = memRaw.total > 0 ? Math.round(((memBytes / memRaw.total) * 100) * 10) / 10 : 0;
    const iconPath = p.appPath || p.binPath || '';
    enrichedProcs.push({
      pid: p.pid,
      name: p.name || `pid-${p.pid}`,
      appPath: p.appPath || '',
      iconPath,
      memBytes,
      memPercent: memPct,
      cpuPercent: cpuPct,
      cpuNs,
    });
  }
  prevProcs = nextProcsMap;
  prevProcsAt = now;

  const topCpuRaw = [...enrichedProcs]
    .sort((a, b) => (b.cpuPercent - a.cpuPercent) || (b.cpuNs - a.cpuNs) || (b.memBytes - a.memBytes))
    .slice(0, 10);

  const topRamRaw = [...enrichedProcs]
    .sort((a, b) => (b.memBytes - a.memBytes) || (b.cpuPercent - a.cpuPercent))
    .slice(0, 10);

  const rawPorts = Array.isArray(nativeData?.ports) ? nativeData.ports : [];
  const sortedPorts = [...rawPorts]
    .map((pt) => {
      const portNum = Number(pt.port) || 0;
      const isDevPort = isKnownDevPort(portNum);
      return {
        port: portNum,
        pid: Number(pt.pid) || 0,
        name: pt.name || 'proces',
        appPath: pt.appPath || '',
        iconPath: pt.appPath || '',
        address: pt.address || '*',
        memBytes: Number(pt.mem) || 0,
        isDevPort,
      };
    })
    .sort((a, b) => (Number(b.isDevPort) - Number(a.isDevPort)) || (a.port - b.port));

  // Batch-resolve any missing native macOS icons for visible top processes & ports
  const iconPathsToResolve = [
    ...topCpuRaw.map((p) => p.iconPath),
    ...topRamRaw.map((p) => p.iconPath),
    ...sortedPorts.map((p) => p.iconPath),
  ];
  await resolveMissingIcons(iconPathsToResolve, app);

  cpu.topProcesses = topCpuRaw.map((p, idx) => ({
    rank: idx + 1,
    pid: p.pid,
    name: p.name,
    icon: iconCache.get(p.iconPath) || null,
    cpuPercent: p.cpuPercent,
    memBytes: p.memBytes,
    memPercent: p.memPercent,
  }));

  memory.topProcesses = topRamRaw.map((p, idx) => ({
    rank: idx + 1,
    pid: p.pid,
    name: p.name,
    icon: iconCache.get(p.iconPath) || null,
    memBytes: p.memBytes,
    memPercent: p.memPercent,
    cpuPercent: p.cpuPercent,
  }));

  const dev = {
    ports: sortedPorts.map((pt) => ({
      port: pt.port,
      pid: pt.pid,
      name: pt.name,
      address: pt.address,
      memBytes: pt.memBytes,
      isDevPort: pt.isDevPort,
      icon: iconCache.get(pt.iconPath) || null,
    })),
    docker: {
      running: Boolean(nativeData?.docker?.running),
      memoryBytes: Number(nativeData?.docker?.memoryBytes || 0),
      engine: nativeData?.docker?.engine || 'Docker',
    },
  };

  // Network throughput
  const netRaw = nativeData?.network || { rxBytes: 0, txBytes: 0, interface: 'en0', ip: '—' };
  let rxBps = 0;
  let txBps = 0;
  if (!sessionStartNet && netRaw.rxBytes > 0) {
    sessionStartNet = { rxBytes: netRaw.rxBytes, txBytes: netRaw.txBytes };
  }
  if (prevNet && now > prevNet.time) {
    const dtSec = (now - prevNet.time) / 1000;
    if (dtSec > 0.1) {
      const dRx = netRaw.rxBytes >= prevNet.rxBytes ? netRaw.rxBytes - prevNet.rxBytes : 0;
      const dTx = netRaw.txBytes >= prevNet.txBytes ? netRaw.txBytes - prevNet.txBytes : 0;
      rxBps = Math.round(dRx / dtSec);
      txBps = Math.round(dTx / dtSec);
    }
  }
  prevNet = {
    rxBytes: netRaw.rxBytes,
    txBytes: netRaw.txBytes,
    time: now,
  };

  const network = {
    interface: netRaw.interface || 'en0',
    ip: netRaw.ip || '—',
    rxBytesPerSec: rxBps,
    txBytesPerSec: txBps,
    rxMbps: Math.round(((rxBps * 8) / 1_000_000) * 100) / 100,
    txMbps: Math.round(((txBps * 8) / 1_000_000) * 100) / 100,
    totalRxBytes: netRaw.rxBytes,
    totalTxBytes: netRaw.txBytes,
    sessionRxBytes: sessionStartNet ? Math.max(0, netRaw.rxBytes - sessionStartNet.rxBytes) : 0,
    sessionTxBytes: sessionStartNet ? Math.max(0, netRaw.txBytes - sessionStartNet.txBytes) : 0,
    pingMs: latestPingMs,
  };

  // Wi-Fi
  const wExtra = nativeData?.wifiExtra || {};
  const rssi = typeof sysWifi?.rssi === 'number' && sysWifi.rssi !== 0 ? sysWifi.rssi : (wExtra.rssi ?? 0);
  const noise = typeof sysWifi?.noise === 'number' && sysWifi.noise !== 0 ? sysWifi.noise : (wExtra.noise ?? -95);
  const txRate = typeof sysWifi?.txRate === 'number' && sysWifi.txRate > 0 ? sysWifi.txRate : (wExtra.txRate ?? 0);
  const ssid = sysWifi?.ssid || wExtra.ssid || null;
  const snr = rssi !== 0 ? rssi - noise : 0;
  const { qualityPercent, bars, label } = computeWifiQuality(rssi, noise);

  const wifi = {
    ssid,
    bssid: sysWifi?.bssid || null,
    interface: wExtra.interface || netRaw.interface || 'en0',
    rssi,
    noise,
    snr,
    txRate,
    channel: wExtra.channel || 0,
    band: wExtra.band || '—',
    widthMHz: wExtra.widthMHz || 0,
    powerOn: wExtra.powerOn !== false,
    qualityPercent,
    bars,
    label,
  };

  // Battery
  const bExtra = nativeData?.batteryExtra || {};
  const battery = {
    percent: sysBatt?.percent ?? 100,
    charging: sysBatt?.charging ?? false,
    plugged: sysBatt?.plugged ?? false,
    minutesRemaining: sysBatt?.minutesRemaining ?? null,
    cycleCount: bExtra.cycleCount ?? 0,
    healthPercent: bExtra.healthPercent ?? 100,
    designCapacity: bExtra.designCapacity ?? 0,
    nominalCapacity: bExtra.nominalCapacity ?? 0,
    voltageV: bExtra.voltageV ?? 0,
    amperageA: bExtra.amperageA ?? 0,
    systemLoadWatts: bExtra.systemLoadWatts ?? 0,
    powerInWatts: bExtra.powerInWatts ?? 0,
    adapterWatts: bExtra.adapterWatts ?? 0,
  };

  // GPU & Temps
  const gpu = nativeData?.gpu || {
    deviceUtilization: 0,
    rendererUtilization: 0,
    tilerUtilization: 0,
    vramUsed: 0,
    vramAlloc: 0,
    model: cpu.model,
  };

  const temps = nativeData?.temps || {
    cpu: 0,
    pCore: 0,
    eCore: 0,
    gpu: 0,
    soc: 0,
    maxDie: 0,
    ssd: 0,
    battery: 0,
    thermalState: 0,
  };

  // Disk
  let disk = nativeData?.disk || null;
  if (!disk) {
    try {
      const st = await tjs.statFs('/');
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      disk = {
        name: 'Macintosh HD',
        total,
        free,
        freeStrict: free,
        used: Math.max(0, total - free),
      };
    } catch (_) {
      disk = { name: 'Macintosh HD', total: 0, free: 0, freeStrict: 0, used: 0 };
    }
  }
  disk.percent = disk.total > 0 ? Math.min(100, Math.round((disk.used / disk.total) * 1000) / 10) : 0;

  // Caffeinate & Bluetooth devices
  if (nativeData?.caffeinate) {
    caffeinateActive = Boolean(nativeData.caffeinate.active);
    caffeinatePid = Number(nativeData.caffeinate.pid) || 0;
  }
  const rawBt = Array.isArray(nativeData?.bluetooth) ? nativeData.bluetooth : [];
  const connectedBases = new Map();
  const hasCaseForBase = new Set();
  for (const item of rawBt) {
    const base = item.baseName || item.name;
    if (!base) continue;
    if (item.part === 'case') {
      hasCaseForBase.add(base);
      caseBatteryCache.set(base, { ...item, cachedAt: now });
    } else if (item.part === 'left' || item.part === 'right') {
      connectedBases.set(base, item);
    }
  }
  const bluetooth = [...rawBt];
  for (const [base, sampleBud] of connectedBases.entries()) {
    if (!hasCaseForBase.has(base)) {
      const cachedCase = caseBatteryCache.get(base);
      bluetooth.push(
        cachedCase
          ? { ...cachedCase, connected: true }
          : {
              name: `${base} — Etui (Case)`,
              baseName: base,
              part: 'case',
              hfpShared: true,
              sortOrder: 3,
              connected: true,
              charging: false,
              percent: sampleBud.percent,
              kind: 'case',
            }
      );
    }
  }

  if (!latestJunkScan || now - lastJunkScanAt > 45_000) {
    runJunkScanOnce(app).catch(() => {});
  }

  return {
    timestamp: now,
    host: tjs.hostName || 'Mac',
    user: tjs.system.userInfo?.userName || 'user',
    desktopWidgetMode,
    compactMode,
    caffeinateActive,
    cpu,
    memory,
    network,
    wifi,
    gpu,
    temps,
    battery,
    bluetooth,
    disk,
    junk: latestJunkScan,
    diskUsage: latestDiskUsage,
    dev,
  };
}

function canSendAlert(key, cooldownMs = 300_000) {
  const now = Date.now();
  const prev = alertCooldowns.get(key) || 0;
  if (now - prev >= cooldownMs) {
    alertCooldowns.set(key, now);
    return true;
  }
  return false;
}

function sendSmartNotification(app, title, body) {
  try {
    app.notify(title, body);
  } catch (_) {}
}

function checkSmartAlerts(snapshot, app) {
  if (!snapshot) return;

  // 1. High CPU / GPU Temperature (> 85°C for >= 30s)
  const maxTemp = Math.max(snapshot.temps?.cpu || 0, snapshot.temps?.gpu || 0, snapshot.temps?.maxDie || 0);
  if (maxTemp >= 85) {
    highTempSec++;
    if (highTempSec >= 30 && canSendAlert('high-temp', 300_000)) {
      sendSmartNotification(
        app,
        '🔥 Wysoka temperatura układu!',
        `Temperatura CPU/GPU wynosi ${maxTemp.toFixed(1)}°C od ponad 30 sekund.`
      );
    }
  } else {
    highTempSec = 0;
  }

  // 2. Memory Pressure / Swap / Memory Leak (> 5 GB single process + high usage)
  const pressure = snapshot.memory?.pressureLevel || 1;
  const topRamProc = snapshot.memory?.topProcesses?.[0];
  const fiveGB = 5 * 1024 * 1024 * 1024;
  if (pressure >= 4 && canSendAlert('mem-pressure', 300_000)) {
    sendSmartNotification(
      app,
      '⚠️ Krytyczne obciążenie pamięci RAM',
      `System intensywnie korzysta z pamięci Swap (${((snapshot.memory?.swapUsed || 0) / 1e9).toFixed(1)} GB).`
    );
  } else if (topRamProc && topRamProc.memBytes >= fiveGB && (snapshot.memory?.percent || 0) >= 85 && canSendAlert(`mem-leak-${topRamProc.pid}`, 600_000)) {
    sendSmartNotification(
      app,
      `⚠️ Wysokie zużycie RAM: ${topRamProc.name}`,
      `Proces ${topRamProc.name} (PID ${topRamProc.pid}) zajmuje ${(topRamProc.memBytes / (1024 ** 3)).toFixed(1)} GB RAM.`
    );
  }

  // 3. Battery thresholds (< 15%, <= 10%, >= 80% charged)
  const bPct = snapshot.battery?.percent ?? 100;
  const charging = Boolean(snapshot.battery?.charging || snapshot.battery?.plugged);
  if (!charging) {
    alertedBatt80 = false;
    if (bPct <= 10 && !alertedBatt10) {
      alertedBatt10 = true;
      alertedBatt15 = true;
      sendSmartNotification(
        app,
        '🚨 Krytyczny poziom baterii (≤ 10%)!',
        `Pozostało tylko ${bPct}% baterii. Widżet przełączył się w tryb ostrzegawczy.`
      );
    } else if (bPct <= 15 && bPct > 10 && !alertedBatt15) {
      alertedBatt15 = true;
      sendSmartNotification(
        app,
        '🔋 Niski poziom baterii (15%)',
        `Poziom baterii spadł do ${bPct}%. Warto podłączyć zasilacz.`
      );
    }
  } else {
    if (bPct > 15) alertedBatt15 = false;
    if (bPct > 10) alertedBatt10 = false;
    if (prevBattPct !== null && prevBattPct < 80 && bPct >= 80 && !alertedBatt80) {
      alertedBatt80 = true;
      sendSmartNotification(
        app,
        '⚡ Bateria naładowana w 80%',
        'Osiągnięto 80% naładowania — optymalny poziom dla długiej żywotności ogniwa.'
      );
    }
  }
  prevBattPct = bPct;

  // 4. Internet connectivity (Wi-Fi / Ping loss)
  const wifiOff = (snapshot.wifi?.bars || 0) === 0 && (!snapshot.network?.ip || snapshot.network.ip === '—');
  if ((wifiOff || pingFailStreak >= 3) && !wasOffline) {
    wasOffline = true;
    if (canSendAlert('net-lost', 60_000)) {
      sendSmartNotification(
        app,
        '📡 Utracono połączenie z internetem',
        'Brak odpowiedzi z sieci (Ping / Wi-Fi niedostępne).'
      );
    }
  } else if (!wifiOff && pingFailStreak === 0 && latestPingMs !== null && wasOffline) {
    wasOffline = false;
    sendSmartNotification(
      app,
      '✅ Połączenie z internetem przywrócone',
      `Sieć znów odpowiada (Ping: ${latestPingMs} ms).`
    );
  }
}

function updateTrayMenu(app, snapshot) {
  try {
    const cpuPct = Math.round(snapshot?.cpu?.totalPercent || 0);
    const ramPct = Math.round(snapshot?.memory?.percent || 0);
    app.tray.set({
      title: `CPU ${cpuPct}% · RAM ${ramPct}%`,
      icon: 'sf:gauge.with.dots.needle.67percent',
      tooltip: 'Latata.Hub — macOS System Monitor',
      menu: [
        { id: 'show', label: 'Pokaż Latata.Hub' },
        {
          id: 'toggle-layer',
          label: 'Zawsze na wierzchu (Przypnij / Always on Top)',
          checked: !desktopWidgetMode,
        },
        {
          id: 'toggle-compact',
          label: 'Rozmiar widżetu (356×548)',
          checked: compactMode,
        },
        {
          id: 'toggle-tooltips',
          label: tooltipsEnabled ? 'Wskazówki (Tooltipy): ON' : 'Wskazówki (Tooltipy): OFF',
          checked: tooltipsEnabled,
        },
        { separator: true },
        { id: 'quit', label: 'Zakończ Latata.Hub' },
      ],
    });
  } catch (_) {}
}

export const api = {
  async getSnapshot(_params, app) {
    return await collectTelemetry(app);
  },

  async toggleWidgetLayer({ value } = {}, app) {
    desktopWidgetMode = typeof value === 'boolean' ? value : !desktopWidgetMode;
    if (desktopWidgetMode) {
      await app.win.setAlwaysOnTop(false);
      await app.win.setLevel('normal');
    } else {
      await app.win.setLevel('floating');
      await app.win.setAlwaysOnTop(true);
    }
    return { desktopWidgetMode };
  },

  async toggleCompactMode({ value } = {}, app) {
    compactMode = typeof value === 'boolean' ? value : !compactMode;
    if (compactMode) {
      await app.win.setSize(356, 548);
    } else {
      await app.win.setSize(356, 760);
    }
    return { compactMode };
  },

  async setTooltipsState({ enabled } = {}, app) {
    tooltipsEnabled = typeof enabled === 'boolean' ? enabled : !tooltipsEnabled;
    return { tooltipsEnabled };
  },

  async snapLeft(_params, app) {
    await app.win.setPosition(16, 220);
    return { ok: true };
  },

  async toggleCaffeinate({ value } = {}, app) {
    const target = typeof value === 'boolean' ? value : !caffeinateActive;
    const bin = await resolveMacmonPath(app);
    if (target) {
      if (!caffeinateActive) {
        try {
          caffeinateProc = tjs.spawn(['/usr/bin/caffeinate', '-di'], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          caffeinateActive = true;
        } catch (_) {}
      }
    } else {
      try {
        if (caffeinateProc) {
          caffeinateProc.kill();
          caffeinateProc = null;
        }
      } catch (_) {}
      if (caffeinatePid > 1 && bin) {
        try {
          const p = tjs.spawn([bin, '--kill', String(caffeinatePid), '15'], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          await p.wait();
        } catch (_) {}
      }
      caffeinateActive = false;
      caffeinatePid = 0;
    }
    return { caffeinateActive };
  },

  async cleanRamAndDns(_params, app) {
    const bin = await resolveMacmonPath(app);
    const beforeData = await runMacmon(app);
    const beforeFree = Number(beforeData?.memory?.free || 0);
    const beforeCached = Number(beforeData?.memory?.cached || 0);

    if (bin) {
      try {
        const proc = tjs.spawn([bin, '--flush-cache'], {
          stdout: 'pipe',
          stderr: 'ignore',
        });
        await proc.wait();
      } catch (_) {}
    }

    const afterSnap = await collectTelemetry(app);
    app.push('telemetry', afterSnap);
    const afterFree = Number(afterSnap?.memory?.free || beforeFree);
    const deltaBytes = Math.max(0, afterFree - beforeFree);
    return {
      ok: true,
      freedBytes: deltaBytes,
      cachedBytes: beforeCached,
      freeAfterBytes: afterFree,
    };
  },

  async scanSystemJunk(_params, app) {
    const scan = await runJunkScanOnce(app);
    return scan || { totalBytes: 0, categories: [] };
  },

  async scanDiskUsage({ path = '' } = {}, app) {
    currentDiskUsagePath = path ? String(path) : '';
    const scan = await runDiskUsageScanOnce(app, currentDiskUsagePath, true);
    return scan || { ok: false, topDirs: [], topFiles: [] };
  },

  async revealInFinder({ path = '' } = {}, app) {
    if (!path) return { ok: false };
    const bin = await resolveMacmonPath(app);
    if (!bin) return { ok: false };
    try {
      const proc = tjs.spawn([bin, '--reveal', String(path)], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const text = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      return text ? JSON.parse(text) : { ok: true };
    } catch (_) {
      return { ok: false };
    }
  },

  async cleanSystemJunk({ categories } = {}, app) {
    const bin = await resolveMacmonPath(app);
    if (!bin) {
      return { ok: false, error: 'Brak binarki macmon' };
    }
    const cats = Array.isArray(categories) && categories.length > 0
      ? categories.map((c) => String(c))
      : ['caches', 'logs', 'trash', 'dev', 'temp'];
    try {
      const proc = tjs.spawn([bin, '--clean-junk', ...cats], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const text = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      const parsed = text ? JSON.parse(text) : { ok: false };
      if (parsed?.scan) {
        latestJunkScan = parsed.scan;
        lastJunkScanAt = Date.now();
      }
      const afterSnap = await collectTelemetry(app);
      app.push('telemetry', afterSnap);
      return parsed;
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  async killProcess({ pid, force = false } = {}, app) {
    const targetPid = Number(pid) || 0;
    if (targetPid <= 1) {
      return { ok: false, error: 'Nieprawidłowy PID' };
    }
    const bin = await resolveMacmonPath(app);
    if (!bin) {
      return { ok: false, error: 'Brak binarki macmon' };
    }
    try {
      const sig = force ? '9' : '15';
      const proc = tjs.spawn([bin, '--kill', String(targetPid), sig], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const out = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      const parsed = out ? JSON.parse(out) : { ok: false };
      setTimeout(async () => {
        try {
          const snap = await collectTelemetry(app);
          app.push('telemetry', snap);
        } catch (_) {}
      }, 180);
      return parsed;
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  async runSpeedtest(_params, app) {
    if (isSpeedtesting) {
      return { busy: true };
    }
    isSpeedtesting = true;
    try {
      app.push('speedtest-progress', { phase: 'ping', progress: 10, message: 'Pomiar opóźnienia (Ping)...' });
      const tPing0 = Date.now();
      await fetch('https://speed.cloudflare.com/__down?bytes=0', { cache: 'no-store' });
      const latencyMs = Math.max(1, Date.now() - tPing0);
      latestPingMs = latencyMs;

      app.push('speedtest-progress', {
        phase: 'download',
        progress: 25,
        latencyMs,
        message: 'Pobieranie próbki testowej (15 MB)...',
      });

      const targetBytes = 15_000_000;
      const tStart = Date.now();
      const resp = await fetch(`https://speed.cloudflare.com/__down?bytes=${targetBytes}`, {
        cache: 'no-store',
      });
      if (!resp.ok || !resp.body) {
        throw new Error('HTTP ' + resp.status);
      }

      const reader = resp.body.getReader();
      let received = 0;
      let lastPush = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          const now = Date.now();
          if (now - lastPush > 140) {
            const elapsedSec = Math.max(0.05, (now - tStart) / 1000);
            const currentMbps = Math.round(((received * 8) / elapsedSec / 1_000_000) * 10) / 10;
            const pct = Math.min(95, Math.round(25 + (received / targetBytes) * 70));
            app.push('speedtest-progress', {
              phase: 'download',
              progress: pct,
              downloadMbps: currentMbps,
              latencyMs,
              message: `Pomiar pobierania: ${currentMbps.toFixed(1)} Mbps...`,
            });
            lastPush = now;
          }
        }
      }

      const totalSec = Math.max(0.05, (Date.now() - tStart) / 1000);
      const finalMbps = Math.round(((received * 8) / totalSec / 1_000_000) * 10) / 10;
      const finalMBps = Math.round((received / totalSec / 1_000_000) * 100) / 100;

      const result = {
        ok: true,
        downloadMbps: finalMbps,
        downloadMBps: finalMBps,
        latencyMs,
        bytes: received,
        durationSec: Math.round(totalSec * 10) / 10,
      };
      app.push('speedtest-progress', {
        phase: 'done',
        progress: 100,
        ...result,
        message: `Wynik: ${finalMbps.toFixed(1)} Mbps (${finalMBps.toFixed(1)} MB/s) • Ping ${latencyMs} ms`,
      });
      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      app.push('speedtest-progress', {
        phase: 'error',
        progress: 0,
        message: 'Błąd testu prędkości: ' + msg,
      });
      return { ok: false, error: msg };
    } finally {
      isSpeedtesting = false;
    }
  },
};

export async function init(app) {
  try {
    await app.win.setMinSize(356, 315);
    await app.win.setSize(356, 548);
    await app.win.setAlwaysOnTop(false);
    await app.win.setLevel('normal');
    await app.win.setAllSpaces(true);
  } catch (_) {}

  // Ensure application Dock & system icon is set
  try {
    const paths = typeof app.paths === 'function' ? await app.paths() : null;
    const candidates = [
      paths?.resources ? `${paths.resources}/icon.png` : null,
      'assets/icon.png',
    ].filter(Boolean);
    for (const c of candidates) {
      if (await tjs.stat(c).then(() => true).catch(() => false)) {
        if (typeof app.icon === 'function') {
          app.icon(c);
        }
        break;
      }
    }
  } catch (_) {}

  await runJunkScanOnce(app).catch(() => {});

  let tickCount = 0;
  const runTick = async () => {
    try {
      const snapshot = await collectTelemetry(app);
      app.push('telemetry', snapshot);
      checkSmartAlerts(snapshot, app);
      if (tickCount % 2 === 0) {
        updateTrayMenu(app, snapshot);
      }
      tickCount++;
    } catch (_) {}
  };

  await runTick();
  setInterval(runTick, 1000);
}

export async function onTray(id, app) {
  if (!id || id === 'show') {
    await app.win.show();
  } else if (id === 'toggle-layer') {
    desktopWidgetMode = !desktopWidgetMode;
    if (desktopWidgetMode) {
      await app.win.setAlwaysOnTop(false);
      await app.win.setLevel('normal');
    } else {
      await app.win.setLevel('floating');
      await app.win.setAlwaysOnTop(true);
    }
    app.push('window-mode', { desktopWidgetMode, compactMode });
  } else if (id === 'toggle-compact') {
    compactMode = !compactMode;
    if (compactMode) {
      await app.win.setSize(356, 548);
    } else {
      await app.win.setSize(356, 760);
    }
    app.push('window-mode', { desktopWidgetMode, compactMode });
  } else if (id === 'toggle-tooltips') {
    tooltipsEnabled = !tooltipsEnabled;
    app.push('tooltips-mode', { tooltipsEnabled });
  } else if (id === 'quit') {
    app.quit();
  }
}
