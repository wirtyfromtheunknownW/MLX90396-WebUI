import { MLX90396_API } from './mlx_api.js';
import { Arduino_API } from './arduino_api.js';
import { initSfiDemo, resizeSfiCanvases } from './sfi_demo.js';

// --- DOM Elements (Declared first to avoid TDZ ReferenceErrors) ---
const btnConnect = document.getElementById('btn-connect');
const btnClear = document.getElementById('btn-clear');
const btnSend = document.getElementById('btn-send');
const txInput = document.getElementById('tx-input');
const logWindow = document.getElementById('log-window');
const miniLogWindow = document.getElementById('mini-log-window'); 
const selEol = document.getElementById('sel-eol');
const chkEcho = document.getElementById('chk-echo');
const chkAutoScroll = document.getElementById('chk-autoscroll');

const btnStartDemo = document.getElementById('btn-start-demo');
const btnStopDemo = document.getElementById('btn-stop-demo');
const historyList = document.getElementById('history-list');

// Modal Elements
const selDriverType = document.getElementById('sel-driver-type');
const wrapConnType = document.getElementById('wrap-conn-type');
const selConnType = document.getElementById('sel-conn-type');
const selBaudRate = document.getElementById('sel-baud-rate');
const connectModal = document.getElementById('connect-modal');
const btnModalConnect = document.getElementById('btn-modal-connect');
const btnCloseModal = document.getElementById('btn-close-modal');

// 2D Magnet & UI Elements
const magnetDisk = document.getElementById('magnet-disk');
const btnZeroMagnet = document.getElementById('btn-zero-magnet');
const joystickBase = document.getElementById('joystick-base');
const joystickStick = document.getElementById('joystick-stick');

if (selEol) selEol.value = '\\n';

// --- State Variables ---
let port = null, reader = null, writer = null;
let isConnected = false, isReading = false, isDemoRunning = false;
let textDecoder, textEncoder;
let readableStreamClosed, writableStreamClosed; 

let activeDevice = null;
let currentDriverType = 'scpi'; 

let scpiLock = Promise.resolve();
let scpiWaiter = null; 

const history = [];
let historyIndex = -1;
let draftBeforeNav = '';

const magnetOffsets = { x: 0, y: 0 };
const latestRawMagnet = { x: 0, y: 0 };

const leds = [];
const TOTAL_LEDS = 28;
const ANGLE_STEP = 360 / TOTAL_LEDS;

// --- Initialize on Startup ---
window.addEventListener('DOMContentLoaded', () => {
  initSfiDemo();
  initJoystickLEDs();
  initDeviceCommandButtons();
  initNvramControls();
});

// --- Helper: SPI Bus Prefix ---
function getSpiPrefix() {
  return selConnType ? selConnType.value : ':SPI';
}

// --- Top-Level Demo Navigation (SFI vs JWT) ---
document.querySelectorAll('.demo-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.demo-tab-btn').forEach(b => b.classList.remove('active', 'ds-tabs__tab--active'));
    document.querySelectorAll('.demo-view').forEach(v => v.classList.remove('active'));

    btn.classList.add('active', 'ds-tabs__tab--active');
    const target = document.getElementById(btn.dataset.target);
    if (target) target.classList.add('active');

    if (btn.dataset.target === 'demo-sfi') {
      setTimeout(resizeSfiCanvases, 50);
    } else if (btn.dataset.target === 'demo-jwt' && window.Plotly && document.getElementById('view-3dplot')?.classList.contains('active')) {
      Plotly.Plots.resize('plot-3d-container');
    }
  });
});

// --- Sub-Tab Routing (JWT View) ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active', 'ds-tabs__tab--active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    btn.classList.add('active', 'ds-tabs__tab--active');
    const targetView = document.getElementById(btn.dataset.target);
    if (targetView) targetView.classList.add('active');

    if (btn.dataset.target === 'view-3dplot' && window.Plotly) {
      Plotly.Plots.resize('plot-3d-container');
    }
  });
});

// --- Dynamic Device Command Buttons ---
function initDeviceCommandButtons() {
  const container = document.getElementById('api-test-buttons');
  if (!container) return;

  const commands = [
    { label: 'RT (Reset)', action: async () => { const res = await activeDevice.rt(); appendLog(`[API RT] Result: ${res ? 'OK' : 'FAIL'}\n`, res ? 'log-okprompt' : 'log-badprompt'); } },
    { label: 'HS (Store NVRAM)', action: async () => { const res = await activeDevice.hs(); appendLog(`[API HS] Result: ${res ? 'OK' : 'FAIL'}\n`, res ? 'log-okprompt' : 'log-badprompt'); } },
    { label: 'HR (Recall NVRAM)', action: async () => { const res = await activeDevice.hr(); appendLog(`[API HR] Result: ${res ? 'OK' : 'FAIL'}\n`, res ? 'log-okprompt' : 'log-badprompt'); } },
    { label: 'SM (Start Meas)', action: async () => { const res = await activeDevice.sm(0xFC000); appendLog(`[API SM] Mask 0xFC000 Result: ${res ? 'OK' : 'FAIL'}\n`, res ? 'log-okprompt' : 'log-badprompt'); } },
    { label: 'RM (Read P0-1)', action: async () => { const res = await activeDevice.rm(false, 0xFC000); appendLog(`[API RM P0-1] ${JSON.stringify(res)}\n`, res.error ? 'log-badprompt' : 'log-okprompt'); } },
    { label: 'RM (Read P2-3)', action: async () => { const res = await activeDevice.rm(false, 0x03F00); appendLog(`[API RM P2-3] ${JSON.stringify(res)}\n`, res.error ? 'log-badprompt' : 'log-okprompt'); } },
    { label: 'EX (Exit Mode)', action: async () => { const res = await activeDevice.ex(0); appendLog(`[API EX] Result: ${res ? 'OK' : 'FAIL'}\n`, res ? 'log-okprompt' : 'log-badprompt'); } },
    { label: 'RR Reg 0x00', action: async () => { const res = await activeDevice.rr(0x00); appendLog(`[API RR 0x00] Data: 0x${res.data?.toString(16).padStart(4, '0')}\n`, res.error ? 'log-badprompt' : 'log-okprompt'); } },
    { label: 'RR Reg 0x02', action: async () => { const res = await activeDevice.rr(0x02); appendLog(`[API RR 0x02] Data: 0x${res.data?.toString(16).padStart(4, '0')}\n`, res.error ? 'log-badprompt' : 'log-okprompt'); } }
  ];

  container.innerHTML = '';
  commands.forEach(cmd => {
    const btn = document.createElement('button');
    btn.className = 'ds-button ds-button--secondary ds-button--sm api-btn';
    btn.textContent = cmd.label;
    btn.disabled = !isConnected || currentDriverType === 'arduino';
    btn.addEventListener('click', async () => {
      if (!activeDevice || currentDriverType !== 'scpi') return;
      try {
        console.log(`[API EXEC] Running command: ${cmd.label}`);
        await cmd.action();
      } catch (err) {
        console.error(`[API ERROR] ${cmd.label}:`, err);
        appendLog(`[API ERROR]: ${err.message}\n`, 'log-badprompt');
      }
    });
    container.appendChild(btn);
  });
}

// --- 2D Magnet Position & UI ---
btnZeroMagnet?.addEventListener('click', () => {
  magnetOffsets.x = latestRawMagnet.x;
  magnetOffsets.y = latestRawMagnet.y;
  appendLog(`[MAGNET] Zero Captured: Offset X=${magnetOffsets.x.toFixed(2)} mm, Y=${magnetOffsets.y.toFixed(2)} mm\n`, 'log-okprompt');
});

function updateMagnetUI(posX_mm, posY_mm, angleDeg) {
  if (!magnetDisk) return;
  const safeX = typeof posX_mm === 'number' && !isNaN(posX_mm) ? posX_mm : 0;
  const safeY = typeof posY_mm === 'number' && !isNaN(posY_mm) ? posY_mm : 0;
  const safeAngle = typeof angleDeg === 'number' && !isNaN(angleDeg) ? angleDeg : 0;

  const PIXELS_PER_MM = 30; 
  const maxSquareExtent = 75; // +-2.5 mm travel limit

  let transX = Math.max(-maxSquareExtent, Math.min(maxSquareExtent, safeX * PIXELS_PER_MM));
  let transY = Math.max(-maxSquareExtent, Math.min(maxSquareExtent, -safeY * PIXELS_PER_MM));

  magnetDisk.style.transform = `translate3d(${transX}px, ${transY}px, 0px) rotate(${safeAngle}deg)`;
}

// --- 3D Joystick UI ---
function initJoystickLEDs() {
  if (!joystickBase || leds.length > 0) return;
  for (let i = 0; i < TOTAL_LEDS; i++) {
    const led = document.createElement('div');
    led.className = 'joystick__led';
    led.style.transform = `rotate(${(i * ANGLE_STEP) + 90}deg)`;
    joystickBase.appendChild(led);
    leds.push(led);
  }
}

function updateJoystickUI(x, y) {
  if (!joystickStick) return;
  const safeX = typeof x === 'number' && !isNaN(x) ? x : 0;
  const safeY = typeof y === 'number' && !isNaN(y) ? y : 0;
  
  const radius = Math.sqrt(safeX * safeX + safeY * safeY);
  let renderX = safeX;
  let renderY = safeY;
  
  if (radius > 50) {
    const scale = 50 / radius;
    renderX *= scale; 
    renderY *= scale;
  }
  
  joystickStick.style.setProperty('--tx', renderX);
  joystickStick.style.setProperty('--ty', renderY);
  leds.forEach(led => led.className = 'joystick__led');

  if (radius > 5) { 
    let angleDeg = Math.atan2(safeY, safeX) * (180 / Math.PI);
    if (angleDeg < 0) angleDeg += 360;
    let activeIndex = Math.round(angleDeg / ANGLE_STEP) % TOTAL_LEDS;

    for (let i = -2; i <= 2; i++) {
      let targetIdx = (activeIndex + i + TOTAL_LEDS) % TOTAL_LEDS;
      if (leds[targetIdx]) {
        if (i === 0) leds[targetIdx].classList.add('led-active');
        else if (Math.abs(i) === 1) leds[targetIdx].classList.add('led-low-1');
        else leds[targetIdx].classList.add('led-low-2');
      }
    }
  }
}

// --- Console & Terminal Logging ---
const LOG_MAX_CHARS = 100000;
const LOG_TRIM_TO = 80000;
let logTotalChars = 0;
let logQueue = [];
let logFlushScheduled = false;

function scheduleLogFlush() {
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(flushLog);
  }
}

function flushLog() {
  logFlushScheduled = false;
  if (!logQueue.length) return;

  const frag = document.createDocumentFragment();
  let prevCls = null;
  let buf = '';

  const commit = () => {
    if (!buf) return;
    const span = document.createElement('span');
    if (prevCls) span.className = prevCls;
    span.textContent = buf;
    span.dataset.len = String(buf.length);
    frag.appendChild(span);
    logTotalChars += buf.length;
    buf = '';
  };

  for (const item of logQueue) {
    const cls = item.cls || '';
    if (cls === prevCls) {
      buf += item.text;
    } else {
      commit();
      prevCls = cls;
      buf = item.text;
    }
  }
  commit();
  logQueue.length = 0;

  if (miniLogWindow) miniLogWindow.appendChild(frag.cloneNode(true));
  if (logWindow) logWindow.appendChild(frag);

  if (logTotalChars > LOG_MAX_CHARS) {
    while (logTotalChars > LOG_TRIM_TO && logWindow && logWindow.firstChild) {
      const n = logWindow.firstChild;
      let len = parseInt(n.dataset?.len || 0, 10) || n.textContent?.length || 0;
      logTotalChars -= len;
      logWindow.removeChild(n);
    }
    while (miniLogWindow && miniLogWindow.childNodes.length > (logWindow?.childNodes.length || 0)) {
      miniLogWindow.removeChild(miniLogWindow.firstChild);
    }
  }

  if (chkAutoScroll && chkAutoScroll.checked) {
    if (logWindow) logWindow.scrollTop = logWindow.scrollHeight;
    if (miniLogWindow) miniLogWindow.scrollTop = miniLogWindow.scrollHeight;
  }
}

function appendLog(text, cls) {
  if (!text) return;
  console.log(`%c[SERIAL ${cls || 'INFO'}] ${text.trim()}`, 'color: #38bdf8');
  logQueue.push({ text, cls });
  scheduleLogFlush();
}

// --- Serial RX Router ---
let rxBuffer = '';
let lastDataLine = '';

function processRx(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (char === '\n' || char === '\r') {
      if (rxBuffer.trim() !== '') {
        const line = rxBuffer.trim();
        console.log('[RX LINE]', line);
        if (currentDriverType === 'arduino' && activeDevice) {
          activeDevice.processLine(line);
        } else {
          handlePrompt(line);
        }
      }
      rxBuffer = ''; 
    } else {
      rxBuffer += char;
      if (currentDriverType === 'scpi') {
        if (rxBuffer.endsWith('(OK)>') || rxBuffer.endsWith('(ERR)>') || rxBuffer.endsWith('(E2BIG)>') || rxBuffer.endsWith('(ERANGE)>')) {
          const line = rxBuffer.trim();
          console.log('[RX PROMPT]', line);
          handlePrompt(line);
          rxBuffer = '';
        }
      }
    }
  }
}

function handlePrompt(line) {
  if (line.endsWith('(OK)>')) {
    let dataPart = line.slice(0, -5).trim();
    if (dataPart.includes(':SPI') || dataPart.includes(',') || dataPart.includes('0x')) {
      lastDataLine = dataPart;
    }
    if (dataPart) appendLog(dataPart + '\n', 'log-rx');
    appendLog('(OK)>\n', 'log-okprompt');
    
    if (scpiWaiter) {
      clearTimeout(scpiWaiter.timeoutId);
      scpiWaiter.resolve(lastDataLine);
      const rel = scpiWaiter.release;
      scpiWaiter = null;
      if (rel) rel();
    }
    lastDataLine = '';
  } else if (line.endsWith('(ERR)>') || line.endsWith('(E2BIG)>') || line.endsWith('(ERANGE)>')) {
    appendLog(line + '\n', 'log-badprompt');
    if (scpiWaiter) {
      clearTimeout(scpiWaiter.timeoutId);
      scpiWaiter.reject(new Error("Hardware Error: " + line));
      const rel = scpiWaiter.release;
      scpiWaiter = null;
      if (rel) rel();
    }
    lastDataLine = '';
  } else {
    appendLog(line + '\n', 'log-rx');
    if (line.includes(',') && !line.startsWith(':') && !line.startsWith('*')) {
      lastDataLine = line;
    }
  }
}

// --- SCPI Queries ---
function getEol() {
  if (!selEol) return '\n';
  const v = selEol.value;
  if (v === '\\n') return '\n';
  if (v === '\\r') return '\r';
  if (v === '\\r\\n') return '\r\n';
  return '\n';
}

async function sendCommand(cmd, echo = true, recordHistory = true) {
  if (!writer) return;
  const raw = cmd.trim();
  if (!raw) return;

  const text = raw + getEol();
  try {
    console.log('[TX SEND]', raw);
    await writer.write(text);
    if (echo && chkEcho && chkEcho.checked) appendLog(text, 'log-echo');
    
    if (recordHistory && history[0] !== raw) {
      history.unshift(raw);
      if (history.length > 50) history.pop();
      updateHistoryUI();
    }
    
    if (txInput) txInput.value = '';
    historyIndex = -1;
    draftBeforeNav = '';
  } catch (err) {
    console.error('[TX ERROR]', err);
    appendLog(`[TX ERROR]: ${err.message}\n`, 'log-badprompt');
  }
}

async function scpiQuery(cmd) {
  let releaseLock;
  const nextLock = new Promise(resolve => { releaseLock = resolve; });
  
  await scpiLock;
  scpiLock = nextLock;

  return new Promise((resolve, reject) => {
    lastDataLine = ''; 
    scpiWaiter = { resolve, reject, release: releaseLock };
    sendCommand(cmd, true, false); 
    
    scpiWaiter.timeoutId = setTimeout(() => {
      if (scpiWaiter) {
        scpiWaiter.reject(new Error("Device Timeout on command: " + cmd));
        scpiWaiter = null;
        releaseLock(); 
      }
    }, 2500); 
  });
}

function updateHistoryUI() {
  if (!historyList) return;
  historyList.innerHTML = '';
  history.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'ds-button ds-button--secondary ds-button--sm';
    btn.textContent = item;
    btn.style.textAlign = 'left';
    btn.addEventListener('click', () => {
      if (txInput) txInput.value = item;
    });
    historyList.appendChild(btn);
  });
}

// --- Connection Manager ---
function setUIConnected(connected) {
  isConnected = connected;
  btnConnect.textContent = connected ? 'Disconnect' : 'Connect USB';
  if (connected) btnConnect.classList.add('btn-danger');
  else btnConnect.classList.remove('btn-danger');
  
  if (txInput) txInput.disabled = !connected || currentDriverType === 'arduino';
  if (btnSend) btnSend.disabled = !connected || currentDriverType === 'arduino';
  if (btnStartDemo) btnStartDemo.disabled = !connected;
  
  initDeviceCommandButtons();

  const isScpi = connected && currentDriverType === 'scpi';
  ['nvram-addr', 'nvram-val', 'btn-nvram-read', 'btn-nvram-write', 'btn-nvram-dump', 'btn-nvram-hs', 'btn-nvram-hr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !isScpi;
  });
}

async function connectSerial() {
  try {
    currentDriverType = selDriverType ? selDriverType.value : 'scpi';
    const baudRate = selBaudRate ? parseInt(selBaudRate.value, 10) : 115200;

    port = await navigator.serial.requestPort();
    await port.open({ baudRate });

    textDecoder = new TextDecoderStream();
    textEncoder = new TextEncoderStream();
    readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    writableStreamClosed = textEncoder.readable.pipeTo(port.writable);

    reader = textDecoder.readable.getReader();
    writer = textEncoder.writable.getWriter();
    isReading = true;

    if (currentDriverType === 'arduino') {
      activeDevice = new Arduino_API();
      appendLog(`[SYSTEM] Connected with Direct Arduino API at ${baudRate} baud.\n`, 'log-okprompt');
    } else {
      activeDevice = new MLX90396_API(scpiQuery, getSpiPrefix);
      appendLog(`[SYSTEM] Connected with MLX90396 SCPI API on bus ${getSpiPrefix()} at ${baudRate} baud.\n`, 'log-okprompt');
    }

    setUIConnected(true);

    (async () => {
      try {
        while (isReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) processRx(value);
        }
      } catch (err) {
        appendLog(`[RX ERROR]: ${err.message}\n`, 'log-badprompt');
      } finally {
        reader.releaseLock();
      }
    })();

  } catch (err) {
    appendLog(`[CONN ERROR]: ${err.message}\n`, 'log-badprompt');
  }
}

async function disconnectSerial() {
  isReading = false;
  isDemoRunning = false;
  if (reader) { await reader.cancel(); reader.releaseLock(); }
  if (writer) { await writer.close(); writer.releaseLock(); }
  if (readableStreamClosed) await readableStreamClosed.catch(() => {});
  if (writableStreamClosed) await writableStreamClosed.catch(() => {});
  if (port) await port.close();
  
  port = null; reader = null; writer = null; activeDevice = null;
  setUIConnected(false);
  updateJoystickUI(0, 0);
  updateMagnetUI(0, 0);
  appendLog('[SYSTEM] Port closed.\n', 'log-badprompt');
}

// --- Live Unified Demo Loop ---
async function runJoystickDemo() {
  btnStartDemo.disabled = true;
  btnStopDemo.disabled = false;
  isDemoRunning = true;

  if (isConnected && activeDevice) {
    try {
      appendLog('[SYSTEM] Starting Live Demo...\n', 'log-okprompt');

      if (currentDriverType === 'scpi') {
        const prefix = getSpiPrefix(); 
        await new Promise(r => setTimeout(r, 200));

        if (prefix.includes('SPI2') || prefix === ':SPI2') {
          console.log('[INIT] Configuring Melexis IO SPI2 Header Connection...');
          await scpiQuery(`${prefix}:Init 0`);
          await scpiQuery(`${prefix}:SET:CS0 0`);
          await scpiQuery(":A3:GPIO:INIT:OUT 0");
        } else {
          console.log('[INIT] Configuring Melexis IO Cable Connection...');
          await scpiQuery(`${prefix}:Init 0`);
          await scpiQuery(":CON:CS1:GPIO:INIT:OUT 0");
          await scpiQuery(`${prefix}:BUFfer 1,1,1,1,0`);
          await scpiQuery(":VDD:3V3");
        }
      }

      const K_ROT_X = 0.10, K_ROT_Y = 0.10;
      const SCALE_X = 0.02, SCALE_Y = 0.02;

      while (isDemoRunning) {
        try {
          let posX_mm = 0, posY_mm = 0, angleDeg = 0;
          let rawX = 0, rawY = 0, rawZ = 0;

          if (currentDriverType === 'scpi') {
            await activeDevice.sm(0xFC000); 
            await new Promise(r => setTimeout(r, 15)); 
            const res01 = await activeDevice.rm(false, 0xFC000); 
            
            await activeDevice.sm(0x03F00); 
            await new Promise(r => setTimeout(r, 15)); 
            const res23 = await activeDevice.rm(false, 0x03F00); 

            if (!res01.error && !res23.error) {
              const avgX = (res01.x0 + res01.x1 + res23.x2 + res23.x3) / 4;
              const avgY = (res01.y0 + res01.y1 + res23.y2 + res23.y3) / 4;
              const avgZ = (res01.z0 + res01.z1 + res23.z2 + res23.z3) / 4;

              angleDeg = Math.atan2(-avgY, avgX) * (180 / Math.PI);

              const rawGradX = ((res01.x1 + res23.x2) - (res01.x0 + res23.x3)) / 2;
              const rawGradY = ((res01.y0 + res01.y1) - (res23.y3 + res23.y2)) / 2;

              const cleanGradX = rawGradX - (avgX * K_ROT_X);
              const cleanGradY = rawGradY - (avgY * K_ROT_Y);

              latestRawMagnet.x = cleanGradX * SCALE_X;
              latestRawMagnet.y = cleanGradY * SCALE_Y;

              posX_mm = latestRawMagnet.x - magnetOffsets.x;
              posY_mm = latestRawMagnet.y - magnetOffsets.y;
              rawX = avgX; rawY = avgY; rawZ = avgZ;
            }
          } else {
            const sample = await activeDevice.getSample();
            if (!sample.error) {
              latestRawMagnet.x = sample.posX_mm;
              latestRawMagnet.y = sample.posY_mm;
              posX_mm = latestRawMagnet.x - magnetOffsets.x;
              posY_mm = latestRawMagnet.y - magnetOffsets.y;
              angleDeg = sample.angleDeg;
              rawX = sample.rawX; rawY = sample.rawY; rawZ = sample.rawZ;
            }
          }

          updateMagnetUI(posX_mm, posY_mm, angleDeg);
          updateJoystickUI(rawX / 20, rawY / 20); 
          update3DVectorPlot(rawX, rawY, rawZ);

          await new Promise(r => setTimeout(r, currentDriverType === 'scpi' ? 50 : 25));
        } catch (loopErr) {
          console.warn('[DEMO LOOP WARNING]', loopErr);
          await new Promise(r => setTimeout(r, 150));
        }
      }
    } catch (err) {
      appendLog(`[DEMO ERROR]: ${err.message}\n`, 'log-badprompt');
      isDemoRunning = false;
      btnStartDemo.disabled = false;
      btnStopDemo.disabled = true;
    }
  } else {
    // Standalone Emulation Mode
    let angle = 0;
    while (isDemoRunning) {
      angle += 0.08; 
      const emulatedX = Math.sin(angle * 0.7) * 1.8;
      const emulatedY = Math.cos(angle * 0.9) * 1.8;
      const emulatedAngle = (angle * (180 / Math.PI)) % 360;

      updateMagnetUI(emulatedX, emulatedY, emulatedAngle);
      updateJoystickUI(emulatedX * 20, emulatedY * 20);
      update3DVectorPlot(Math.cos(angle) * 500, Math.sin(angle) * 500, 200);

      await new Promise(r => setTimeout(r, 33)); 
    }
  }
}

// --- NVRAM Handling ---
function initNvramControls() {
  const btnRead = document.getElementById('btn-nvram-read');
  const btnWrite = document.getElementById('btn-nvram-write');
  const btnDump = document.getElementById('btn-nvram-dump');
  const btnHs = document.getElementById('btn-nvram-hs');
  const btnHr = document.getElementById('btn-nvram-hr');
  const addrInput = document.getElementById('nvram-addr');
  const valInput = document.getElementById('nvram-val');
  const tableBody = document.getElementById('nvram-table-body');

  const parseAddr = (str) => str.startsWith('0x') || str.startsWith('0X') ? parseInt(str, 16) : parseInt(str, 10);
  const parseVal = (str) => str.startsWith('0x') || str.startsWith('0X') ? parseInt(str, 16) : parseInt(str, 10);

  btnRead?.addEventListener('click', async () => {
    if (!activeDevice || currentDriverType !== 'scpi') return;
    const addr = parseAddr(addrInput.value);
    if (isNaN(addr)) return;
    const res = await activeDevice.rr(addr);
    if (!res.error) {
      valInput.value = '0x' + res.data.toString(16).toUpperCase().padStart(4, '0');
      appendLog(`[NVRAM] Read 0x${addr.toString(16).toUpperCase()}: 0x${res.data.toString(16).toUpperCase()}\n`, 'log-okprompt');
    }
  });

  btnWrite?.addEventListener('click', async () => {
    if (!activeDevice || currentDriverType !== 'scpi') return;
    const addr = parseAddr(addrInput.value);
    const val = parseVal(valInput.value);
    if (isNaN(addr) || isNaN(val)) return;
    const err = await activeDevice.wr(addr, val);
    appendLog(`[NVRAM] Write 0x${addr.toString(16).toUpperCase()} = 0x${val.toString(16).toUpperCase()}: ${!err ? 'SUCCESS' : 'FAILED'}\n`, !err ? 'log-okprompt' : 'log-badprompt');
  });

  btnDump?.addEventListener('click', async () => {
    if (!activeDevice || currentDriverType !== 'scpi' || !tableBody) return;
    tableBody.innerHTML = '';
    for (let reg = 0x00; reg <= 0x3F; reg++) {
      const res = await activeDevice.rr(reg);
      const row = document.createElement('tr');
      row.className = 'ds-table__row';
      row.innerHTML = `
        <td class="ds-table__td">0x${reg.toString(16).toUpperCase().padStart(2, '0')}</td>
        <td class="ds-table__td">${reg}</td>
        <td class="ds-table__td">0x${res.error ? '--' : res.data.toString(16).toUpperCase().padStart(4, '0')}</td>
        <td class="ds-table__td">${res.error ? '--' : res.data}</td>
        <td class="ds-table__td">${res.error ? 'ERR' : 'OK'}</td>
      `;
      tableBody.appendChild(row);
    }
  });

  btnHs?.addEventListener('click', async () => {
    if (activeDevice && currentDriverType === 'scpi') await activeDevice.hs();
  });
  btnHr?.addEventListener('click', async () => {
    if (activeDevice && currentDriverType === 'scpi') await activeDevice.hr();
  });
}

// --- Connection Modal Event Handlers ---
selDriverType?.addEventListener('change', (e) => {
  if (wrapConnType) {
    wrapConnType.style.display = e.target.value === 'scpi' ? 'block' : 'none';
  }
});

btnConnect?.addEventListener('click', () => {
  if (isConnected) disconnectSerial();
  else connectModal?.classList.remove('hidden');
});

btnCloseModal?.addEventListener('click', () => connectModal?.classList.add('hidden'));

btnModalConnect?.addEventListener('click', async () => {
  connectModal?.classList.add('hidden');
  await connectSerial();
});

btnSend?.addEventListener('click', () => sendCommand(txInput.value));
btnClear?.addEventListener('click', () => { 
  if (logWindow) logWindow.textContent = ''; 
  if (miniLogWindow) miniLogWindow.textContent = ''; 
  logTotalChars = 0; logQueue.length = 0; 
});

btnStartDemo?.addEventListener('click', runJoystickDemo);
btnStopDemo?.addEventListener('click', () => {
  isDemoRunning = false;
  btnStartDemo.disabled = false;
  btnStopDemo.disabled = true;
  updateJoystickUI(0, 0); updateMagnetUI(0, 0);
  appendLog('[SYSTEM] Demo stopped.\n', 'log-badprompt');
});

txInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendCommand(txInput.value); }
});

document.querySelectorAll('.quick-cmd').forEach(btn => {
  btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
});

// --- 3D Vector Plot Setup ---
const MAX_TRAIL_POINTS = 60;
const history3D = { x: [], y: [], z: [] };

const layout3D = {
  autosize: true, margin: { l: 0, r: 0, b: 0, t: 0 },
  paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
  scene: {
    aspectmode: 'cube',
    xaxis: { title: 'Bx', range: [-1000, 1000], color: '#A9B8C9', gridcolor: '#1F3A62', zerolinecolor: '#DB4140' },
    yaxis: { title: 'By', range: [-1000, 1000], color: '#A9B8C9', gridcolor: '#1F3A62', zerolinecolor: '#DB4140' },
    zaxis: { title: 'Bz', range: [-1000, 1000], color: '#A9B8C9', gridcolor: '#1F3A62', zerolinecolor: '#DB4140' },
    bgcolor: 'rgba(0,0,0,0)'
  }
};

const traceOrigin = { x: [0], y: [0], z: [0], mode: 'markers', type: 'scatter3d', marker: { size: 6, color: '#A9B8C9', opacity: 0.5 }, name: 'Center' };
const traceTrail = { x: [], y: [], z: [], mode: 'lines', type: 'scatter3d', line: { color: '#8fc1cc', width: 4 }, name: 'Trail' };
const traceLiveBall = { x: [0], y: [0], z: [0], mode: 'markers', type: 'scatter3d', marker: { size: 10, color: '#65BBA9' }, name: 'Live' };

if (document.getElementById('plot-3d-container') && window.Plotly) {
  Plotly.newPlot('plot-3d-container', [traceOrigin, traceTrail, traceLiveBall], layout3D);
}

export function update3DVectorPlot(rx, ry, rz) {
  if (!window.Plotly || !document.getElementById('plot-3d-container')) return;
  const x = typeof rx === 'number' && !isNaN(rx) ? rx : 0;
  const y = typeof ry === 'number' && !isNaN(ry) ? ry : 0;
  const z = typeof rz === 'number' && !isNaN(rz) ? rz : 0;

  history3D.x.push(x); history3D.y.push(y); history3D.z.push(z);
  if (history3D.x.length > MAX_TRAIL_POINTS) {
    history3D.x.shift(); history3D.y.shift(); history3D.z.shift();
  }

  Plotly.react('plot-3d-container', [
    traceOrigin,
    { ...traceTrail, x: history3D.x, y: history3D.y, z: history3D.z },
    { ...traceLiveBall, x: [x], y: [y], z: [z] }
  ], layout3D);
}

document.getElementById('btn-reset-3d-trail')?.addEventListener('click', () => {
  history3D.x = []; history3D.y = []; history3D.z = [];
  if (window.Plotly) {
    Plotly.react('plot-3d-container', [traceOrigin, { ...traceTrail, x: [], y: [], z: [] }, { ...traceLiveBall, x: [0], y: [0], z: [0] }], layout3D);
  }
});

document.getElementById('btn-toggle-debug')?.addEventListener('click', () => {
  miniLogWindow?.classList.toggle('hidden');
});