import { MLX90396_API } from './mlx_api.js';

// --- DOM Elements ---
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
const apiTestButtons = document.querySelectorAll('.api-btn'); 

const queryQueue = [];
let isProcessingQueue = false;
let rxLineBuffer = '';

// FORCE DEFAULT EOL TO LF (\n)
selEol.value = '\\n';

// --- State Variables ---
let port = null, reader = null, writer = null;
let isConnected = false, isReading = false, isDemoRunning = false;
let textDecoder, textEncoder;
let readableStreamClosed, writableStreamClosed; 
let mlxDevice = null;
let scpiWaiter = null; 

const history = [];
let historyIndex = -1;
let draftBeforeNav = '';

// --- UI Tab Logic & Joystick Setup ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).classList.add('active');
  });
});

const joystickBase = document.getElementById('joystick-base');
const joystickStick = document.getElementById('joystick-stick');
const leds = [];
const TOTAL_LEDS = 28;
const ANGLE_STEP = 360 / TOTAL_LEDS;

function initJoystickLEDs() {
  for (let i = 0; i < TOTAL_LEDS; i++) {
    const led = document.createElement('div');
    led.className = 'joystick__led';
    led.style.transform = `rotate(${(i * ANGLE_STEP) + 90}deg)`;
    joystickBase.appendChild(led);
    leds.push(led);
  }
}
initJoystickLEDs();

function updateJoystickUI(x, y) {
  if (!joystickStick) return;
  const radius = Math.sqrt(x*x + y*y);
  let renderX = x, renderY = y;
  
  if (radius > 50) {
    const scale = 50 / radius;
    renderX *= scale; renderY *= scale;
  }
  
  joystickStick.style.setProperty('--tx', renderX);
  joystickStick.style.setProperty('--ty', renderY);
  leds.forEach(led => led.className = 'joystick__led');

  if (radius > 5) { 
    let angleDeg = Math.atan2(y, x) * (180 / Math.PI);
    if (angleDeg < 0) angleDeg += 360;
    let activeIndex = Math.round(angleDeg / ANGLE_STEP) % TOTAL_LEDS;

    for (let i = -2; i <= 2; i++) {
      let targetIdx = (activeIndex + i + TOTAL_LEDS) % TOTAL_LEDS;
      if (i === 0) leds[targetIdx].classList.add('led-active');
      else if (Math.abs(i) === 1) leds[targetIdx].classList.add('led-low-1');
      else leds[targetIdx].classList.add('led-low-2');
    }
  }
}

// --- High-Performance Dual Logging System ---
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
  logWindow.appendChild(frag);

  if (logTotalChars > LOG_MAX_CHARS) {
    while (logTotalChars > LOG_TRIM_TO && logWindow.firstChild) {
      const n = logWindow.firstChild;
      let len = parseInt(n.dataset?.len || 0, 10) || n.textContent?.length || 0;
      logTotalChars -= len;
      logWindow.removeChild(n);
    }
    while (miniLogWindow && miniLogWindow.childNodes.length > logWindow.childNodes.length) {
      miniLogWindow.removeChild(miniLogWindow.firstChild);
    }
  }

  if (chkAutoScroll.checked) {
    logWindow.scrollTop = logWindow.scrollHeight;
    if (miniLogWindow) miniLogWindow.scrollTop = miniLogWindow.scrollHeight;
  }
}

function appendLog(text, cls) {
  if (!text) return;
  logQueue.push({ text, cls });
  scheduleLogFlush();
}

// --- TRUE SCPI RX PARSER (BULLETPROOF REAL-TIME EVALUATION) ---
let rxBuffer = '';
let lastDataLine = '';

function processRx(text) {
  rxLineBuffer += text;

  while (true) {
    const okIdx = rxLineBuffer.indexOf('(OK)>');
    const errIdx = rxLineBuffer.search(/\(ERR\)>|\(E2BIG\)>|\(ERANGE\)>/);

    // Case 1: Prompt found
    if (okIdx !== -1 && (errIdx === -1 || okIdx < errIdx)) {
      const fullMatch = rxLineBuffer.substring(0, okIdx + 5);
      rxLineBuffer = rxLineBuffer.substring(okIdx + 5);
      handleDeviceResponse(fullMatch, false);
    } 
    // Case 2: Error prompt found
    else if (errIdx !== -1) {
      const endIdx = rxLineBuffer.indexOf('>', errIdx);
      if (endIdx !== -1) {
        const fullMatch = rxLineBuffer.substring(0, endIdx + 1);
        rxLineBuffer = rxLineBuffer.substring(endIdx + 1);
        handleDeviceResponse(fullMatch, true);
      } else {
        break; // Wait for full error prompt
      }
    } 
    // Case 3: Line break without prompt (logs/debug)
    else {
      const nlIdx = rxLineBuffer.search(/[\r\n]/);
      if (nlIdx !== -1) {
        const line = rxLineBuffer.substring(0, nlIdx).trim();
        if (line) appendLog(line + '\n', 'log-rx');
        rxLineBuffer = rxLineBuffer.substring(nlIdx + 1);
      } else {
        break; // Need more bytes from Serial stream
      }
    }
  }
}

function handleDeviceResponse(rawResponse, isError) {
  const trimmed = rawResponse.trim();
  if (!trimmed) return;

  appendLog(trimmed + '\n', isError ? 'log-badprompt' : 'log-okprompt');

  if (queryQueue.length > 0 && isProcessingQueue) {
    const current = queryQueue[0];
    clearTimeout(current.timer);

    if (isError) {
      queryQueue.shift();
      isProcessingQueue = false;
      current.reject(new Error(trimmed));
    } else {
      // 1. Remove (OK)> prompt
      let cleanData = trimmed.replace('(OK)>', '').trim();
      
      // 2. Strip echoed command prefix if MCU echoed it back
      if (cleanData.startsWith(current.cmd)) {
        cleanData = cleanData.substring(current.cmd.length).trim();
      }

      queryQueue.shift();
      isProcessingQueue = false;
      current.resolve(cleanData);
    }

    // Immediately trigger the next query waiting in line
    setTimeout(processQueryQueue, 0);
  }
}

// --- TX Logic & Query Wrapper ---
function getEol() {
  const v = selEol.value;
  if (v === '\\n') return '\n';
  if (v === '\\r') return '\r';
  if (v === '\\r\\n') return '\r\n';
  return '';
}

function updateHistoryUI() {
  historyList.innerHTML = '';
  const displayLimit = Math.min(history.length, 10);
  for (let i = 0; i < displayLimit; i++) {
    const btn = document.createElement('button');
    btn.className = 'hist-item';
    btn.textContent = history[i];
    btn.onclick = () => sendCommand(history[i]);
    historyList.appendChild(btn);
  }
}

async function sendCommand(cmd, echo = true, recordHistory = true) {
  if (!writer) return;
  const raw = cmd.trim();
  if (!raw) return;

  const text = raw + getEol();
  try {
    await writer.write(text);
    if (echo && chkEcho.checked) appendLog(text, 'log-echo');
    
    if (recordHistory && history[0] !== raw) {
      history.unshift(raw);
      if (history.length > 50) history.pop();
      updateHistoryUI();
    }
    
    txInput.value = '';
    historyIndex = -1;
    draftBeforeNav = '';
  } catch (err) {
    appendLog(`[TX ERROR]: ${err.message}\n`, 'log-badprompt');
  }
}

async function scpiQuery(cmd) {
  return new Promise((resolve, reject) => {
    queryQueue.push({ 
      cmd: cmd.trim(), 
      resolve, 
      reject, 
      timer: null 
    });
    processQueryQueue();
  });
}

async function processQueryQueue() {
  if (isProcessingQueue || queryQueue.length === 0) return;

  isProcessingQueue = true;
  const current = queryQueue[0];

  // Individual 1.5s timeout for the active command in queue
  current.timer = setTimeout(() => {
    if (queryQueue[0] === current) {
      queryQueue.shift();
      isProcessingQueue = false;
      current.reject(new Error("Device Timeout on command: " + current.cmd));
      processQueryQueue(); // Process next queued command
    }
  }, 1500);

  try {
    await sendCommand(current.cmd, true, false);
  } catch (err) {
    clearTimeout(current.timer);
    queryQueue.shift();
    isProcessingQueue = false;
    current.reject(err);
    processQueryQueue();
  }
}

// --- Connection Logic ---
function setUIConnected(connected) {
  isConnected = connected;
  btnConnect.textContent = connected ? 'Disconnect' : 'Connect USB';
  if (connected) btnConnect.classList.add('btn-danger');
  else btnConnect.classList.remove('btn-danger');
  
  txInput.disabled = !connected;
  btnSend.disabled = !connected;
  btnStartDemo.disabled = !connected;
  
  apiTestButtons.forEach(btn => btn.disabled = !connected);

  // --- ADD THESE NVRAM LINES HERE ---
  const nvramAddr = document.getElementById('nvram-addr');
  if (nvramAddr) {
    nvramAddr.disabled = !connected;
    document.getElementById('nvram-val').disabled = !connected;
    document.getElementById('btn-nvram-read').disabled = !connected;
    document.getElementById('btn-nvram-write').disabled = !connected;
    document.getElementById('btn-nvram-dump').disabled = !connected;
    document.getElementById('btn-nvram-hs').disabled = !connected;
    document.getElementById('btn-nvram-hr').disabled = !connected;
  }
}

async function connectSerial() {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    textDecoder = new TextDecoderStream();
    textEncoder = new TextEncoderStream();
    readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    writableStreamClosed = textEncoder.readable.pipeTo(port.writable);

    reader = textDecoder.readable.getReader();
    writer = textEncoder.writable.getWriter();

    isReading = true;
    mlxDevice = new MLX90396_API(scpiQuery);
    setUIConnected(true);
    
    appendLog('[SYSTEM] Port opened successfully.\n', 'log-okprompt');

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
  
  port = null; reader = null; writer = null;
  setUIConnected(false);
  updateJoystickUI(0, 0);
  appendLog('[SYSTEM] Port closed.\n', 'log-badprompt');
}

// --- API Testing Logic ---
async function testApiCommand(cmdType) {
  if (!mlxDevice) return;
  appendLog(`[TEST] Executing API Command: ${cmdType.toUpperCase()}...\n`, 'log-okprompt');
  
  try {
    let res;
    switch (cmdType) {
      case 'rt': res = await mlxDevice.rt(); break;
      case 'hs': res = await mlxDevice.hs(); break;
      case 'hr': res = await mlxDevice.hr(); break;
      case 'ex': res = await mlxDevice.ex(1); break;
      case 'rr': res = await mlxDevice.rr(0x00); break;
      case 'wr': res = await mlxDevice.wr(0x00, 0x0000); break;
      case 'sb': res = await mlxDevice.sb(0x3E); break;
      case 'swoc': res = await mlxDevice.swoc(0x3E); break;
      case 'sm': res = await mlxDevice.sm(0x3E); break;
      case 'rm_xyz': res = await mlxDevice.rm_joystick_xyz(false, 0x3E); break;
      case 'rm_sfi': res = await mlxDevice.rm_sfi_joystick(false, 0xAC); break;
    }
    appendLog(`[TEST RESULT] ${JSON.stringify(res)}\n`, 'log-rx');
  } catch (err) {
    appendLog(`[TEST FAILED] ${err.message}\n`, 'log-badprompt');
  }
}

apiTestButtons.forEach(btn => {
  btn.addEventListener('click', () => testApiCommand(btn.dataset.api));
});

// --- Hardware Setup & Demo Loop ---
async function runJoystickDemo() {
  btnStartDemo.disabled = true;
  btnStopDemo.disabled = false;
  isDemoRunning = true;

  const USE_HARDWARE_DEMO = false; 

  if (USE_HARDWARE_DEMO) {
    try {
      appendLog('[SYSTEM] Initializing Hardware...\n', 'log-okprompt');
      await scpiQuery(":SPI:Init 0");
      await scpiQuery(":CON:CS1:GPIO:INIT:OUT 0");
      await scpiQuery(":SPI:BUFfer 1,1,1,1,0"); 
      await scpiQuery(":VDD:OFF");
      await new Promise(r => setTimeout(r, 200)); 
      await scpiQuery(":VDD:3V3");
      await new Promise(r => setTimeout(r, 200)); 
      appendLog('[SYSTEM] Hardware Ready. Starting Stream...\n', 'log-okprompt');

    while (isDemoRunning) {
    try {
        await mlxDevice.sm(0x3E); 
        await new Promise(r => setTimeout(r, 10)); // Allow MCU SPI conversion
        
        const result = await mlxDevice.rm_joystick_xyz(false, 0x3E); 
        updateJoystickUI(result.x0 / 20, result.y0 / 20); 

        await new Promise(r => setTimeout(r, 30)); // Frame rate delay (~25 FPS)
    } catch (loopErr) {
        appendLog(`[LOOP WARN]: ${loopErr.message}\n`, 'log-badprompt');
        await new Promise(r => setTimeout(r, 50)); 
    }
}
    } catch (err) {
      appendLog(`[DEMO ERROR]: ${err.message}\n`, 'log-badprompt');
      isDemoRunning = false;
      btnStartDemo.disabled = false;
      btnStopDemo.disabled = true;
    }
  } else {
    appendLog('[SYSTEM] Starting UI Emulation Mode...\n', 'log-okprompt');
    let angle = 0;
    while (isDemoRunning) {
      angle += 0.15; 
      const emulatedX = (Math.cos(angle) * 35) + (Math.sin(angle * 0.5) * 15);
      const emulatedY = (Math.sin(angle) * 35) + (Math.cos(angle * 1.5) * 15);
      updateJoystickUI(emulatedX, emulatedY);
      await new Promise(r => setTimeout(r, 33)); 
    }
  }
}

// --- Event Listeners ---
btnConnect.addEventListener('click', () => isConnected ? disconnectSerial() : connectSerial());
btnSend.addEventListener('click', () => sendCommand(txInput.value));
btnClear.addEventListener('click', () => { 
  logWindow.textContent = ''; 
  if(miniLogWindow) miniLogWindow.textContent = ''; 
  logTotalChars = 0; 
  logQueue.length = 0; 
});
btnStartDemo.addEventListener('click', runJoystickDemo);

btnStopDemo.addEventListener('click', () => {
  isDemoRunning = false;
  btnStartDemo.disabled = false;
  btnStopDemo.disabled = true;
  updateJoystickUI(0, 0); 
  appendLog('[SYSTEM] Demo stopped.\n', 'log-badprompt');
});

txInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendCommand(txInput.value); return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (history.length === 0) return;
    if (historyIndex === -1) draftBeforeNav = txInput.value;
    historyIndex = Math.min(history.length - 1, historyIndex + 1);
    txInput.value = history[historyIndex];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIndex === -1) return;
    if (historyIndex > 0) {
      historyIndex--;
      txInput.value = history[historyIndex];
    } else {
      historyIndex = -1;
      txInput.value = draftBeforeNav;
    }
  }
});

document.querySelectorAll('.quick-cmd').forEach(btn => {
  btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
});

// --- NVRAM MEMORY CONTROLLER ---
const nvramAddr = document.getElementById('nvram-addr');
const nvramVal = document.getElementById('nvram-val');
const btnNvramRead = document.getElementById('btn-nvram-read');
const btnNvramWrite = document.getElementById('btn-nvram-write');
const btnNvramDump = document.getElementById('btn-nvram-dump');
const btnNvramHs = document.getElementById('btn-nvram-hs');
const btnNvramHr = document.getElementById('btn-nvram-hr');
const nvramTableBody = document.getElementById('nvram-table-body');
const memStatusBadge = document.getElementById('mem-status-badge');

const TOTAL_REGS = 64; // Registers 0x00 to 0x3F
const registerState = new Array(TOTAL_REGS).fill(null);

// Initialize Memory Table
function initMemoryTable() {
  nvramTableBody.innerHTML = '';
  for (let i = 0; i < TOTAL_REGS; i++) {
    const tr = document.createElement('tr');
    tr.dataset.reg = i;
    
    const hexReg = '0x' + i.toString(16).padStart(2, '0').toUpperCase();
    
    tr.innerHTML = `
      <td>${hexReg}</td>
      <td>${i}</td>
      <td class="cell-hex">--</td>
      <td class="cell-dec">--</td>
      <td class="cell-status">Unread</td>
    `;

    tr.addEventListener('click', () => {
      document.querySelectorAll('.mem-table tr').forEach(r => r.classList.remove('selected-row'));
      tr.classList.add('selected-row');
      
      nvramAddr.value = hexReg;
      if (registerState[i] !== null) {
        nvramVal.value = '0x' + registerState[i].toString(16).padStart(4, '0').toUpperCase();
      }
    });

    nvramTableBody.appendChild(tr);
  }
}
initMemoryTable();

// Enable/Disable Memory UI components based on serial state
// const originalSetUIConnected = setUIConnected;
// setUIConnected = function(connected) {
//   originalSetUIConnected(connected);
//   nvramAddr.disabled = !connected;
//   nvramVal.disabled = !connected;
//   btnNvramRead.disabled = !connected;
//   btnNvramWrite.disabled = !connected;
//   btnNvramDump.disabled = !connected;
//   btnNvramHs.disabled = !connected;
//   btnNvramHr.disabled = !connected;
// };

// Helper: Parse Hex or Dec Input
function parseInputNumber(val) {
  if (!val) return NaN;
  const str = val.trim();
  return str.startsWith('0x') || str.startsWith('0X') ? parseInt(str, 16) : parseInt(str, 10);
}

// Update single row in table UI
function updateTableRegisterUI(reg, val, statusText = 'OK') {
  registerState[reg] = val;
  const tr = nvramTableBody.querySelector(`tr[data-reg="${reg}"]`);
  if (!tr) return;

  const hexCell = tr.querySelector('.cell-hex');
  const decCell = tr.querySelector('.cell-dec');
  const statusCell = tr.querySelector('.cell-status');

  const hexVal = '0x' + val.toString(16).padStart(4, '0').toUpperCase();
  
  hexCell.textContent = hexVal;
  decCell.textContent = val;
  statusCell.textContent = statusText;

  hexCell.classList.add('val-updated');
  setTimeout(() => hexCell.classList.remove('val-updated'), 1000);
}

// READ Register
async function readMemoryRegister() {
  const reg = parseInputNumber(nvramAddr.value);
  if (isNaN(reg) || reg < 0 || reg >= TOTAL_REGS) {
    appendLog('[MEM ERROR] Invalid Register Address\n', 'log-badprompt');
    return;
  }

  try {
    memStatusBadge.textContent = `Reading ${reg}...`;
    const res = await mlxDevice.rr(reg);
    
    if (!res.error) {
      nvramVal.value = '0x' + res.data.toString(16).padStart(4, '0').toUpperCase();
      updateTableRegisterUI(reg, res.data, 'Read OK');
      appendLog(`[MEM READ] Reg 0x${reg.toString(16).toUpperCase()}: 0x${res.data.toString(16).toUpperCase()}\n`, 'log-okprompt');
    } else {
      appendLog(`[MEM ERROR] Read failed at Reg 0x${reg.toString(16).toUpperCase()}\n`, 'log-badprompt');
    }
  } catch (err) {
    appendLog(`[MEM ERROR] ${err.message}\n`, 'log-badprompt');
  } finally {
    memStatusBadge.textContent = 'Ready';
  }
}

// WRITE Register
async function writeMemoryRegister() {
  const reg = parseInputNumber(nvramAddr.value);
  const val = parseInputNumber(nvramVal.value);

  if (isNaN(reg) || reg < 0 || reg >= TOTAL_REGS) {
    appendLog('[MEM ERROR] Invalid Register Address\n', 'log-badprompt');
    return;
  }
  if (isNaN(val) || val < 0 || val > 0xFFFF) {
    appendLog('[MEM ERROR] Invalid 16-bit Value (0x0000 - 0xFFFF)\n', 'log-badprompt');
    return;
  }

  try {
    memStatusBadge.textContent = `Writing ${reg}...`;
    const err = await mlxDevice.wr(reg, val);
    
    if (!err) {
      updateTableRegisterUI(reg, val, 'Written');
      appendLog(`[MEM WRITE] Written 0x${val.toString(16).toUpperCase()} to Reg 0x${reg.toString(16).toUpperCase()}\n`, 'log-okprompt');
    } else {
      appendLog(`[MEM ERROR] CRC or Write Error on Reg 0x${reg.toString(16).toUpperCase()}\n`, 'log-badprompt');
    }
  } catch (err) {
    appendLog(`[MEM ERROR] ${err.message}\n`, 'log-badprompt');
  } finally {
    memStatusBadge.textContent = 'Ready';
  }
}

// Dump All Registers
async function dumpAllMemory() {
  btnNvramDump.disabled = true;
  appendLog('[MEM DUMP] Starting full register scan...\n', 'log-okprompt');
  
  for (let i = 0; i < TOTAL_REGS; i++) {
    try {
      memStatusBadge.textContent = `Dumping ${i}/${TOTAL_REGS}`;
      const res = await mlxDevice.rr(i);
      if (!res.error) {
        updateTableRegisterUI(i, res.data, 'Dumped');
      }
      await new Promise(r => setTimeout(r, 10)); // Prevent serial queue flooding
    } catch (err) {
      appendLog(`[MEM DUMP WARN] Error at reg ${i}: ${err.message}\n`, 'log-badprompt');
    }
  }
  
  memStatusBadge.textContent = 'Ready';
  btnNvramDump.disabled = false;
  appendLog('[MEM DUMP] Register scan completed.\n', 'log-okprompt');
}

// Event Listeners
btnNvramRead.addEventListener('click', readMemoryRegister);
btnNvramWrite.addEventListener('click', writeMemoryRegister);
btnNvramDump.addEventListener('click', dumpAllMemory);
btnNvramHs.addEventListener('click', async () => {
  await mlxDevice.hs();
  appendLog('[MEM] Memory Store command (HS) executed.\n', 'log-okprompt');
});
btnNvramHr.addEventListener('click', async () => {
  await mlxDevice.hr();
  appendLog('[MEM] Memory Recall command (HR) executed.\n', 'log-okprompt');
});

// --- JOYSTICK CALIBRATION MODULE ---
const calibState = {
  offsetX: 0,
  offsetY: 0,
  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
  deadbandPct: 3,
  isSweeping: false,
  isCalibrated: false
};

const sweepPoints = [];

// UI Elements
const btnCalibZero = document.getElementById('btn-calib-zero');
const btnCalibSweep = document.getElementById('btn-calib-sweep');
const btnCalibSave = document.getElementById('btn-calib-save');
const inputDeadband = document.getElementById('input-deadband');
const valDeadband = document.getElementById('val-deadband');
const calibCanvas = document.getElementById('calib-canvas');
const ctxCalib = calibCanvas ? calibCanvas.getContext('2d') : null;

// Enable buttons when device connects
const calibSetUIConnected = setUIConnected;
setUIConnected = function(connected) {
  calibSetUIConnected(connected);
  if (btnCalibZero) btnCalibZero.disabled = !connected;
  if (btnCalibSweep) btnCalibSweep.disabled = !connected;
  if (btnCalibSave) btnCalibSave.disabled = !connected;
};

// Canvas Radar Grid Drawing
function drawRadarGrid() {
  if (!ctxCalib) return;
  const w = calibCanvas.width;
  const h = calibCanvas.height;
  const cx = w / 2;
  const cy = h / 2;

  ctxCalib.clearRect(0, 0, w, h);

  // Target Rings
  ctxCalib.strokeStyle = '#1F3A62';
  ctxCalib.lineWidth = 1;
  [35, 70, 110].forEach(r => {
    ctxCalib.beginPath();
    ctxCalib.arc(cx, cy, r, 0, 2 * Math.PI);
    ctxCalib.stroke();
  });

  // Crosshairs
  ctxCalib.beginPath();
  ctxCalib.moveTo(cx, 10); ctxCalib.lineTo(cx, h - 10);
  ctxCalib.moveTo(10, cy); ctxCalib.lineTo(w - 10, cy);
  ctxCalib.stroke();

  // Draw Captured Trace Points
  if (sweepPoints.length > 1) {
    ctxCalib.strokeStyle = '#59FFB0';
    ctxCalib.lineWidth = 2;
    ctxCalib.beginPath();

    for (let i = 0; i < sweepPoints.length; i++) {
      const pt = sweepPoints[i];
      // Scale raw values to canvas pixels (~30 LSB/px)
      const px = cx + ((pt.x - calibState.offsetX) / 25);
      const py = cy - ((pt.y - calibState.offsetY) / 25);

      if (i === 0) ctxCalib.moveTo(px, py);
      else ctxCalib.lineTo(px, py);
    }
    ctxCalib.stroke();
  }
}
drawRadarGrid();

// Step 1: Capture Zero Center
btnCalibZero?.addEventListener('click', async () => {
  try {
    const res = await mlxDevice.rm_joystick_xyz(false, 0x3E);
    if (!res.error) {
      calibState.offsetX = res.x0;
      calibState.offsetY = res.y0;

      document.getElementById('telem-off-x').textContent = calibState.offsetX;
      document.getElementById('telem-off-y').textContent = calibState.offsetY;
      
      // Update step wizard UI
      document.getElementById('step-1').classList.remove('active');
      document.getElementById('step-2').classList.add('active');
      appendLog(`[CALIB] Zero Center Captured: X=${calibState.offsetX}, Y=${calibState.offsetY}\n`, 'log-okprompt');
    }
  } catch (err) {
    appendLog(`[CALIB ERROR] Zero Capture Failed: ${err.message}\n`, 'log-badprompt');
  }
});

// Step 2: Toggle Range Sweep Mode
btnCalibSweep?.addEventListener('click', () => {
  calibState.isSweeping = !calibState.isSweeping;

  if (calibState.isSweeping) {
    btnCalibSweep.textContent = 'Stop & Process Sweep';
    btnCalibSweep.classList.add('btn-danger');
    sweepPoints.length = 0;
    appendLog('[CALIB] Rotate joystick 360° to record boundaries...\n', 'log-okprompt');
  } else {
    btnCalibSweep.textContent = 'Start Sweep Recording';
    btnCalibSweep.classList.remove('btn-danger');
    
    document.getElementById('step-2').classList.remove('active');
    document.getElementById('step-3').classList.add('active');

    const spanX = calibState.maxX - calibState.minX;
    const spanY = calibState.maxY - calibState.minY;
    document.getElementById('telem-span').textContent = `${spanX} x ${spanY}`;
    appendLog(`[CALIB] Sweep finished. Span X: ${spanX}, Span Y: ${spanY}\n`, 'log-okprompt');
  }
});

// Step 3: Deadband Slider Adjust
inputDeadband?.addEventListener('input', (e) => {
  calibState.deadbandPct = parseInt(e.target.value, 10);
  if (valDeadband) valDeadband.textContent = `${calibState.deadbandPct}%`;
});

// Step 4: Apply Calibration
btnCalibSave?.addEventListener('click', () => {
  calibState.isCalibrated = true;
  document.getElementById('telem-status').textContent = 'Active (Calibrated)';
  document.getElementById('telem-status').style.color = '#59FFB0';
  
  document.getElementById('step-3').classList.remove('active');
  document.getElementById('step-4').classList.add('active');
  
  appendLog('[CALIB] Calibration profile applied successfully.\n', 'log-okprompt');
});

// Clear Plot Button
document.getElementById('btn-clear-plot')?.addEventListener('click', () => {
  sweepPoints.length = 0;
  drawRadarGrid();
});

// Helper function to process raw values through active calibration settings
export function processCalibratedCoordinates(rawX, rawY) {
  // 1. Subtract Zero Center
  let x = rawX - calibState.offsetX;
  let y = rawY - calibState.offsetY;

  // 2. Capture Min/Max during active sweep mode
  if (calibState.isSweeping) {
    if (x < calibState.minX) calibState.minX = x;
    if (x > calibState.maxX) calibState.maxX = x;
    if (y < calibState.minY) calibState.minY = y;
    if (y > calibState.maxY) calibState.maxY = y;

    sweepPoints.push({ x: rawX, y: rawY });
    if (sweepPoints.length % 3 === 0) drawRadarGrid(); // Redraw canvas periodically
  }

  // 3. Apply Deadband Filter
  if (calibState.isCalibrated) {
    const radius = Math.sqrt(x * x + y * y);
    const maxSpan = Math.max(calibState.maxX || 1000, 1000);
    const deadbandCutoff = (maxSpan * calibState.deadbandPct) / 100;

    if (radius < deadbandCutoff) {
      x = 0;
      y = 0;
    }
  }

  return { x, y };
}

// --- Debug Terminal Toggle ---
const btnToggleDebug = document.getElementById('btn-toggle-debug');

btnToggleDebug.addEventListener('click', () => {
  if (!miniLogWindow) return;
  
  // Toggle visibility class on the mini terminal window
  const isHidden = miniLogWindow.classList.toggle('hidden');
  
//   // Highlight the Debug button when active
//   if (isHidden) {
//     btnToggleDebug.classList.add('btn-secondary');
//   } else {
//     btnToggleDebug.classList.remove('btn-secondary');
//   }
});