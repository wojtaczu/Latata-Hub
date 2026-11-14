// Latata.Hub Backend — runs on txiki.js (QuickJS + libuv)
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
let latestTelemetrySnapshot = null;
let latestJunkScan = null;
let lastJunkScanAt = 0;
let junkScanPromise = null;
let latestDiskUsage = null;
let lastDiskUsageAt = 0;
const diskUsageInFlight = new Map();
let diskScanSeq = 0;
let currentDiskUsagePath = '';
const VALID_JUNK_CATEGORIES = new Set(['caches', 'logs', 'trash', 'dev', 'temp']);
let tooltipsEnabled = true;
let appLang = 'pl';
let autostartEnabled = false;
let autostartRequiresApproval = false;

function isAllowedUserPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const std = String(rawPath).replace(/\\/g, '/').trim();
  if (!std || std.includes('\0') || std.split('/').includes('..')) {
    return false;
  }
  const home = tjs.env.HOME || '';
  return (
    std === '~' ||
    std.startsWith('~/') ||
    (Boolean(home) && (std === home || std.startsWith(home + '/'))) ||
    std === '/Applications' ||
    std.startsWith('/Applications/') ||
    std === '/Volumes' ||
    std.startsWith('/Volumes/')
  );
}

const SPEEDTEST_PING_TIMEOUT_MS = 5000;
const SPEEDTEST_DOWNLOAD_TIMEOUT_MS = 15000;

function withStageTimeout(workFn, timeoutMs, timeoutMessage = 'TIMEOUT') {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch (_) {}
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => workFn(controller ? controller.signal : undefined)),
    timeoutPromise,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function getActualAppBundlePath() {
  const exe = tjs.exePath || '';
  const idx = exe.indexOf('.app');
  if (idx !== -1) {
    return exe.slice(0, idx + 4);
  }
  // If not running directly from a .app bundle, check standard locations
  const appInApplications = '/Applications/Latata.Hub.app';
  if (await tjs.stat(appInApplications).then(() => true).catch(() => false)) {
    return appInApplications;
  }
  const homeApp = `${tjs.env.HOME || ''}/Applications/Latata.Hub.app`;
  if (await tjs.stat(homeApp).then(() => true).catch(() => false)) {
    return homeApp;
  }
  const cwdDist = `${tjs.cwd()}/dist/Latata.Hub.app`;
  if (await tjs.stat(cwdDist).then(() => true).catch(() => false)) {
    return cwdDist;
  }
  return appInApplications;
}

async function getLaunchAtLogin(app) {
  try {
    if (app?.launchAtLogin?.get) {
      const st = await app.launchAtLogin.get();
      if (st === 'enabled') {
        autostartEnabled = true;
        autostartRequiresApproval = false;
        return { enabled: true, requiresApproval: false, status: 'enabled' };
      }
      if (st === 'requires-approval') {
        autostartEnabled = false;
        autostartRequiresApproval = true;
        return { enabled: false, requiresApproval: true, status: 'requires-approval' };
      }
      if (st === 'disabled') {
        autostartEnabled = false;
        autostartRequiresApproval = false;
        return { enabled: false, requiresApproval: false, status: 'disabled' };
      }
    }
  } catch (_) {}

  // Check System Events login item as fallback
  try {
    const sc = `tell application "System Events" to return (exists (first login item whose name is "Latata.Hub"))`;
    const proc = tjs.spawn(['/usr/bin/osascript', '-e', sc], { stdout: 'pipe', stderr: 'ignore' });
    const text = proc.stdout ? (await proc.stdout.text()).trim() : '';
    await proc.wait();
    if (text === 'true') {
      autostartEnabled = true;
      autostartRequiresApproval = false;
      return { enabled: true, requiresApproval: false, status: 'enabled' };
    }
    if (text === 'false') {
      autostartEnabled = false;
      autostartRequiresApproval = false;
      return { enabled: false, requiresApproval: false, status: 'disabled' };
    }
  } catch (_) {}

  try {
    const val = await app?.store?.get('autostart_enabled');
    if (typeof val === 'boolean') {
      autostartEnabled = val;
      autostartRequiresApproval = false;
      return { enabled: val, requiresApproval: false, status: val ? 'enabled' : 'disabled' };
    }
  } catch (_) {}
  return {
    enabled: autostartEnabled,
    requiresApproval: autostartRequiresApproval,
    status: autostartRequiresApproval ? 'requires-approval' : (autostartEnabled ? 'enabled' : 'disabled'),
  };
}

async function setLaunchAtLogin(app, enabled) {
  const target = Boolean(enabled);
  let statusSet = false;
  let requiresApproval = false;
  let resolvedEnabled = autostartEnabled;

  // 1. Native SMAppService (works when app is packaged and installed in /Applications)
  try {
    if (app?.launchAtLogin?.set) {
      const st = await app.launchAtLogin.set(target);
      if (st === 'enabled') {
        resolvedEnabled = true;
        requiresApproval = false;
        statusSet = true;
      } else if (st === 'requires-approval') {
        resolvedEnabled = false;
        requiresApproval = true;
        statusSet = true;
      } else if (st === 'disabled') {
        resolvedEnabled = false;
        requiresApproval = false;
        statusSet = true;
      }
    }
  } catch (_) {}

  // 2. AppleScript / System Events Login Item (fallback when SMAppService is unavailable or failed)
  if (!statusSet && !app?.launchAtLogin?.disableFallback) {
    try {
      const appPath = await getActualAppBundlePath();
      const safeAppPath = String(appPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (target) {
        const sc = `tell application "System Events"
          try
            delete (every login item whose name is "Latata.Hub")
          end try
          make login item at end with properties {path:"${safeAppPath}", hidden:false, name:"Latata.Hub"}
        end tell`;
        const proc = tjs.spawn(['/usr/bin/osascript', '-e', sc], { stdout: 'ignore', stderr: 'ignore' });
        const st = await proc.wait();
        if (st?.exit_status === 0) {
          statusSet = true;
          resolvedEnabled = true;
        }
      } else {
        const sc = `tell application "System Events"
          try
            delete (every login item whose name is "Latata.Hub")
          end try
        end tell`;
        const proc = tjs.spawn(['/usr/bin/osascript', '-e', sc], { stdout: 'ignore', stderr: 'ignore' });
        const st = await proc.wait();
        if (st?.exit_status === 0) {
          statusSet = true;
          resolvedEnabled = false;
        }
      }
    } catch (_) {}
  }

  if (!statusSet) {
    return {
      ok: false,
      enabled: autostartEnabled,
      requiresApproval: autostartRequiresApproval,
      status: autostartRequiresApproval ? 'requires-approval' : (autostartEnabled ? 'enabled' : 'disabled'),
      error: 'AUTOSTART_FAILED',
    };
  }

  autostartEnabled = resolvedEnabled;
  autostartRequiresApproval = requiresApproval;
  try {
    await app?.store?.set('autostart_enabled', autostartEnabled);
  } catch (_) {}
  return {
    ok: true,
    enabled: autostartEnabled,
    requiresApproval: autostartRequiresApproval,
    status: autostartRequiresApproval ? 'requires-approval' : (autostartEnabled ? 'enabled' : 'disabled'),
  };
}
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
    const paths = typeof app?.paths === 'function' ? await app.paths() : null;
    if (paths && paths.executables) {
      const candidate = paths.executables + '/macmon';
      try {
        await tjs.stat(candidate);
        macmonBinPath = candidate;
        return macmonBinPath;
      } catch (_) {}
    }
  } catch (_) {}

  const cwd = typeof tjs.cwd === 'function' ? tjs.cwd() : (tjs.cwd || '');
  const devCandidate = cwd + '/executables/macmon';
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
  if (junkScanPromise) return junkScanPromise;
  junkScanPromise = (async () => {
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
    } catch (_) {}
    return latestJunkScan;
  })().finally(() => {
    junkScanPromise = null;
  });
  return junkScanPromise;
}

async function runDiskUsageScanOnce(app, targetPath = '', force = false) {
  const key = String(targetPath || '');
  if (diskUsageInFlight.has(key)) {
    return diskUsageInFlight.get(key);
  }
  if (diskUsageInFlight.size > 0 && !force) {
    return latestDiskUsage;
  }
  const seq = ++diskScanSeq;
  const p = (async () => {
    let parsed = null;
    try {
      const bin = await resolveMacmonPath(app);
      if (!bin) return latestDiskUsage;
      const args = key ? [bin, '--scan-disk', key] : [bin, '--scan-disk'];
      const proc = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
      const text = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      if (text) {
        parsed = JSON.parse(text);
        if (seq === diskScanSeq) {
          latestDiskUsage = parsed;
          lastDiskUsageAt = Date.now();
        }
      }
    } catch (_) {}
    return parsed || latestDiskUsage;
  })().finally(() => {
    diskUsageInFlight.delete(key);
  });
  diskUsageInFlight.set(key, p);
  return p;
}

async function resolveMissingIcons(paths, app) {
  const missing = [];
  const seen = new Set();
  for (const p of paths) {
    if (p && !iconCache.has(p) && !seen.has(p)) {
      const std = String(p).replace(/\\/g, '/');
      if (std.includes('\0') || std.split('/').includes('..') || (!std.startsWith('/Applications/') && !std.startsWith('/System/') && std !== '/Applications' && std !== '/System')) {
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
    return { qualityPercent: 0, bars: 0, qualityCode: 'none', label: 'Brak sygnału' };
  }
  const qualityPercent = Math.max(0, Math.min(100, Math.round(2 * (rssi + 100))));
  let bars = 1;
  let label = 'Słaba';
  let qualityCode = 'poor';
  if (rssi >= -55) {
    bars = 5;
    label = 'Doskonała';
    qualityCode = 'excellent';
  } else if (rssi >= -65) {
    bars = 4;
    label = 'Bardzo dobra';
    qualityCode = 'very_good';
  } else if (rssi >= -72) {
    bars = 3;
    label = 'Dobra';
    qualityCode = 'good';
  } else if (rssi >= -80) {
    bars = 2;
    label = 'Średnia';
    qualityCode = 'fair';
  }
  return { qualityPercent, bars, qualityCode, label };
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
  const { qualityPercent, bars, qualityCode, label } = computeWifiQuality(rssi, noise);

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
    qualityCode,
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

  const snapshot = {
    timestamp: now,
    host: tjs.hostName || 'Mac',
    user: tjs.system.userInfo?.userName || 'user',
    desktopWidgetMode,
    compactMode,
    caffeinateActive,
    autostart: autostartEnabled,
    autostartRequiresApproval,
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
  latestTelemetrySnapshot = snapshot;
  return snapshot;
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
  // Disabled: background notifications distract the user and on macOS trigger
  // Script Editor file picker when clicked. Latata.Hub stays peaceful and silent.
  return;
}

function checkSmartAlerts(snapshot, app) {
  if (!snapshot) return;
  const isEn = appLang === 'en';

  // 1. High CPU / GPU Temperature (> 85°C for >= 30s)
  const maxTemp = Math.max(snapshot.temps?.cpu || 0, snapshot.temps?.gpu || 0, snapshot.temps?.maxDie || 0);
  if (maxTemp >= 85) {
    highTempSec++;
    if (highTempSec >= 30 && canSendAlert('high-temp', 300_000)) {
      sendSmartNotification(
        app,
        isEn ? '🔥 High System Temperature!' : '🔥 Wysoka temperatura układu!',
        isEn
          ? `CPU/GPU temperature has been ${maxTemp.toFixed(1)}°C for over 30 seconds.`
          : `Temperatura CPU/GPU wynosi ${maxTemp.toFixed(1)}°C od ponad 30 sekund.`
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
      isEn ? '⚠️ Critical Memory Pressure' : '⚠️ Krytyczne obciążenie pamięci RAM',
      isEn
        ? `System is actively using swap space (${((snapshot.memory?.swapUsed || 0) / 1e9).toFixed(1)} GB).`
        : `System intensywnie korzysta z pamięci Swap (${((snapshot.memory?.swapUsed || 0) / 1e9).toFixed(1)} GB).`
    );
  } else if (topRamProc && topRamProc.memBytes >= fiveGB && (snapshot.memory?.percent || 0) >= 85 && canSendAlert(`mem-leak-${topRamProc.pid}`, 600_000)) {
    sendSmartNotification(
      app,
      isEn ? `⚠️ High RAM Usage: ${topRamProc.name}` : `⚠️ Wysokie zużycie RAM: ${topRamProc.name}`,
      isEn
        ? `Process ${topRamProc.name} (PID ${topRamProc.pid}) is using ${(topRamProc.memBytes / (1024 ** 3)).toFixed(1)} GB RAM.`
        : `Proces ${topRamProc.name} (PID ${topRamProc.pid}) zajmuje ${(topRamProc.memBytes / (1024 ** 3)).toFixed(1)} GB RAM.`
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
        isEn ? '🚨 Critical Battery Level (≤ 10%)!' : '🚨 Krytyczny poziom baterii (≤ 10%)!',
        isEn
          ? `Only ${bPct}% battery remaining. Widget switched to alert mode.`
          : `Pozostało tylko ${bPct}% baterii. Widżet przełączył się w tryb ostrzegawczy.`
      );
    } else if (bPct <= 15 && bPct > 10 && !alertedBatt15) {
      alertedBatt15 = true;
      sendSmartNotification(
        app,
        isEn ? '🔋 Low Battery Warning (15%)' : '🔋 Niski poziom baterii (15%)',
        isEn
          ? `Battery level dropped to ${bPct}%. Consider connecting charger.`
          : `Poziom baterii spadł do ${bPct}%. Warto podłączyć zasilacz.`
      );
    }
  } else {
    if (bPct > 15) alertedBatt15 = false;
    if (bPct > 10) alertedBatt10 = false;
    if (prevBattPct !== null && prevBattPct < 80 && bPct >= 80 && !alertedBatt80) {
      alertedBatt80 = true;
      sendSmartNotification(
        app,
        isEn ? '⚡ Battery Charged to 80%' : '⚡ Bateria naładowana w 80%',
        isEn
          ? 'Reached 80% charge — optimal level for battery longevity.'
          : 'Osiągnięto 80% naładowania — optymalny poziom dla długiej żywotności ogniwa.'
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
        isEn ? '📡 Internet Connection Lost' : '📡 Utracono połączenie z internetem',
        isEn
          ? 'No network response (Ping / Wi-Fi unavailable).'
          : 'Brak odpowiedzi z sieci (Ping / Wi-Fi niedostępne).'
      );
    }
  } else if (!wifiOff && pingFailStreak === 0 && latestPingMs !== null && wasOffline) {
    wasOffline = false;
    sendSmartNotification(
      app,
      isEn ? '✅ Internet Connection Restored' : '✅ Połączenie z internetem przywrócone',
      isEn
        ? `Network is reachable again (Ping: ${latestPingMs} ms).`
        : `Sieć znów odpowiada (Ping: ${latestPingMs} ms).`
    );
  }
}

function updateTrayMenu(app, snapshot) {
  try {
    const isEn = appLang === 'en';
    const cpuPct = Math.round(snapshot?.cpu?.totalPercent || 0);
    const ramPct = Math.round(snapshot?.memory?.percent || 0);
    // U+2007 (FIGURE SPACE) has the exact same pixel width as digits (0-9) in macOS SF font.
    // Fixed 2-digit padding prevents menu bar width jumping/jittering every second.
    const cpuStr = String(Math.min(99, Math.max(0, cpuPct))).padStart(2, '\u2007');
    const ramStr = String(Math.min(99, Math.max(0, ramPct))).padStart(2, '\u2007');
    app.tray.set({
      title: `CPU ${cpuStr}% · RAM ${ramStr}%`,
      icon: 'sf:gauge.with.dots.needle.67percent',
      tooltip: 'Latata.Hub — macOS System Monitor',
      menu: [
        { id: 'show', label: isEn ? 'Show Latata.Hub' : 'Pokaż Latata.Hub' },
        {
          id: 'toggle-layer',
          label: isEn ? 'Always on Top (Pin)' : 'Zawsze na wierzchu (Przypnij)',
          checked: !desktopWidgetMode,
        },
        {
          id: 'toggle-compact',
          label: isEn ? 'Widget Size (356×548)' : 'Rozmiar widżetu (356×548)',
          checked: compactMode,
        },
        {
          id: 'toggle-tooltips',
          label: tooltipsEnabled
            ? (isEn ? 'Tooltips: ON' : 'Wskazówki (Tooltipy): ON')
            : (isEn ? 'Tooltips: OFF' : 'Wskazówki (Tooltipy): OFF'),
          checked: tooltipsEnabled,
        },
        {
          id: 'toggle-autostart',
          label: isEn ? 'Launch at Login' : 'Uruchamiaj przy starcie (Autostart)',
          checked: autostartEnabled,
        },
        { separator: true },
        { id: 'quit', label: isEn ? 'Quit Latata.Hub' : 'Zakończ Latata.Hub' },
      ],
    });
  } catch (_) {}
}

export const api = {
  async setLanguage({ lang } = {}, app) {
    appLang = lang === 'en' ? 'en' : 'pl';
    try {
      if (latestTelemetrySnapshot) {
        updateTrayMenu(app, latestTelemetrySnapshot);
      } else {
        const snap = await collectTelemetry(app);
        updateTrayMenu(app, snap);
      }
    } catch (_) {}
    return { ok: true, lang: appLang };
  },

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

  async getAutostartState(_params, app) {
    const state = await getLaunchAtLogin(app);
    return { ok: true, ...state };
  },

  async toggleAutostart({ value } = {}, app) {
    const target = typeof value === 'boolean' ? value : !autostartEnabled;
    const res = await setLaunchAtLogin(app, target);
    if (latestTelemetrySnapshot) {
      latestTelemetrySnapshot.autostart = res.enabled;
      latestTelemetrySnapshot.autostartRequiresApproval = Boolean(res.requiresApproval);
      updateTrayMenu(app, latestTelemetrySnapshot);
    }
    try {
      app.push('autostart-mode', {
        autostartEnabled: res.enabled,
        requiresApproval: Boolean(res.requiresApproval),
      });
    } catch (_) {}
    return res;
  },

  async snapLeft(_params, app) {
    await app.win.setPosition(16, 220);
    return { ok: true };
  },

  async openExternal({ url = '' } = {}, app) {
    if (!url) return { ok: false };
    const str = String(url);
    if (!str.startsWith('https://') && !str.startsWith('http://') && !str.startsWith('mailto:')) {
      return { ok: false, error: 'INVALID_URL' };
    }
    try {
      if (typeof app.openURL === 'function') {
        await app.openURL(str);
      } else {
        const proc = tjs.spawn(['/usr/bin/open', str], { stdout: 'ignore', stderr: 'ignore' });
        await proc.wait();
      }
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  },

  async toggleCaffeinate({ value } = {}, app) {
    const target = typeof value === 'boolean' ? value : !caffeinateActive;
    if (target) {
      if (!caffeinateActive) {
        try {
          const myPid = tjs.pid || 0;
          const args = myPid > 1 ? ['-dis', '-w', String(myPid)] : ['-dis'];
          const proc = tjs.spawn(['/usr/bin/caffeinate', ...args], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          caffeinateProc = proc;
          caffeinatePid = proc.pid || 0;
          caffeinateActive = true;
          if (proc?.wait) {
            proc.wait().then(() => {
              if (caffeinateProc !== proc) return;
              caffeinateActive = false;
              caffeinatePid = 0;
              caffeinateProc = null;
              try {
                app.push('caffeinate-state', { caffeinateActive: false });
                app.push('caffeinate-mode', { caffeinateActive: false });
              } catch (_) {}
            }).catch(() => {});
          }
        } catch (_) {}
      }
    } else {
      try {
        if (caffeinateProc) {
          caffeinateProc.kill();
          caffeinateProc = null;
        }
      } catch (_) {}
      caffeinateActive = false;
      caffeinatePid = 0;
    }
    try {
      app.push('caffeinate-state', { caffeinateActive });
      app.push('caffeinate-mode', { caffeinateActive });
    } catch (_) {}
    return { caffeinateActive };
  },

  async cleanRamAndDns(_params, app) {
    const bin = await resolveMacmonPath(app);
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
    latestTelemetrySnapshot = afterSnap;
    app.push('telemetry', afterSnap);
    return {
      ok: true,
      freeBytes: afterSnap?.memory?.free || 0,
      cachedBytes: afterSnap?.memory?.cached || 0,
    };
  },

  async scanSystemJunk(_params, app) {
    const scan = await runJunkScanOnce(app);
    return scan || { totalBytes: 0, categories: [] };
  },

  async scanDiskUsage({ path = '' } = {}, app) {
    const rawPath = path ? String(path).replace(/\\/g, '/').trim() : '';
    if (rawPath.includes('\0') || rawPath.split('/').includes('..')) {
      return { ok: false, error: 'INVALID_PATH', topDirs: [], topFiles: [] };
    }
    if (rawPath && !isAllowedUserPath(rawPath)) {
      return { ok: false, error: 'INVALID_PATH', topDirs: [], topFiles: [] };
    }
    currentDiskUsagePath = rawPath;
    const scan = await runDiskUsageScanOnce(app, currentDiskUsagePath, true);
    return scan || { ok: false, topDirs: [], topFiles: [] };
  },

  async revealInFinder({ path = '' } = {}, app) {
    if (!path) return { ok: false, error: 'EMPTY_PATH' };
    const std = String(path).replace(/\\/g, '/').trim();
    if (!isAllowedUserPath(std)) {
      return { ok: false, error: 'INVALID_PATH' };
    }
    const bin = await resolveMacmonPath(app);
    if (!bin) return { ok: false, error: 'NO_MACMON' };
    try {
      const proc = tjs.spawn([bin, '--reveal', std], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const text = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      return text ? JSON.parse(text) : { ok: true };
    } catch (_) {
      return { ok: false, error: 'SPAWN_FAILED' };
    }
  },

  async openPrivacySettings(_params, app) {
    try {
      await tjs.spawn(['/usr/bin/open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { stdout: 'ignore', stderr: 'ignore' }).wait().catch(() => {});
    } catch (_) {}
    return { ok: true };
  },

  async cleanSystemJunk({ categories } = {}, app) {
    if (!Array.isArray(categories) || categories.length === 0) {
      return { ok: false, error: 'EMPTY_CATEGORIES' };
    }
    const cats = categories.map((c) => String(c)).filter((c) => VALID_JUNK_CATEGORIES.has(c));
    if (cats.length === 0 || cats.length !== categories.length) {
      return { ok: false, error: 'INVALID_CATEGORIES' };
    }
    const bin = await resolveMacmonPath(app);
    if (!bin) {
      return { ok: false, error: 'NO_MACMON' };
    }
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
      latestTelemetrySnapshot = afterSnap;
      app.push('telemetry', afterSnap);
      return parsed;
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  async killProcess({ pid, force = false, name = '' } = {}, app) {
    const targetPid = Number(pid) || 0;
    if (targetPid <= 1) {
      return { ok: false, error: 'INVALID_PID' };
    }
    const bin = await resolveMacmonPath(app);
    if (!bin) {
      return { ok: false, error: 'NO_MACMON' };
    }
    try {
      const sig = force ? '9' : '15';
      const args = name ? [bin, '--kill', String(targetPid), sig, String(name)] : [bin, '--kill', String(targetPid), sig];
      const proc = tjs.spawn(args, {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const out = proc.stdout ? await proc.stdout.text() : '';
      await proc.wait();
      const parsed = out ? JSON.parse(out) : { ok: false };
      setTimeout(async () => {
        try {
          const snap = await collectTelemetry(app);
          latestTelemetrySnapshot = snap;
          app.push('telemetry', snap);
        } catch (_) {}
      }, 180);
      return parsed;
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  async runSpeedtest({ pingTimeoutMs, downloadTimeoutMs } = {}, app) {
    if (isSpeedtesting) {
      return { busy: true };
    }
    isSpeedtesting = true;
    const pingLimit = Number(pingTimeoutMs) > 0 ? Number(pingTimeoutMs) : SPEEDTEST_PING_TIMEOUT_MS;
    const downloadLimit = Number(downloadTimeoutMs) > 0 ? Number(downloadTimeoutMs) : SPEEDTEST_DOWNLOAD_TIMEOUT_MS;
    try {
      app.push('speedtest-progress', { phase: 'ping', progress: 10 });
      const latencyMs = await withStageTimeout(
        async (pingSignal) => {
          const tPing0 = Date.now();
          const pingResp = await fetch('https://speed.cloudflare.com/__down?bytes=0', {
            cache: 'no-store',
            ...(pingSignal ? { signal: pingSignal } : {}),
          });
          if (!pingResp.ok) {
            throw new Error('HTTP ' + pingResp.status);
          }
          return Math.max(1, Date.now() - tPing0);
        },
        pingLimit,
        'PING_TIMEOUT'
      );

      app.push('speedtest-progress', {
        phase: 'download',
        progress: 25,
        latencyMs,
      });

      const targetBytes = 15_000_000;
      const { received, totalSec } = await withStageTimeout(
        async (dlSignal) => {
          const tStart = Date.now();
          const resp = await fetch(`https://speed.cloudflare.com/__down?bytes=${targetBytes}`, {
            cache: 'no-store',
            ...(dlSignal ? { signal: dlSignal } : {}),
          });
          if (!resp.ok || !resp.body) {
            throw new Error('HTTP ' + resp.status);
          }

          const reader = resp.body.getReader();
          let bytesReceived = 0;
          let lastPush = Date.now();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              bytesReceived += value.byteLength;
              const now = Date.now();
              if (now - lastPush > 140) {
                const elapsedSec = Math.max(0.05, (now - tStart) / 1000);
                const currentMbps = Math.round(((bytesReceived * 8) / elapsedSec / 1_000_000) * 10) / 10;
                const pct = Math.min(95, Math.round(25 + (bytesReceived / targetBytes) * 70));
                app.push('speedtest-progress', {
                  phase: 'download',
                  progress: pct,
                  downloadMbps: currentMbps,
                  latencyMs,
                });
                lastPush = now;
              }
            }
          }
          return {
            received: bytesReceived,
            totalSec: Math.max(0.05, (Date.now() - tStart) / 1000),
          };
        },
        downloadLimit,
        'DOWNLOAD_TIMEOUT'
      );

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
      });
      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      app.push('speedtest-progress', {
        phase: 'error',
        progress: 0,
        error: msg,
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
  try {
    const st = await getLaunchAtLogin(app);
    autostartEnabled = Boolean(st?.enabled);
    autostartRequiresApproval = Boolean(st?.requiresApproval);
  } catch (_) {}

  let tickCount = 0;
  let isTicking = false;
  const runTick = async () => {
    if (isTicking) return;
    isTicking = true;
    try {
      const snapshot = await collectTelemetry(app);
      app.push('telemetry', snapshot);
      checkSmartAlerts(snapshot, app);
      if (tickCount % 2 === 0) {
        updateTrayMenu(app, snapshot);
      }
      tickCount++;
    } catch (_) {
    } finally {
      isTicking = false;
    }
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
  } else if (id === 'toggle-autostart') {
    const res = await setLaunchAtLogin(app, !autostartEnabled);
    if (latestTelemetrySnapshot) {
      latestTelemetrySnapshot.autostart = res.enabled;
      latestTelemetrySnapshot.autostartRequiresApproval = Boolean(res.requiresApproval);
      updateTrayMenu(app, latestTelemetrySnapshot);
    }
    try {
      app.push('autostart-mode', {
        autostartEnabled: res.enabled,
        requiresApproval: Boolean(res.requiresApproval),
      });
    } catch (_) {}
  } else if (id === 'quit') {
    app.quit();
  }
}
