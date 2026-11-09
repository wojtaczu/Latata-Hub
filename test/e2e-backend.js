// Latata.Hub — Level 1: Backend & Native Telemetry E2E Tests
// Run with: /tmp/.tinyjs/.tinyjs/bin/tjs run test/e2e-backend.js

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    failed++;
    failures.push(message);
    console.error(`  ❌ FAIL: ${message}`);
  } else {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  }
}

async function runMacmonNativeTest() {
  console.log('\n[E2E Suite 1: Native macmon Sidecar & Telemetry Data Contract]');
  const t0 = Date.now();
  const bin = (tjs.cwd || '.') + '/executables/macmon';
  const proc = tjs.spawn([bin], { stdout: 'pipe', stderr: 'ignore' });
  const rawText = await proc.stdout.text();
  const exitStatus = await proc.wait();
  const elapsed = Date.now() - t0;

  assert(exitStatus.exit_status === 0, `macmon exited cleanly with status 0 (took ${elapsed}ms)`);
  assert(rawText.length > 50, `macmon emitted stdout data (${rawText.length} bytes)`);

  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    assert(false, `macmon stdout is valid JSON: ${err.message}`);
    return;
  }
  assert(data !== null && typeof data === 'object', 'macmon output parsed as valid object');

  // Memory validation
  assert(typeof data.memory?.total === 'number' && data.memory.total > 0, `Memory total is valid (${(data.memory?.total / 1e9).toFixed(1)} GB)`);
  assert(typeof data.memory?.used === 'number' && data.memory.used > 0, `Memory used is valid (${(data.memory?.used / 1e9).toFixed(1)} GB)`);
  assert(typeof data.memory?.app === 'number', 'Memory App bytes present');
  assert(typeof data.memory?.wired === 'number', 'Memory Wired bytes present');
  assert(typeof data.memory?.compressed === 'number', 'Memory Compressed bytes present');

  // Disk validation
  assert(typeof data.disk?.total === 'number' && data.disk.total > 0, `Disk total is valid (${(data.disk?.total / 1e9).toFixed(1)} GB)`);
  assert(typeof data.disk?.free === 'number' && data.disk.free > 0, `Disk free is valid (${(data.disk?.free / 1e9).toFixed(1)} GB)`);
  assert(typeof data.disk?.name === 'string', `Disk volume name present (${data.disk?.name})`);

  // Temperatures & GPU validation
  assert(data.temps !== undefined, 'Temperatures object present');
  assert(data.gpu !== undefined, 'GPU object present');
  assert(typeof data.gpu?.deviceUtilization === 'number', `GPU deviceUtilization present (${data.gpu?.deviceUtilization}%)`);

  // Processes validation (libproc)
  const procs = data.processes;
  assert(Array.isArray(procs), `Processes list returned as Array (count: ${procs?.length})`);
  assert(procs?.length > 10, `At least 10 active processes detected (found ${procs?.length})`);

  if (procs?.length > 0) {
    const p1 = procs[0];
    assert(typeof p1.pid === 'number' && p1.pid > 0, `Process item has valid PID (${p1.pid})`);
    assert(typeof p1.name === 'string' && p1.name.length > 0, `Process item has non-empty name (${p1.name})`);
    assert(typeof p1.mem === 'number' && p1.mem >= 0, `Process item has memory counter (${p1.mem} bytes)`);
    assert(typeof p1.cpuNs === 'number', `Process item has cpuNs counter (${p1.cpuNs} ns)`);
  }

  // Bluetooth & Caffeinate validation
  assert(Array.isArray(data.bluetooth), `Bluetooth batteries array returned (count: ${data.bluetooth?.length})`);
  assert(typeof data.caffeinate?.active === 'boolean', `Caffeinate state returned (active: ${data.caffeinate?.active})`);
}

async function runBackendApiTest() {
  console.log('\n[E2E Suite 2: Backend API & Telemetry Aggregation Contract]');
  const mainMod = await import('../src/backend/main.js');
  assert(mainMod.api !== undefined, 'main.js exports api object');
  assert(typeof mainMod.api.getSnapshot === 'function', 'api.getSnapshot is exported function');
  assert(typeof mainMod.api.toggleWidgetLayer === 'function', 'api.toggleWidgetLayer is exported function');
  assert(typeof mainMod.api.toggleCompactMode === 'function', 'api.toggleCompactMode is exported function');
  assert(typeof mainMod.api.snapLeft === 'function', 'api.snapLeft is exported function');

  // Mock app surface to test collectTelemetry via getSnapshot
  const mockApp = {
    system: {
      battery: async () => ({
        percent: 85,
        charging: false,
        plugged: true,
        minutesRemaining: 180,
        cycleCount: 42,
        healthPercent: 98,
        nominalCapacity: 5100,
        adapterWatts: 67,
        powerInWatts: 24.5,
        systemLoadWatts: 12.3,
        voltageV: 12.1,
        amperageA: 1.01,
      }),
      wifi: async () => ({
        interface: 'en0',
        ssid: 'Latata_WiFi_5G',
        rssi: -52,
        noise: -90,
        snr: 38,
        txRate: 600,
        band: '5 GHz',
        channel: 36,
        widthMHz: 80,
      }),
    },
    paths: async () => ({
      executables: (tjs.cwd || '.') + '/executables',
      resources: (tjs.cwd || '.') + '/resources',
    }),
    win: {
      setLevel: async () => true,
      setAlwaysOnTop: async () => true,
      setSize: async () => true,
      setPosition: async () => true,
    },
    tray: {
      set: () => true,
    },
    push: () => true,
  };

  // Test getSnapshot telemetry aggregation
  const snapshot = await mainMod.api.getSnapshot({}, mockApp);
  assert(snapshot !== null && typeof snapshot === 'object', 'Snapshot is valid object');

  // Verify CPU & Cores
  assert(typeof snapshot.cpu?.totalPercent === 'number', `CPU totalPercent is numeric (${snapshot.cpu?.totalPercent}%)`);
  assert(Array.isArray(snapshot.cpu?.cores), `Per-core stats array present (core count: ${snapshot.cpu?.cores?.length})`);
  assert(Array.isArray(snapshot.cpu?.topProcesses), `Top CPU processes array present`);
  assert(snapshot.cpu?.topProcesses?.length <= 10, `Top CPU processes limited to top 10 (count: ${snapshot.cpu?.topProcesses?.length})`);

  if (snapshot.cpu?.topProcesses?.length >= 2) {
    const [tp1, tp2] = snapshot.cpu.topProcesses;
    assert(tp1.rank === 1 && tp2.rank === 2, 'Top CPU processes correctly indexed with #1, #2');
    assert(tp1.cpuPercent !== undefined && tp1.memBytes !== undefined, 'Top CPU process has cpuPercent and memBytes');
  }

  // Verify RAM & Top RAM processes
  assert(typeof snapshot.memory?.percent === 'number', `RAM usage percentage present (${snapshot.memory?.percent}%)`);
  assert(Array.isArray(snapshot.memory?.topProcesses), 'Top RAM processes array present');
  assert(snapshot.memory?.topProcesses?.length <= 10, `Top RAM processes limited to top 10 (count: ${snapshot.memory?.topProcesses?.length})`);

  if (snapshot.memory?.topProcesses?.length >= 2) {
    const [rm1, rm2] = snapshot.memory.topProcesses;
    assert(rm1.rank === 1 && rm2.rank === 2, 'Top RAM processes correctly indexed with #1, #2');
    assert(rm1.memBytes >= rm2.memBytes, 'Top RAM processes sorted descending by memory usage');
  }

  // Verify Network & Wi-Fi
  assert(snapshot.network !== undefined, 'Network telemetry present');
  assert(snapshot.wifi?.ssid === 'Latata_WiFi_5G', `Wi-Fi SSID correctly resolved (${snapshot.wifi?.ssid})`);
  assert(snapshot.wifi?.bars >= 1 && snapshot.wifi?.bars <= 5, `Wi-Fi signal bars calculated (${snapshot.wifi?.bars}/5)`);

  // Verify Developer & Port Inspector + Process Icons + Kill API
  assert(snapshot.dev !== undefined, 'Developer & Port Inspector object present');
  assert(Array.isArray(snapshot.dev?.ports), `Listening TCP ports list returned (count: ${snapshot.dev?.ports?.length})`);
  assert(typeof snapshot.dev?.docker?.running === 'boolean', `Docker engine status detected (running: ${snapshot.dev?.docker?.running})`);
  const hasAnyIcon = snapshot.cpu.topProcesses.some((p) => typeof p.icon === 'string' && p.icon.startsWith('data:image/png;base64,'));
  assert(hasAnyIcon, 'Native macOS app icons extracted as base64 PNG data URLs');
  assert(typeof mainMod.api.killProcess === 'function', 'api.killProcess is exported function');
  assert(Array.isArray(snapshot.bluetooth), `Snapshot includes Bluetooth device batteries (count: ${snapshot.bluetooth?.length})`);
  assert(typeof snapshot.caffeinateActive === 'boolean', `Snapshot includes caffeinateActive (${snapshot.caffeinateActive})`);
  assert(typeof mainMod.api.toggleCaffeinate === 'function', 'api.toggleCaffeinate is exported function');
  assert(typeof mainMod.api.cleanRamAndDns === 'function', 'api.cleanRamAndDns is exported function');

  const resClean = await mainMod.api.cleanRamAndDns({}, mockApp);
  assert(resClean?.ok === true, 'cleanRamAndDns executed DNS cache flush & memory refresh');

  assert(Array.isArray(snapshot.disk?.volumes) && snapshot.disk.volumes.length >= 1, `Disk volumes list returned (count: ${snapshot.disk?.volumes?.length})`);
  assert(typeof mainMod.api.scanSystemJunk === 'function', 'api.scanSystemJunk is exported function');
  assert(typeof mainMod.api.cleanSystemJunk === 'function', 'api.cleanSystemJunk is exported function');

  const junkScan = await mainMod.api.scanSystemJunk({}, mockApp);
  assert(Array.isArray(junkScan?.categories) && junkScan.categories.length === 5, `scanSystemJunk returned 5 CCleaner categories (total: ${(junkScan?.totalBytes / 1e6).toFixed(1)} MB)`);

  assert(typeof mainMod.api.scanDiskUsage === 'function', 'api.scanDiskUsage is exported function');
  assert(typeof mainMod.api.revealInFinder === 'function', 'api.revealInFinder is exported function');
  const diskScan = await mainMod.api.scanDiskUsage({ path: '' }, mockApp);
  assert(diskScan?.ok === true && Array.isArray(diskScan.topDirs) && Array.isArray(diskScan.topFiles), `scanDiskUsage returned topDirs (${diskScan?.topDirs?.length}) and topFiles (${diskScan?.topFiles?.length})`);

  // Verify Window State Toggles
  const resLayer = await mainMod.api.toggleWidgetLayer({}, mockApp);
  assert(typeof resLayer.desktopWidgetMode === 'boolean', `toggleWidgetLayer toggled mode to: ${resLayer.desktopWidgetMode}`);

  const resCompact = await mainMod.api.toggleCompactMode({}, mockApp);
  assert(typeof resCompact.compactMode === 'boolean', `toggleCompactMode toggled mode to: ${resCompact.compactMode}`);

  const resSnap = await mainMod.api.snapLeft({}, mockApp);
  assert(resSnap.ok === true, 'snapLeft positioned window successfully');

  // Verify Tooltips State API (Variant A)
  assert(typeof mainMod.api.setTooltipsState === 'function', 'api.setTooltipsState is exported function');
  const resTipOff = await mainMod.api.setTooltipsState({ enabled: false }, mockApp);
  assert(resTipOff?.tooltipsEnabled === false, 'setTooltipsState disabled tooltips');
  const resTipOn = await mainMod.api.setTooltipsState({ enabled: true }, mockApp);
  assert(resTipOn?.tooltipsEnabled === true, 'setTooltipsState enabled tooltips');

  // Verify Security & Path Traversal Guards
  const resBadDisk = await mainMod.api.scanDiskUsage({ path: '/Applications/../Users' }, mockApp);
  assert(resBadDisk?.ok === false && resBadDisk?.error === 'INVALID_PATH', 'scanDiskUsage rejects path traversal attempts');

  const resBadReveal = await mainMod.api.revealInFinder({ path: '../../etc/passwd' }, mockApp);
  assert(resBadReveal?.ok === false && resBadReveal?.error === 'INVALID_PATH', 'revealInFinder rejects path traversal attempts');

  assert(typeof mainMod.api.openExternal === 'function', 'api.openExternal is exported function');
  const resBadUrl = await mainMod.api.openExternal({ url: 'javascript:alert(1)' }, mockApp);
  assert(resBadUrl?.ok === false && resBadUrl?.error === 'INVALID_URL', 'openExternal safely rejects invalid schemes');

  const resBadKill = await mainMod.api.killProcess({ pid: 1 }, mockApp);
  assert(resBadKill?.ok === false && resBadKill?.error === 'INVALID_PID', 'killProcess safely rejects PID <= 1');

  // Verify setLanguage optimization with cached snapshot
  const resLang = await mainMod.api.setLanguage({ lang: 'en' }, mockApp);
  assert(resLang?.ok === true && resLang?.lang === 'en', 'setLanguage switches language without error');
  await mainMod.api.setLanguage({ lang: 'pl' }, mockApp);

  // Verify Native macmon Privacy Filtering for Icons
  const iconProc = tjs.spawn([(tjs.cwd || '.') + '/executables/macmon', '--icons', '/Applications/Safari.app', '/Users/test/Desktop/app'], { stdout: 'pipe', stderr: 'ignore' });
  const iconOut = await iconProc.stdout.text();
  await iconProc.wait();
  const iconMap = JSON.parse(iconOut || '{}');
  assert(iconMap['/Users/test/Desktop/app'] === undefined, 'Native macmon --icons filters out user Desktop paths to protect TCC privacy');

  // Verify Native macmon --scan-disk skips TCC-protected home folders
  const diskProc = tjs.spawn([(tjs.cwd || '.') + '/executables/macmon', '--scan-disk'], { stdout: 'pipe', stderr: 'ignore' });
  const diskOut = await diskProc.stdout.text();
  await diskProc.wait();
  const diskData = JSON.parse(diskOut || '{}');
  const touchesProtected = (diskData.topDirs || []).some(d => d.name === 'Desktop' || d.name === 'Documents' || d.name === 'Pictures' || d.name === 'Music');
  assert(!touchesProtected, 'Native macmon --scan-disk safely skips personal TCC folders (Desktop, Documents, Photos)');
}

async function runConfigAndIntegrityTest() {
  console.log('\n[E2E Suite 3: Configuration, Branding & Clean Build Integrity]');
  const base = tjs.cwd || '.';
  const dec = new TextDecoder();

  // 1. tinyjs.json contract
  const tinyJsonRaw = await tjs.readFile(base + '/tinyjs.json');
  const tinyConfig = JSON.parse(dec.decode(tinyJsonRaw));
  assert(tinyConfig.name === 'latata-hub', `tinyjs.json name is 'latata-hub' (${tinyConfig.name})`);
  assert(tinyConfig.title === 'Latata.Hub', `tinyjs.json title is 'Latata.Hub' (${tinyConfig.title})`);
  assert(tinyConfig.id === 'app.tinyjs.latata.hub', `tinyjs.json id is 'app.tinyjs.latata.hub' (${tinyConfig.id})`);

  // 2. package.json contract
  const pkgRaw = await tjs.readFile(base + '/package.json');
  const pkgConfig = JSON.parse(dec.decode(pkgRaw));
  assert(pkgConfig.name === 'latata-hub', `package.json name is 'latata-hub' (${pkgConfig.name})`);

  // 3. Frontend HTML template checks
  const htmlRaw = await tjs.readFile(base + '/src/frontend/index.html');
  const htmlText = dec.decode(htmlRaw);
  assert(htmlText.includes('<title>Latata.Hub</title>'), 'index.html has <title>Latata.Hub</title>');
  assert(htmlText.includes('Latata<span class="accent">.Hub</span>'), 'index.html has brand Latata.Hub');
  assert(!htmlText.includes('Wujt Control Center'), 'index.html no longer contains legacy Wujt brand');
  assert(htmlText.includes('id="btnToggleTooltips"'), 'index.html includes #btnToggleTooltips switch');
  assert(!htmlText.includes('id="btnDiskUp"'), 'index.html has removed obsolete #btnDiskUp (Wstecz) button');
  assert(htmlText.includes('id="btnScanDiskUsage"'), 'index.html includes #btnScanDiskUsage refresh button');

  // 4. Frontend CSS bugfix verification
  const cssRaw = await tjs.readFile(base + '/src/frontend/style.css');
  const cssText = dec.decode(cssRaw);
  assert(cssText.includes('.tooltip-hint[hidden],') && cssText.includes('display: none !important;'), 'style.css enforces display:none on hidden tooltip hints (prevents ghost slider)');

  // 5. Native Bundle & Distribution Assets (verified if dist/ exists)
  const appStat = await tjs.stat(base + '/dist/Latata.Hub.app').catch(() => null);
  if (appStat !== null) {
    assert(appStat !== null, 'dist/Latata.Hub.app exists and is present');
    const helperStat = await tjs.stat(base + '/dist/Latata.Hub.app/Contents/Helpers/macmon').catch(() => null);
    assert(helperStat !== null, 'dist/Latata.Hub.app/Contents/Helpers/macmon is bundled inside .app');
    const zipStat = await tjs.stat(base + '/dist/Latata.Hub-macos-arm64.zip').catch(() => null);
    assert(zipStat !== null && (zipStat.size || 0) > 1000000, `dist/Latata.Hub-macos-arm64.zip exists (${((zipStat?.size || 0) / 1e6).toFixed(1)} MB)`);
  } else {
    console.log('  ℹ SKIP: dist/ bundle not present (clean source clone, run npm run build to verify bundle)');
  }
}

(async () => {
  console.log('====================================================');
  console.log('       Latata.Hub — E2E Test Suite (Backend)       ');
  console.log('====================================================');

  try {
    await runMacmonNativeTest();
    await runBackendApiTest();
    await runConfigAndIntegrityTest();
  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  }

  console.log('\n----------------------------------------------------');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('----------------------------------------------------');

  if (failed > 0) {
    console.error(`FAILED: ${failed} assertions failed!`);
    tjs.exit(1);
  } else {
    console.log('ALL BACKEND E2E TESTS PASSED SUCCESSFULLY! ✓\n');
    tjs.exit(0);
  }
})();
