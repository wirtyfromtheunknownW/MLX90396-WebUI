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

// --- TRUE SCPI RX PARSER (STRICT LINE BUFFER) ---
let rxLineBuffer = '';

function processRx(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') {
      if (rxLineBuffer.trim() !== '') {
        handleDeviceLine(rxLineBuffer.trim());
        rxLineBuffer = '';
      }
    } else {
      rxLineBuffer += char;
    }
  }
}

function handleDeviceLine(line) {
  let isSuccess = line.includes('(OK)>');
  let isError = line.includes('(ERR)>') || line.includes('(E2BIG)>') || line.includes('(ERANGE)>');
  
  if (isSuccess) appendLog(line + '\n', 'log-okprompt');
  else if (isError) appendLog(line + '\n', 'log-badprompt');
  else appendLog(line + '\n', 'log-rx');

  if (scpiWaiter) {
    if (isSuccess) {
      // Extract data safely after the (OK)> prompt
      const dataPart = line.substring(line.indexOf('(OK)>') + 5).trim();
      scpiWaiter.resolve(dataPart);
      scpiWaiter = null;
    } else if (isError) {
      scpiWaiter.reject(new Error(line));
      scpiWaiter = null;
    }
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
    scpiWaiter = { resolve, reject };
    sendCommand(cmd, true, false); 
    
    setTimeout(() => {
      if (scpiWaiter) {
        scpiWaiter.reject(new Error("Device Timeout on command: " + cmd));
        scpiWaiter = null;
      }
    }, 1500);
  });
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

  const USE_HARDWARE_DEMO = true; 

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
            await new Promise(r => setTimeout(r, 20)); 
            
            const result = await mlxDevice.rm_joystick_xyz(false, 0x3E); 
            
            // Still passing it raw to map directly, avoiding CRC strict killswitch
            updateJoystickUI(result.x0 / 20, result.y0 / 20); 
            
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