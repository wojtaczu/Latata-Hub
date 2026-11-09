// Generates a fully self-contained test/e2e-ui.html for TINYJS_HTML
const base = tjs.cwd || '.';
const css = await tjs.readFile(base + '/src/frontend/style.css');
const appJs = await tjs.readFile(base + '/src/frontend/app.js');
const indexHtml = await tjs.readFile(base + '/src/frontend/index.html');

const dec = new TextDecoder();
const enc = new TextEncoder();

const cssText = dec.decode(css);
const appJsText = dec.decode(appJs);
const indexHtmlText = dec.decode(indexHtml);

// Extract the body content of index.html
const bodyMatch = indexHtmlText.match(/<body[^>]*>([\s\S]*?)<script src="app\.js"><\/script>[\s\S]*?<\/body>/i);
const bodyContent = bodyMatch ? bodyMatch[1] : '';

const e2eHtml = `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Latata.Hub — E2E UI Test Runner</title>
  <style>
${cssText}

    /* Live E2E HUD Banner */
    #e2eBanner {
      position: fixed;
      bottom: 8px;
      left: 10px;
      right: 10px;
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.94);
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 11px;
      z-index: 99999;
      color: #f1f5f9;
      pointer-events: none;
    }
    #e2eBanner.success { border-color: rgba(34, 197, 94, 0.6); background: rgba(6, 78, 59, 0.95); }
    #e2eBanner.failure { border-color: rgba(244, 63, 94, 0.6); background: rgba(136, 19, 55, 0.95); }
    .e2e-row { display: flex; justify-content: space-between; align-items: center; }
    .e2e-title { font-weight: 700; color: #38bdf8; }
    .e2e-count { font-family: monospace; font-weight: 700; }
  </style>
</head>
<body>
${bodyContent}

  <!-- Live E2E HUD Banner -->
  <div id="e2eBanner">
    <div class="e2e-row">
      <span class="e2e-title" id="e2eStatus">🧪 Testy E2E w toku...</span>
      <span class="e2e-count" id="e2eCount">0 / 0</span>
    </div>
  </div>

  <!-- Inlined App Logic -->
  <script>
${appJsText}
  </script>

  <!-- Inlined E2E Test Runner -->
  <script>
    (async () => {
      const banner = document.getElementById('e2eBanner');
      const statusEl = document.getElementById('e2eStatus');
      const countEl = document.getElementById('e2eCount');

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const log = (msg) => {
        console.log('[E2E-UI] ' + msg);
        try { tiny?.log?.('[E2E-UI] ' + msg); } catch (_) {}
      };

      const results = { passed: 0, failed: 0, tests: [] };

      async function test(desc, fn) {
        try {
          await fn();
          results.passed++;
          results.tests.push({ desc, pass: true });
          log('✓ PASS: ' + desc);
        } catch (err) {
          results.failed++;
          results.tests.push({ desc, pass: false, error: err.message });
          console.error('❌ FAIL: ' + desc + ' -> ' + err.message);
          log('❌ FAIL: ' + desc + ' -> ' + err.message);
        }
        countEl.textContent = results.passed + ' pass / ' + results.failed + ' fail';
      }

      log('Starting Live End-to-End Test in WebKit WKWebView...');

      // 1. Wait until liveDot has .ok or snapshot arrives
      const t0 = Date.now();
      while ((typeof window.tiny === 'undefined' || !document.getElementById('liveDot')?.classList.contains('ok')) && Date.now() - t0 < 6000) {
        await sleep(50);
      }

      // Ensure snapshot data is rendered
      let initialSnap = null;
      if (window.tiny?.api) {
        try {
          initialSnap = await tiny.api.call('getSnapshot');
          renderTelemetry(initialSnap);
        } catch (_) {}
      }
      await sleep(250);

      // --- 1. DOM Shell & Title ---
      await test('Title displays Latata.Hub', () => {
        const titleEl = document.querySelector('.app-title');
        if (!titleEl || !titleEl.textContent.includes('Latata')) throw new Error('Unexpected title: ' + titleEl?.textContent);
      });

      await test('Live connection indicator is active (.ok)', () => {
        const dot = document.getElementById('liveDot');
        if (!dot.classList.contains('ok')) throw new Error('liveDot does not have .ok class');
      });

      // --- 2. Circular Rings & Status Strip Telemetry ---
      await test('Circular Gauge Rings have non-zero strokeDashoffset and percentages', () => {
        const ringCpu = document.getElementById('ringCpu');
        const hudCpuPct = document.getElementById('hudCpuPct');
        const hudRamPct = document.getElementById('hudRamPct');
        if (!ringCpu || !ringCpu.style.strokeDashoffset) throw new Error('ringCpu strokeDashoffset not computed');
        if (!hudCpuPct.textContent.includes('%') || !hudRamPct.textContent.includes('%')) throw new Error('HUD percentages not formatted');
      });

      await test('Status strip displays speeds, Ping, Battery and SSD', () => {
        const stripDown = document.getElementById('stripDown').textContent;
        const stripUp = document.getElementById('stripUp').textContent;
        const stripDisk = document.getElementById('stripDisk').textContent;
        if (!stripDown.includes('B/s')) throw new Error('stripDown invalid: ' + stripDown);
        if (!stripUp.includes('B/s')) throw new Error('stripUp invalid: ' + stripUp);
        if (!stripDisk.includes('GB')) throw new Error('stripDisk invalid: ' + stripDisk);
      });

      // --- 3. Top 10 CPU Processes, App Icons & Kill Button ---
      await test('Top 10 CPU list renders up to 10 ranked process rows with icons and Kill buttons', () => {
        const list = document.getElementById('topCpuList');
        const rows = list.querySelectorAll('.proc-row');
        if (rows.length === 0) throw new Error('topCpuList has 0 rows');
        if (rows.length > 10) throw new Error('topCpuList has more than 10 rows (' + rows.length + ')');
        const r1 = rows[0];
        if (!r1.querySelector('.proc-rank')?.textContent.includes('#1')) throw new Error('First row missing #1 rank');
        if (!r1.querySelector('.proc-name')?.textContent) throw new Error('Process name empty');
        if (!r1.querySelector('.cpu-val')?.textContent.includes('%')) throw new Error('CPU val missing %');
        if (!r1.querySelector('[data-kill-pid]')) throw new Error('Process row missing One-Click Kill button');
      });

      await test('Clicking Ports item in status strip opens Developer & Localhost Port Inspector', async () => {
        const portsItem = document.getElementById('stripPortsItem');
        portsItem.click();
        await sleep(150);
        const portsSec = document.getElementById('sec-ports');
        if (portsSec.hidden) throw new Error('sec-ports should be visible when Ports strip item is clicked');
      });

      // --- 4. Ring Clicks & View Switching ---
      await test('Clicking RAM ring switches view to Top 10 RAM and displays RAM/DNS Clean button', async () => {
        const ramTile = document.querySelector('#miniHudSystem .hud-tile[data-jump="top-ram"]');
        ramTile.click();
        await sleep(150);
        const ramSec = document.getElementById('sec-ram');
        const cpuSec = document.getElementById('sec-cpu');
        if (ramSec.hidden) throw new Error('sec-ram should be visible');
        if (!cpuSec.hidden) throw new Error('sec-cpu should be hidden');
        if (!ramTile.classList.contains('active')) throw new Error('RAM tile should have .active class');
        const ramRows = document.querySelectorAll('#topRamList .proc-row');
        if (ramRows.length === 0) throw new Error('topRamList has 0 rows');
        if (!document.getElementById('btnCleanRam')) throw new Error('Missing #btnCleanRam button');
      });

      await test('Clicking Wi-Fi ring switches view to Network & Wi-Fi', async () => {
        const wifiTile = document.querySelector('#miniHudSystem .hud-tile[data-jump="network"]');
        wifiTile.click();
        await sleep(150);
        const netSec = document.getElementById('sec-net');
        const wifiSec = document.getElementById('sec-wifi');
        if (netSec.hidden || wifiSec.hidden) throw new Error('Network and Wi-Fi sections should be visible');
        if (!wifiTile.classList.contains('active')) throw new Error('Wi-Fi tile should have .active');
      });

      await test('Clicking GPU ring switches view to GPU, Sensors & Battery with Bluetooth section', async () => {
        const gpuTile = document.querySelector('#miniHudSystem .hud-tile[data-jump="power"]');
        gpuTile.click();
        await sleep(150);
        const gpuSec = document.getElementById('sec-gpu');
        const battSec = document.getElementById('sec-battery');
        if (gpuSec.hidden || battSec.hidden) throw new Error('GPU and Battery sections should be visible');
        if (!gpuTile.classList.contains('active')) throw new Error('GPU tile should have .active');
        if (!document.getElementById('btDevicesBlock')) throw new Error('Missing #btDevicesBlock in Battery card');
      });

      await test('Clicking CPU ring returns view to Top 10 CPU', async () => {
        const cpuTile = document.querySelector('#miniHudSystem .hud-tile[data-jump="top-cpu"]');
        cpuTile.click();
        await sleep(150);
        const cpuSec = document.getElementById('sec-cpu');
        if (cpuSec.hidden) throw new Error('sec-cpu should be visible again');
        if (!cpuTile.classList.contains('active')) throw new Error('CPU tile should have .active');
      });

      // --- 4b. Always-Visible Battery Buttons, Disk Capacity Bar & System Cleaner ---
      await test('Battery buttons (MacBook + Bluetooth) and Disk Capacity Bar are visible immediately without clicking', async () => {
        const sysHud = document.getElementById('miniHudSystem');
        const battHud = document.getElementById('miniHudBattery');
        const diskBar = document.getElementById('diskHudBar');
        if (sysHud.hidden || battHud.hidden) throw new Error('Both System rings and Battery buttons must be visible immediately');
        if (!document.getElementById('hudBattPct0').textContent.includes('%')) throw new Error('MacBook battery ring missing percentage');
        if (!diskBar || !document.getElementById('hudDiskCap').textContent.includes('GB')) throw new Error('Always-visible Disk Capacity Bar missing GB text');
      });

      await test('Clicking Disk Capacity Bar opens Dysk, and Cleaner opens dedicated Smart Cleaner', async () => {
        const diskBar = document.getElementById('diskHudBar');
        diskBar.click();
        await sleep(150);
        const diskSec = document.getElementById('sec-disk');
        const cleanerSec = document.getElementById('sec-cleaner');
        if (diskSec.hidden) throw new Error('sec-disk should be visible when diskHudBar is clicked');
        if (!cleanerSec.hidden) throw new Error('sec-cleaner should be hidden when viewing disk');

        const btnCleaner = document.getElementById('btnHudCleaner');
        btnCleaner.click();
        await sleep(150);
        if (cleanerSec.hidden) throw new Error('sec-cleaner should be visible when btnHudCleaner is clicked');
        if (!diskSec.hidden) throw new Error('sec-disk should be hidden when viewing cleaner');
        if (!document.getElementById('cleanerBlock') || !document.getElementById('btnCleanJunk')) {
          throw new Error('Missing System Cleaner block or Clean button');
        }
      });

      await test('Processes sub-tabs switch cleanly between CPU, RAM and Ports', async () => {
        const procsTab = document.querySelector('.nav-tab[data-tab="procs"]');
        procsTab.click();
        await sleep(150);

        const subCpu = document.getElementById('subtabCpu');
        const subRam = document.getElementById('subtabRam');
        const subPorts = document.getElementById('subtabPorts');
        const secCpu = document.getElementById('sec-cpu');
        const secRam = document.getElementById('sec-ram');
        const secPorts = document.getElementById('sec-ports');

        subRam.click();
        await sleep(100);
        if (secRam.hidden || !secCpu.hidden || !secPorts.hidden) throw new Error('subtabRam failed to switch to sec-ram');

        subPorts.click();
        await sleep(100);
        if (secPorts.hidden || !secCpu.hidden || !secRam.hidden) throw new Error('subtabPorts failed to switch to sec-ports');

        subCpu.click();
        await sleep(100);
        if (secCpu.hidden || !secRam.hidden || !secPorts.hidden) throw new Error('subtabCpu failed to switch to sec-cpu');
      });

      await test('Home tab displays rich glance panel (Mac model, Uptime, SoC temp, Ping, Load, Actions)', async () => {
        const homeTab = document.querySelector('.nav-tab[data-tab="dashboard"]');
        homeTab.click();
        await sleep(150);
        const ringsPanel = document.getElementById('ringsPanel');
        const cardsContainer = document.getElementById('cardsContainer');
        if (ringsPanel.classList.contains('hidden-for-cards')) throw new Error('ringsPanel hidden on Home tab');
        if (!cardsContainer.classList.contains('hidden-for-dashboard')) throw new Error('cardsContainer visible on Home tab');

        if (!document.getElementById('homeGlancePanel')) throw new Error('Missing #homeGlancePanel on Home tab');
        if (!document.getElementById('btnHomeCleanRam')) throw new Error('Missing #btnHomeCleanRam on Home tab');
      });

      await test('Battery <= 10% while discharging activates .low-battery-warning visual theme', async () => {
        const shell = document.getElementById('appShell');
        if (initialSnap) {
          renderTelemetry({
            ...initialSnap,
            battery: { ...(initialSnap.battery || {}), percent: 8, charging: false, plugged: false },
          });
          if (!shell.classList.contains('low-battery-warning')) {
            throw new Error('appShell did not receive .low-battery-warning when battery is 8%');
          }
          renderTelemetry(initialSnap);
        }
      });

      // --- 5. Always on Top Button ---
      await test('Always on Top button toggles state and label', async () => {
        const btnPin = document.getElementById('btnPin');
        const label = document.getElementById('layerLabel');
        btnPin.click();
        await sleep(250);
        const pinned = btnPin.classList.contains('active');
        if (!pinned || (label.textContent !== 'Przypięto' && label.textContent !== 'Pinned')) throw new Error('Pin did not activate (' + label.textContent + ')');
        btnPin.click();
        await sleep(250);
        if (btnPin.classList.contains('active') || (label.textContent !== 'Przypnij' && label.textContent !== 'Pin')) throw new Error('Pin did not deactivate');
      });

      // --- 5b. Bilingual Language Switcher (PL / EN) ---
      await test('Language toggle button switches whole UI between Polish and English', async () => {
        const btnLang = document.getElementById('btnToggleLang');
        if (!btnLang) throw new Error('Missing #btnToggleLang element');
        
        // Ensure starting in PL mode
        if (typeof setLanguage === 'function') {
          setLanguage('pl');
          await sleep(60);
        }

        // Switch to EN
        btnLang.click();
        await sleep(150);
        
        const procsTab = document.querySelector('.nav-tab[data-tab="procs"]');
        const cleanerTab = document.querySelector('.nav-tab[data-tab="cleaner"]');
        if (!procsTab.textContent.includes('Processes')) {
          throw new Error('Tab not translated to EN: ' + procsTab.textContent);
        }
        if (!cleanerTab.textContent.includes('Cleaner')) {
          throw new Error('Cleaner tab text mismatch: ' + cleanerTab.textContent);
        }
        if (btnLang.textContent !== '🇵🇱 PL') {
          throw new Error('btnToggleLang text should be 🇵🇱 PL in English mode, got: ' + btnLang.textContent);
        }

        // Verify window mode buttons updated to EN
        const btnPin = document.getElementById('btnPin');
        const pinLabel = document.getElementById('layerLabel');
        btnPin.click();
        await sleep(100);
        if (pinLabel.textContent !== 'Pinned') throw new Error('Pin active label should be Pinned in EN mode, got: ' + pinLabel.textContent);
        btnPin.click();
        await sleep(100);
        if (pinLabel.textContent !== 'Pin') throw new Error('Pin inactive label should be Pin in EN mode, got: ' + pinLabel.textContent);

        // Switch back to PL
        btnLang.click();
        await sleep(150);
        if (!procsTab.textContent.includes('Procesy')) {
          throw new Error('Tab not translated back to PL: ' + procsTab.textContent);
        }
        if (btnLang.textContent !== '🇬🇧 EN') {
          throw new Error('btnToggleLang text should be 🇬🇧 EN in Polish mode, got: ' + btnLang.textContent);
        }
      });

      // --- 6. Compact / Expand Button ---
      await test('Compact / Expand button toggles label and window mode', async () => {
        const btnCompact = document.getElementById('btnCompact');
        const label = document.getElementById('compactLabel');
        btnCompact.click();
        await sleep(250);
        if (label.textContent !== 'Zwiń') throw new Error('Expand did not activate (' + label.textContent + ')');
        btnCompact.click();
        await sleep(250);
        if (label.textContent !== 'Rozwiń') throw new Error('Expand did not reset to Rozwiń');
      });

      // --- 7. Tooltip ON/OFF Switch (Variant A) ---
      await test('Tooltips ON/OFF button toggles state, updates label/classes, and syncs with Home glance panel', async () => {
        const btnTip = document.getElementById('btnToggleTooltips');
        if (!btnTip) throw new Error('Missing #btnToggleTooltips in titlebar');
        const homeStatus = document.getElementById('homeTooltipsStatus');
        
        // Ensure deterministic test baseline (reset to enabled regardless of previous user clicks in localStorage)
        if (typeof setTooltipsEnabled === 'function') {
          setTooltipsEnabled(true);
          await sleep(60);
        }

        // Initial: should be ON
        if (!btnTip.classList.contains('active')) throw new Error('Tooltip toggle should initially be active');
        if (!btnTip.textContent.includes('ON')) throw new Error('Tooltip toggle label should contain ON');

        // Click to turn OFF
        btnTip.click();
        await sleep(200);
        if (!btnTip.classList.contains('off')) throw new Error('Tooltip toggle missing .off class when disabled');
        if (!btnTip.textContent.includes('OFF')) throw new Error('Tooltip toggle label should contain OFF');
        if (homeStatus && !homeStatus.textContent.includes('OFF')) throw new Error('Home glance tooltip status should say OFF');

        // Click to turn back ON
        btnTip.click();
        await sleep(200);
        if (!btnTip.classList.contains('active')) throw new Error('Tooltip toggle should be active again');
        if (!btnTip.textContent.includes('ON')) throw new Error('Tooltip toggle label should contain ON again');
        if (homeStatus && !homeStatus.textContent.includes('ON')) throw new Error('Home glance tooltip status should say ON');
      });

      // --- 8. Disk Tab Cleanup ---
      await test('Disk tab removed Wstecz button (#btnDiskUp) and kept clean refresh button', async () => {
        const btnUp = document.getElementById('btnDiskUp');
        if (btnUp !== null) throw new Error('btnDiskUp ("Wstecz") should be completely removed from DOM');
        const btnRefresh = document.getElementById('btnScanDiskUsage');
        if (!btnRefresh) throw new Error('Missing #btnScanDiskUsage button in Disk view header');
      });

      // --- 9. Tooltip Slider Bug Fix ---
      await test('Tooltip ghost slider bug fix: empty hint element is completely hidden with display:none', async () => {
        const tipHint = document.getElementById('tooltipHint');
        if (!tipHint) throw new Error('Missing #tooltipHint element');
        const style = window.getComputedStyle(tipHint);
        if (style.display !== 'none') throw new Error('Empty tooltipHint must have display: none to prevent ghost slider thumb, got: ' + style.display);
      });

      // --- 10. Ghost Background Tooltip Prevention ---
      await test('Tooltip container trigger prevention: hovering empty app shell does not show tooltip', async () => {
        const shell = document.getElementById('appShell');
        const tooltip = document.getElementById('customTooltip');
        shell.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true, clientX: 20, clientY: 20 }));
        await sleep(100);
        if (tooltip.classList.contains('visible')) {
          throw new Error('Tooltip became visible when hovering empty app shell');
        }
      });

      // --- 11. Branding & Name ---
      await test('Branding: App title and elements show Latata.Hub and not legacy Wujt', async () => {
        const title = document.querySelector('.app-title');
        if (!title || !title.textContent.includes('Latata.Hub')) {
          throw new Error('Title does not contain Latata.Hub: ' + title?.textContent);
        }
        if (title.textContent.includes('Wujt')) {
          throw new Error('Title still contains legacy Wujt name: ' + title.textContent);
        }
      });

      // --- Final Report ---
      await sleep(400);
      const isOk = results.failed === 0;
      banner.className = isOk ? 'success' : 'failure';
      statusEl.textContent = isOk ? '✅ Wszystkie ' + results.passed + ' testów E2E (UI + WebKit) ZDANE!' : '❌ BŁĘDY W TESTACH E2E (' + results.failed + ')';
      log('=== E2E FINISHED: ' + results.passed + ' passed, ' + results.failed + ' failed ===');
    })();
  </script>
</body>
</html>
`;

await tjs.writeFile(base + '/test/e2e-ui.html', enc.encode(e2eHtml));
console.log('Self-contained test/e2e-ui.html generated successfully!');
