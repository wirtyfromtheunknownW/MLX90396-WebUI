import { MLX90396_API } from './mlx_api.js';
import { Arduino_API } from './arduino_api.js';
// import { initSfiDemo, resizeSfiCanvases } from './sfi_demo.js';
import { initSfiDemo, resizeSfiCanvases, updateSfiDomeKinematics } from './sfi_demo.js';
import {
  computeTwistSignals,
  deriveTwistInputsFromPoints,
  TWIST_CAL,
  getGainSel,
  setGainSel,
} from './twist_api.js';

// --- DOM Elements (Declared first to avoid TDZ ReferenceErrors) ---
const btnConnect = document.getElementById('btn-connect');

const btnStartDemo = document.getElementById('btn-start-demo');
const btnStopDemo = document.getElementById('btn-stop-demo');
const demoStatus = document.getElementById('demo-status');

function setDemoStatus(text, isActive) {
  if (!demoStatus) return;
  demoStatus.textContent = text;
  demoStatus.classList.toggle('active', !!isActive);
}

// Modal Elements
const selDriverType = document.getElementById('sel-driver-type');
const wrapConnType = document.getElementById('wrap-conn-type');
const selConnType = document.getElementById('sel-conn-type');
const selBaudRate = document.getElementById('sel-baud-rate');
const connectModal = document.getElementById('connect-modal');
const btnModalConnect = document.getElementById('btn-modal-connect');
const btnCloseModal = document.getElementById('btn-close-modal');
const portGuideEl = document.getElementById('port-guide');
const connectErrorEl = document.getElementById('connect-error');

async function refreshPortGuide() {
  if (!portGuideEl || !navigator.serial || !navigator.serial.getPorts) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) {
      portGuideEl.textContent = 'None yet \u2014 pick your device in the Open Serial Port dialog below.';
      return;
    }
    portGuideEl.innerHTML = '';
    ports.forEach((p) => {
      const info = typeof p.getInfo === 'function' ? p.getInfo() : {};
      const vid = info.usbVendorId;
      const pid = info.usbProductId;
      const row = document.createElement('div');
      row.textContent = `Serial Port  \u00b7  VID ${vid != null ? '0x' + vid.toString(16).toUpperCase().padStart(4, '0') : 'n/a'}  \u00b7  PID ${pid != null ? '0x' + pid.toString(16).toUpperCase().padStart(4, '0') : 'n/a'}`;
      portGuideEl.appendChild(row);
    });
  } catch (err) {
    portGuideEl.textContent = 'Unable to read authorized ports.';
  }
}

function showConnectError(msg) {
  if (connectErrorEl) {
    connectErrorEl.textContent = msg || 'Unknown error.';
    connectErrorEl.classList.remove('hidden');
  }
}

function clearConnectError() {
  if (connectErrorEl) {
    connectErrorEl.classList.add('hidden');
    connectErrorEl.textContent = '';
  }
}

function hintForSerialError(raw) {
  const s = String(raw);
  if (s.includes('Failed to open serial port')) {
    return 'Failed to open serial port. The port is almost certainly held open by another program \u2014 close the Arduino IDE Serial Monitor / vendor tools / other browser tabs, unplug & replug the device, then retry.';
  }
  if (s.includes('device not found') || s.includes('No such device')) {
    return 'Device not found. Unplug & replug it, verify its driver is installed, and retry.';
  }
  return raw;
}

// 2D Magnet & UI Elements
const magnetDisk = document.getElementById('magnet-disk');
const btnZeroMagnet = document.getElementById('btn-zero-magnet');
const chkMagnetLockPos = document.getElementById('chk-magnet-lock-pos');
const joystickBase = document.getElementById('joystick-base');
const joystickStick = document.getElementById('joystick-stick');

// --- State Variables ---
let port = null, reader = null, writer = null;
let isConnected = false, isReading = false, isDemoRunning = false;
let textDecoder, textEncoder;
let readableStreamClosed, writableStreamClosed;

let activeDevice = null;
let currentDriverType = 'scpi';

let scpiLock = Promise.resolve();
let scpiWaiter = null;

const magnetOffsets = { x: 0, y: 0 };
const latestRawMagnet = { x: 0, y: 0 };

const leds = [];
const TOTAL_LEDS = 28;
const ANGLE_STEP = 360 / TOTAL_LEDS;

function isViewActive(id) {
  const el = document.getElementById(id);
  return !!el && el.classList.contains('active');
}

// --- Initialize on Startup ---
window.addEventListener('DOMContentLoaded', () => {
  initSfiDemo();
  initJoystickLEDs();
  startRadarLoop();
  initNvramControls();
  initGridReordering();
  initTwistControls();
  refreshPortGuide();
});

// --- Drag & Drop Reordering logic ---
function initGridReordering() {
  const makeReorderable = (containerId, selector) => {
    const container = document.getElementById(containerId);
    if (!container) return;

    let dragged = null;

    container.addEventListener('dragstart', (e) => {
      // Prevent drag from triggering when adjusting inputs or sliders
      if (['INPUT', 'BUTTON', 'LABEL', 'SELECT'].includes(e.target.tagName)) {
        e.preventDefault();
        return;
      }

      const card = e.target.closest(selector);
      if (!card) return;

      dragged = card;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('is-dragging'), 0);
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const target = e.target.closest(selector);
      if (!target || target === dragged || target.parentNode !== container) return;

      const items = Array.from(container.children);
      const draggedIndex = items.indexOf(dragged);
      const targetIndex = items.indexOf(target);

      if (draggedIndex < targetIndex) {
        container.insertBefore(dragged, target.nextSibling);
      } else {
        container.insertBefore(dragged, target);
      }

      if (typeof resizeSfiCanvases === 'function') {
        resizeSfiCanvases();
      }
    });

    container.addEventListener('dragend', () => {
      if (dragged) {
        dragged.classList.remove('is-dragging');
        dragged = null;
      }
      if (typeof resizeSfiCanvases === 'function') {
        resizeSfiCanvases();
      }
    });
  };

  makeReorderable('pixels-grid', '.pixel-card');
  makeReorderable('sfi-dashboard-grid', '.draggable-card');
}

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

// --- 2D Magnet Position & UI ---
const magnetSensorEl = document.querySelector('.magnet-sensor');
function gridHalfPx() {
  const w = magnetSensorEl ? magnetSensorEl.clientWidth : 340;
  return w / 2;
}
const magnetState = { emaX: 0, emaY: 0, emaAngle: 0, inited: false };

function resetMagnetTracking() {
  magnetState.inited = false;
  updateMagnetScaleLabels(2.5);
}

function updateMagnetScaleLabels(mmRange) {
  const half = Math.round(gridHalfPx());
  const travelLbl = document.getElementById('magnet-travel-lbl');
  if (travelLbl) {
    travelLbl.innerHTML = `Sensing Grid: &plusmn;${mmRange.toFixed(1)} mm (&plusmn;${half} px). Disk positions on the grid and rotates with the twist angle.`;
  }
  const factor = mmRange / 2.5;
  document.querySelectorAll('.grid-tick').forEach(el => {
    const base = parseFloat(el.dataset.mm || '0');
    const v = base * factor;
    const sign = base > 0 ? '+' : '';
    const str = v === Math.round(v) ? v.toFixed(0) : v.toFixed(1);
    el.textContent = sign + str;
  });
}

btnZeroMagnet?.addEventListener('click', () => {
  magnetOffsets.x = latestRawMagnet.x;
  magnetOffsets.y = latestRawMagnet.y;
  resetMagnetTracking();
  appendLog(`[MAGNET] Zero Captured: Offset X=${magnetOffsets.x.toFixed(2)} mm, Y=${magnetOffsets.y.toFixed(2)} mm\n`, 'log-okprompt');
});

document.getElementById('btn-toggle-twist')?.addEventListener('click', () => {
  const panel = document.getElementById('twist-panel');
  const btn = document.getElementById('btn-toggle-twist');
  if (panel) {
    panel.classList.toggle('hidden');
    if (btn) btn.classList.toggle('active', !panel.classList.contains('hidden'));
    updateTwistUI(latestTwistPoints);
  }
});

function updateMagnetUI(posX_mm, posY_mm, angleDeg) {
  if (!magnetDisk || !isViewActive('view-magnet')) return;
  const safeX = typeof posX_mm === 'number' && !isNaN(posX_mm) ? posX_mm : 0;
  const safeY = typeof posY_mm === 'number' && !isNaN(posY_mm) ? posY_mm : 0;
  let safeAngle = typeof angleDeg === 'number' && !isNaN(angleDeg) ? angleDeg : 0;

  const ALPHA = 0.4;
  if (!magnetState.inited) {
    magnetState.emaX = safeX;
    magnetState.emaY = safeY;
    magnetState.emaAngle = safeAngle;
    magnetState.inited = true;
  } else {
    magnetState.emaX += (safeX - magnetState.emaX) * ALPHA;
    magnetState.emaY += (safeY - magnetState.emaY) * ALPHA;
    const dA = ((safeAngle - magnetState.emaAngle + 540) % 360) - 180;
    magnetState.emaAngle = ((magnetState.emaAngle + dA * ALPHA) % 360 + 360) % 360;
  }

  // Static grid: fixed +/-2.5 mm span. The scale never re-ranges, so a pure
  // rotation can't rescale the map and make the disk jump. Position motion is
  // EMA-smoothed and clamped at the grid edges; angle spins around the axis.
  // "Lock XY" freezes position (angle-only spin) for twist demos.
  const locked = chkMagnetLockPos ? chkMagnetLockPos.checked : false;
  const mmRange = 2.5;
  const half = gridHalfPx();
  const pxPerMm = half / mmRange;

  const transX = locked ? 0 : Math.max(-half, Math.min(half, magnetState.emaX * pxPerMm));
  const transY = locked ? 0 : Math.max(-half, Math.min(half, -magnetState.emaY * pxPerMm));

  // Sign inverted so a right/CW physical rotation renders as clockwise on
  // screen (CSS rotate counts + as CW, but the raw angle from the device
  // increases for the opposite direction).
  magnetDisk.style.transform = `translate3d(${transX}px, ${transY}px, 0px) rotate(${-magnetState.emaAngle}deg)`;

  updateMagnetScaleLabels(2.5);
}

// --- Twist Signal & Calibration UI ---
let twistMode = '1px';

function initTwistControls() {
  const modeSel = document.getElementById('sel-twist-mode');
  const gainInput = document.getElementById('in-twist-gain');
  const unitLbl = document.getElementById('twist-unit-lbl');
  const calKeys = ['k1', 'k2', 'o11', 'o12', 'o21', 'o22'];

  modeSel?.addEventListener('change', () => {
    twistMode = modeSel.value;
    if (unitLbl) unitLbl.textContent = `Units: ${twistMode === '2px' ? 'mT/mm' : 'mT'}`;
    syncTwistGainField(gainInput);
    updateTwistUI(latestTwistPoints);
  });

  gainInput?.addEventListener('change', () => {
    const v = parseInt(gainInput.value, 10);
    if (!isNaN(v)) setGainSel(twistMode, v);
    syncTwistGainField(gainInput);
  });

  calKeys.forEach(key => {
    const el = document.getElementById(`cal-${key}`);
    el?.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isNaN(v)) TWIST_CAL[key] = v;
    });
  });

  syncTwistGainField(gainInput);
}

function syncTwistGainField(gainInput) {
  if (!gainInput) return;
  const g = getGainSel(twistMode);
  gainInput.value = g;
  const hint = document.getElementById('twist-gain-hint');
  if (hint) {
    hint.textContent = `${twistMode} gain = ${g} (0b${g.toString(2).padStart(6, '0')})`;
  }
}

const latestTwistPoints = [];

function updateTwistUI(points) {
  const twistPanel = document.getElementById('twist-panel');
  if (!isViewActive('view-magnet') || !twistPanel || twistPanel.classList.contains('hidden')) return;
  if (!Array.isArray(points) || points.length < 4) return;

  latestTwistPoints.splice(0, latestTwistPoints.length, ...points);

  const input = deriveTwistInputsFromPoints(points);
  const res = computeTwistSignals(twistMode, input);
  const unit = res.unit;

  const setTxt = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setTxt('twist-alpha', `${res.alphaCalDeg.toFixed(1)}\u00B0`);
  setTxt('twist-beta', `${res.betaCalDeg.toFixed(1)}\u00B0`);
  setTxt('twist-alpha-raw', `${res.alphaDeg.toFixed(1)}\u00B0`);
  setTxt('twist-beta-raw', `${res.betaDeg.toFixed(1)}\u00B0`);
  setTxt('twist-alpha-str', `${res.strengthAlpha.toFixed(2)} ${unit}`);
  setTxt('twist-beta-str', `${res.strengthBeta.toFixed(2)} ${unit}`);
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
  if (!joystickStick || !isViewActive('view-joystick')) return;
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

  pushRadarPoint(renderX, renderY);

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

// --- 2D Radar Scope (shared Joystick data) ---
const radarCanvas = document.getElementById('radar-canvas');
const radarCtx = radarCanvas ? radarCanvas.getContext('2d') : null;
const radarReadout = document.getElementById('radar-readout');
const radarState = { x: 0, y: 0, trail: [] };

function pushRadarPoint(x, y) {
  if (Math.hypot(x, y) < 0.1) {
    radarState.x = 0;
    radarState.y = 0;
    radarState.trail.length = 0;
    return;
  }
  radarState.trail.push({ x, y });
  if (radarState.trail.length > 40) radarState.trail.shift();
  radarState.x = x;
  radarState.y = y;
}

function drawRadar() {
  if (!radarCtx || !isViewActive('view-joystick')) return;

  const { canvas } = radarCtx;
  const size = canvas.width;
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 26;
  const ctx = radarCtx;

  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = '#02050f';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

  [0.25, 0.5, 0.75, 1].forEach(f => {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.strokeStyle = f === 1 ? 'rgba(101,187,169,0.5)' : 'rgba(101,187,169,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  ctx.strokeStyle = 'rgba(101,187,169,0.15)';
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();

  ctx.fillStyle = 'rgba(169,184,201,0.65)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('0°', cx + R + 14, cy);
  ctx.fillText('90°', cx, cy - R - 13);
  ctx.fillText('180°', cx - R - 14, cy);
  ctx.fillText('270°', cx, cy + R + 13);

  radarState.trail.forEach((p, i) => {
    const px = cx + (p.x / 50) * R;
    const py = cy + (p.y / 50) * R;
    ctx.fillStyle = `rgba(101,187,169,${0.15 + (i / radarState.trail.length) * 0.45})`;
    ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill();
  });

  const bx = cx + (radarState.x / 50) * R;
  const by = cy + (radarState.y / 50) * R;
  const range = Math.min(50, Math.hypot(radarState.x, radarState.y));

  const gradVec = ctx.createLinearGradient(cx, cy, bx, by);
  gradVec.addColorStop(0, 'rgba(181,235,220,0.15)');
  gradVec.addColorStop(1, 'rgba(101,187,169,0.95)');
  ctx.strokeStyle = gradVec;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(bx, by);
  ctx.stroke();

  ctx.fillStyle = 'rgba(169,184,201,0.85)';
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${((range / 50) * 100).toFixed(0)}%`, bx + 10, by - 6);

  if (range > 1) {
    ctx.save();
    ctx.shadowColor = '#65BBA9';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#65BBA9';
    ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(101,187,169,0.5)';
    ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.stroke();
  }

  if (radarReadout) {
    const azRaw = Math.atan2(-radarState.y, radarState.x) * (180 / Math.PI);
    const az = azRaw < 0 ? azRaw + 360 : azRaw;
    radarReadout.textContent = `Azimuth: ${az.toFixed(1)}° | Range: ${((range / 50) * 100).toFixed(0)}%`;
  }
}

function startRadarLoop() {
  if (!radarCtx) return;
  const step = () => {
    drawRadar();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// --- Diagnostics Logging (console only; no visible terminal) ---
function appendLog(text, cls) {
  if (!text) return;
  console.log(cls ? `[${cls}] ${text.replace(/\n$/, '')}` : text.replace(/\n$/, ''));
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
  return '\n';
}

async function sendCommand(cmd) {
  if (!writer) return;
  const raw = String(cmd ?? '').trim();
  if (!raw) return;
  try {
    await writer.write(raw + getEol());
  } catch (err) {
    console.error('[TX ERROR]', err);
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

// --- Connection Manager ---
function setUIConnected(connected) {
  isConnected = connected;
  btnConnect.textContent = connected ? 'Disconnect' : 'Connect USB';
  if (connected) btnConnect.classList.add('btn-danger');
  else btnConnect.classList.remove('btn-danger');

  if (btnStartDemo) btnStartDemo.disabled = !connected;

  const isScpi = connected && currentDriverType === 'scpi';
  ['nvram-addr', 'nvram-val', 'btn-nvram-read', 'btn-nvram-write', 'btn-nvram-dump', 'btn-nvram-hs', 'btn-nvram-hr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !isScpi;
  });
}

async function connectSerial() {
  try {
    if (!navigator.serial) {
      connectModal?.classList.remove('hidden');
      showConnectError('This browser does not support the Web Serial API. Use Google Chrome or Microsoft Edge (desktop) \u2014 Firefox and Safari do not implement it.');
      return;
    }
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
    const raw = err && err.message ? err.message : String(err);
    if (port) {
      const failedPort = port;
      port = null;
      try { await failedPort.close(); } catch (_) { /* best effort */ }
    }
    appendLog(`[CONN ERROR]: ${raw}\n`, 'log-badprompt');
    connectModal?.classList.remove('hidden');
    showConnectError(`Could not connect: ${hintForSerialError(raw)}`);
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
  setDemoStatus('Idle', false);
  updateJoystickUI(0, 0);
  updateMagnetUI(0, 0);
  appendLog('[SYSTEM] Port closed.\n', 'log-badprompt');
}

// --- Live Unified Demo Loop ---
async function runJoystickDemo() {
  btnStartDemo.disabled = true;
  btnStopDemo.disabled = false;
  isDemoRunning = true;
  setDemoStatus('Running', true);

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

              updateTwistUI([
                { x: res01.x0, y: res01.y0, z: res01.z0 },
                { x: res01.x1, y: res01.y1, z: res01.z1 },
                { x: res23.x2, y: res23.y2, z: res23.z2 },
                { x: res23.x3, y: res23.y3, z: res23.z3 },
              ]);
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

              if (sample.points && sample.points.length === 4) {
                updateTwistUI(sample.points);
              }
            }
          }

          // Live UI Updates (Placed INSIDE loop after data is read)
          updateMagnetUI(posX_mm, posY_mm, angleDeg);
          updateJoystickUI(rawX / 20, rawY / 20); 
          update3DVectorPlot(rawX, rawY, rawZ);
          
          // Send real normalized telemetry directly to the SFI Dome
          updateSfiDomeKinematics(rawX / 1000, rawY / 1000, rawZ / 1000);

          await new Promise(r => setTimeout(r, currentDriverType === 'scpi' ? 50 : 25));
        } catch (loopErr) {
          console.warn('[DEMO LOOP WARNING]', loopErr);
          await new Promise(r => setTimeout(r, 150));
        }
      }
    } catch (err) {
      appendLog(`[DEMO ERROR]: ${err.message}\n`, 'log-badprompt');
      isDemoRunning = false;
      setDemoStatus('Error', false);
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

      // Synthetic 4-pixel twist field (rotating around Z, constant bias on Z)
      const twistV = Math.sin(angle) * 6;
      const twistW = Math.cos(angle) * 6;
      const bias = 18;
      updateTwistUI([
        { x: twistV, y: twistW, z: bias },
        { x: twistV - 3, y: twistW, z: bias },
        { x: twistV + 3, y: twistW, z: bias },
        { x: twistV, y: twistW - 3, z: bias },
      ]);

      // Drive SFI Dome in emulation mode as well
      updateSfiDomeKinematics(emulatedX / 2, emulatedY / 2, 0);

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
  else {
    clearConnectError();
    connectModal?.classList.remove('hidden');
    if (!navigator.serial) {
      if (btnModalConnect) btnModalConnect.disabled = true;
      showConnectError('This browser does not support the Web Serial API. Use Google Chrome or Microsoft Edge (desktop).');
    } else {
      if (btnModalConnect) btnModalConnect.disabled = false;
    }
    refreshPortGuide();
  }
});

btnCloseModal?.addEventListener('click', () => {
  clearConnectError();
  connectModal?.classList.add('hidden');
});

btnModalConnect?.addEventListener('click', async () => {
  connectModal?.classList.add('hidden');
  await connectSerial();
});

btnStartDemo?.addEventListener('click', runJoystickDemo);
btnStopDemo?.addEventListener('click', () => {
  isDemoRunning = false;
  btnStartDemo.disabled = false;
  btnStopDemo.disabled = true;
  setDemoStatus('Idle', false);
  updateJoystickUI(0, 0); updateMagnetUI(0, 0);
  appendLog('[SYSTEM] Demo stopped.\n', 'log-badprompt');
});

// --- 3D Vector Plot Setup ---
const MAX_TRAIL_POINTS = 60;
const history3D = { x: [], y: [], z: [] };

const layout3D = {
  autosize: true, margin: { l: 0, r: 0, b: 0, t: 0 },
  paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
  scene: {
    aspectmode: 'cube',
    xaxis: { title: 'Bx', range: [-1000, 1000], color: '#A9B8C9', gridcolor: '#33588C', gridwidth: 1, showbackground: true, backgroundcolor: 'rgba(10,20,40,0.35)', zerolinecolor: '#DB4140', zerolinewidth: 2, dtick: 250 },
    yaxis: { title: 'By', range: [-1000, 1000], color: '#A9B8C9', gridcolor: '#33588C', gridwidth: 1, showbackground: true, backgroundcolor: 'rgba(10,20,40,0.35)', zerolinecolor: '#DB4140', zerolinewidth: 2, dtick: 250 },
    zaxis: { title: 'Bz', range: [-1000, 1000], color: '#A9B8C9', gridcolor: '#33588C', gridwidth: 1, showbackground: true, backgroundcolor: 'rgba(10,20,40,0.35)', zerolinecolor: '#DB4140', zerolinewidth: 2, dtick: 250 },
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

  if (!document.getElementById('plot-3d-container') || !isViewActive('view-3dplot')) return;

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