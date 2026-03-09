// ── Mode switching ──────────────────────────────────────────────

function showPanel(mode) {
  document.getElementById('mode-select').style.display = mode ? 'none' : 'flex';
  document.getElementById('sender-panel').style.display = mode === 'sender' ? 'flex' : 'none';
  document.getElementById('receiver-panel').style.display = mode === 'receiver' ? 'flex' : 'none';

  // Cleanup when leaving a panel
  if (mode !== 'sender') stopSender();
  if (mode !== 'receiver') stopReceiver();
  if (mode === 'receiver') startReceiver();
}

// ── Sender state ───────────────────────────────────────────────

const CHUNK_RAW_SIZE = 800;
let chunks = [];
let fileId = '';
let fileName = '';
let totalFrames = 0;
let currentFrame = 0;
let playing = false;
let intervalId = null;

function getFps() {
  return parseInt(document.getElementById('speed-slider').value, 10);
}

document.getElementById('speed-slider').addEventListener('input', (e) => {
  document.getElementById('speed-label').textContent = e.target.value + ' fps';
  if (playing) {
    clearInterval(intervalId);
    intervalId = setInterval(advanceFrame, 1000 / getFps());
  }
});

// ── File selection & chunking ──────────────────────────────────

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Generate short file ID (hash of name + size) and store filename
  fileId = simpleHash(file.name + file.size);
  fileName = file.name;

  // Chunk into base64 pieces
  chunks = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_RAW_SIZE) {
    const slice = bytes.subarray(offset, offset + CHUNK_RAW_SIZE);
    chunks.push(uint8ToBase64(slice));
  }
  totalFrames = chunks.length;
  currentFrame = 0;

  document.getElementById('file-info').textContent =
    `${file.name} — ${formatSize(file.size)} — ${totalFrames} frames`;
  document.getElementById('qr-display').style.display = 'flex';

  startPlaying();
});

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function uint8ToBase64(uint8) {
  let bin = '';
  for (let i = 0; i < uint8.length; i++) bin += String.fromCharCode(uint8[i]);
  return btoa(bin);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── QR rendering ───────────────────────────────────────────────

const QrCode = qrcodegen.QrCode;
const Ecc = QrCode.Ecc;

function renderFrame(index) {
  const payload = `${index}/${totalFrames}|${fileId}|${fileName}|${chunks[index]}`;
  const canvas = document.getElementById('qr-canvas');
  const ctx = canvas.getContext('2d');

  const qr = QrCode.encodeText(payload, Ecc.MEDIUM);
  const size = qr.size;
  const border = 2;
  const canvasPx = 300;

  canvas.width = canvasPx;
  canvas.height = canvasPx;

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasPx, canvasPx);

  // Scale to fit and center
  const scale = Math.floor(canvasPx / (size + border * 2));
  const offset = Math.floor((canvasPx - (size + border * 2) * scale) / 2);

  // Draw modules
  ctx.fillStyle = '#000000';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect(offset + (x + border) * scale, offset + (y + border) * scale, scale, scale);
      }
    }
  }

  document.getElementById('frame-status').textContent =
    `Frame ${index + 1} / ${totalFrames}`;
  document.getElementById('send-progress').style.width =
    ((index + 1) / totalFrames * 100) + '%';
}

// ── Playback controls ──────────────────────────────────────────

function startPlaying() {
  playing = true;
  document.getElementById('pause-btn').textContent = 'Pause';
  renderFrame(currentFrame);
  intervalId = setInterval(advanceFrame, 1000 / getFps());
}

function advanceFrame() {
  currentFrame = (currentFrame + 1) % totalFrames;
  renderFrame(currentFrame);
}

function togglePause() {
  if (playing) {
    clearInterval(intervalId);
    playing = false;
    document.getElementById('pause-btn').textContent = 'Resume';
  } else {
    startPlaying();
  }
}

function stopSender() {
  clearInterval(intervalId);
  playing = false;
  chunks = [];
  totalFrames = 0;
  currentFrame = 0;
}

// ── Receiver ───────────────────────────────────────────────────

let scanner = null;
let receivedChunks = {};  // index -> base64 string
let recvTotalFrames = 0;
let recvFileId = '';
let recvFileName = '';

QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js';

function startReceiver() {
  receivedChunks = {};
  recvTotalFrames = 0;
  recvFileId = '';
  updateReceiverUI();

  const video = document.getElementById('camera-view');
  scanner = new QrScanner(video, (result) => {
    const data = typeof result === 'string' ? result : result.data;
    handleScan(data);
  }, {
    highlightScanRegion: true,
    highlightCodeOutline: true,
  });
  scanner.start().then(() => {
    document.getElementById('receiver-status').textContent = 'Scanning…';
  }).catch((err) => {
    document.getElementById('receiver-status').textContent = 'Camera error: ' + err;
  });
}

function handleScan(data) {
  // Parse protocol: INDEX/TOTAL|FILE_ID|FILENAME|BASE64_CHUNK
  const pipeIdx1 = data.indexOf('|');
  const pipeIdx2 = data.indexOf('|', pipeIdx1 + 1);
  const pipeIdx3 = data.indexOf('|', pipeIdx2 + 1);
  if (pipeIdx1 === -1 || pipeIdx2 === -1 || pipeIdx3 === -1) return;

  const header = data.slice(0, pipeIdx1);
  const scannedFileId = data.slice(pipeIdx1 + 1, pipeIdx2);
  const scannedFileName = data.slice(pipeIdx2 + 1, pipeIdx3);
  const chunk = data.slice(pipeIdx3 + 1);

  const slashIdx = header.indexOf('/');
  if (slashIdx === -1) return;

  const frameIndex = parseInt(header.slice(0, slashIdx), 10);
  const totalFrames = parseInt(header.slice(slashIdx + 1), 10);
  if (isNaN(frameIndex) || isNaN(totalFrames)) return;

  // Detect session change
  if (recvFileId && scannedFileId !== recvFileId) {
    receivedChunks = {};
  }

  recvFileId = scannedFileId;
  recvFileName = scannedFileName;
  recvTotalFrames = totalFrames;

  if (!receivedChunks.hasOwnProperty(frameIndex)) {
    receivedChunks[frameIndex] = chunk;
    updateReceiverUI();
  }

  // Check if complete
  const received = Object.keys(receivedChunks).length;
  if (received === recvTotalFrames) {
    scanner.stop();
    document.getElementById('receiver-status').textContent = 'Transfer complete!';
    document.getElementById('download-btn').style.display = 'block';
  }
}

function updateReceiverUI() {
  const received = Object.keys(receivedChunks).length;
  const total = recvTotalFrames || 1;
  const pct = (received / total * 100).toFixed(0);
  document.getElementById('receiver-status').textContent =
    recvTotalFrames ? `Received ${received} / ${recvTotalFrames} frames (${pct}%)` : 'Scanning…';
  document.getElementById('recv-progress').style.width = (received / total * 100) + '%';
}

function stopReceiver() {
  if (scanner) {
    scanner.stop();
    scanner.destroy();
    scanner = null;
  }
  receivedChunks = {};
  recvTotalFrames = 0;
  recvFileId = '';
  recvFileName = '';
  document.getElementById('download-btn').style.display = 'none';
}

function downloadFile() {
  if (!recvTotalFrames) return;

  // Reassemble base64 chunks into binary
  const parts = [];
  for (let i = 0; i < recvTotalFrames; i++) {
    const b64 = receivedChunks[i];
    if (!b64) { alert('Missing frame ' + i); return; }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    parts.push(bytes);
  }

  const blob = new Blob(parts, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = recvFileName || 'received_file';
  a.click();
  URL.revokeObjectURL(url);
}
