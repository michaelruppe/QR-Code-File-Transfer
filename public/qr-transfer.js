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

let chunks = [];
let fileId = '';
let fileName = '';
let totalFrames = 0;
let currentFrame = 0;
let playing = false;
let intervalId = null;
let playlist = [];          // indices of frames still to send
let senderCameraStream = null;
let senderScanId = null;

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

  // Chunk into base64 pieces based on selected density
  const chunkRawSize = parseInt(document.getElementById('density-select').value, 10);
  chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkRawSize) {
    const slice = bytes.subarray(offset, offset + chunkRawSize);
    chunks.push(uint8ToBase64(slice));
  }
  totalFrames = chunks.length;
  playlist = Array.from({ length: totalFrames }, (_, i) => i);
  currentFrame = 0;

  document.getElementById('file-info').textContent =
    `${file.name} — ${formatSize(file.size)} — ${totalFrames} frames`;
  document.getElementById('qr-display').style.display = 'flex';

  startPlaying();
  startSenderCamera();
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

  const acked = totalFrames - playlist.length;
  document.getElementById('frame-status').textContent =
    `Frame ${index + 1} / ${totalFrames} (${playlist.length} remaining)`;
  document.getElementById('send-progress').style.width =
    (acked / totalFrames * 100) + '%';
}

// ── Playback controls ──────────────────────────────────────────

function startPlaying() {
  if (playlist.length === 0) return;
  playing = true;
  document.getElementById('pause-btn').textContent = 'Pause';
  currentFrame = 0;
  renderFrame(playlist[currentFrame]);
  intervalId = setInterval(advanceFrame, 1000 / getFps());
}

function advanceFrame() {
  if (playlist.length === 0) return;
  currentFrame = (currentFrame + 1) % playlist.length;
  renderFrame(playlist[currentFrame]);
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
  playlist = [];
  stopSenderCamera();
}

// ── Sender: ACK scanner (camera) ───────────────────────────────

function startSenderCamera() {
  const video = document.getElementById('sender-camera');
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
  }).then((stream) => {
    senderCameraStream = stream;
    video.srcObject = stream;
    video.play();
    document.getElementById('sender-ack-status').textContent = 'ACK: listening…';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    senderScanId = setInterval(() => {
      if (video.readyState < video.HAVE_ENOUGH_DATA) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) handleAckScan(code.data);
    }, 150);
  }).catch((err) => {
    document.getElementById('sender-ack-status').textContent = 'ACK: no camera (' + err + ')';
  });
}

function handleAckScan(data) {
  // Parse: ACK|FILE_ID|FRAME_INDEX
  if (!data.startsWith('ACK|')) return;
  const parts = data.split('|');
  if (parts.length !== 3) return;
  const ackFileId = parts[1];
  const ackIndex = parseInt(parts[2], 10);
  if (ackFileId !== fileId || isNaN(ackIndex)) return;

  // Remove ACK'd frame from playlist
  const pos = playlist.indexOf(ackIndex);
  if (pos !== -1) {
    playlist.splice(pos, 1);
    // Adjust currentFrame pointer if needed
    if (currentFrame >= playlist.length) currentFrame = 0;

    const acked = totalFrames - playlist.length;
    document.getElementById('sender-ack-status').textContent =
      `ACK: ${acked} / ${totalFrames} confirmed`;
    document.getElementById('send-progress').style.width =
      (acked / totalFrames * 100) + '%';

    if (playlist.length === 0) {
      clearInterval(intervalId);
      playing = false;
      document.getElementById('frame-status').textContent = 'All frames ACK\'d!';
      stopSenderCamera();
    }
  }
}

function stopSenderCamera() {
  if (senderScanId) {
    clearInterval(senderScanId);
    senderScanId = null;
  }
  if (senderCameraStream) {
    senderCameraStream.getTracks().forEach(t => t.stop());
    senderCameraStream = null;
  }
}

// ── Receiver ───────────────────────────────────────────────────

let cameraStream = null;
let scanIntervalId = null;
let receivedChunks = {};  // index -> base64 string
let recvTotalFrames = 0;
let recvFileId = '';
let recvFileName = '';

function startReceiver() {
  receivedChunks = {};
  recvTotalFrames = 0;
  recvFileId = '';
  recvFileName = '';
  updateReceiverUI();

  const video = document.getElementById('camera-view');
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
  }).then((stream) => {
    cameraStream = stream;
    video.srcObject = stream;
    video.play();
    document.getElementById('receiver-status').textContent = 'Scanning…';

    // Create offscreen canvas for frame capture
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    scanIntervalId = setInterval(() => {
      if (video.readyState < video.HAVE_ENOUGH_DATA) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) handleScan(code.data);
    }, 80); // ~12 scans per second
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
    renderAckQR(scannedFileId, frameIndex);
    updateReceiverUI();
  }

  // Check if complete
  const received = Object.keys(receivedChunks).length;
  if (received === recvTotalFrames) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
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

function renderAckQR(ackFileId, frameIndex) {
  const payload = `ACK|${ackFileId}|${frameIndex}`;
  const canvas = document.getElementById('ack-qr-canvas');
  const ctx = canvas.getContext('2d');
  const qr = QrCode.encodeText(payload, Ecc.LOW);
  const size = qr.size;
  const border = 2;
  const canvasPx = 150;

  canvas.width = canvasPx;
  canvas.height = canvasPx;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasPx, canvasPx);

  const scale = Math.floor(canvasPx / (size + border * 2));
  const offset = Math.floor((canvasPx - (size + border * 2) * scale) / 2);

  ctx.fillStyle = '#000000';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect(offset + (x + border) * scale, offset + (y + border) * scale, scale, scale);
      }
    }
  }
}

function stopReceiver() {
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
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
