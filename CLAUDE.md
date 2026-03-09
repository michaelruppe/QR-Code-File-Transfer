# QR File Transfer — Project Brief

## What is this?

A minimal, self-contained webpage that transfers files between two devices using only a screen and a camera — no internet connection, no pairing, no servers. Files are chunked, encoded into a sequence of QR codes, displayed as an animation, and decoded by scanning with the other device's camera.

The initial implementation uses standard black-and-white QR codes. Colour QR codes (higher density) are a future enhancement.

## Hosting

Hosted on Cloudflare Pages — static files only, no Worker backend needed. All encoding/decoding/protocol logic runs entirely in the browser.

> If a Worker is later added (e.g. for signalling/relay), it must use the Cloudflare Workers runtime — no Node.js APIs, no filesystem, fetch-only networking.

## Desired User Experience

### Sender flow
1. Open page → select **Send**
2. Pick a file (any type)
3. Animated QR codes play — one frame at a time, auto-advancing
4. Progress bar shows frames sent; user can pause/resume and adjust speed
5. Loops continuously until manually stopped (missed frames get re-sent for free)

### Receiver flow
1. Open page on second device → select **Receive**
2. Camera feed appears with targeting overlay
3. QR codes are scanned in real time as they play
4. Progress bar fills as frames are captured (out-of-order fine — tracked by index)
5. Once all frames received, file is reassembled and offered as a download

### General UX principles
- Fully offline after page load
- No accounts, no cloud, no tracking
- Mobile-friendly (receiver is typically a phone)
- Clearly shows which frames are still missing so sender can loop again
- Target usable file size: ~100KB–1MB

## Protocol

Each QR code encodes a text payload:
```
[FRAME_INDEX]/[TOTAL_FRAMES]|[FILE_ID]|[BASE64_CHUNK]
```

- `FRAME_INDEX` — zero-based chunk index
- `TOTAL_FRAMES` — total chunks for this file
- `FILE_ID` — short hash of filename + filesize (detects session changes)
- `BASE64_CHUNK` — base64-encoded binary chunk

**Chunk size:** ~800 bytes of raw data per frame (base64 overhead ~33%, leaves headroom for QR error correction at M level)

**Frame rate:** default 3 fps, user-adjustable 1–6 fps

**No explicit ACK in v1** — sender loops, receiver deduplicates by frame index

## Libraries

**Encoding:**
[nayuki/QR-Code-generator](https://github.com/nayuki/QR-Code-generator) — use the ES module JS build; renders to Canvas via raw pixel data

**Decoding:**
[nimiq/qr-scanner](https://github.com/nimiq/qr-scanner) — lightweight, modern camera API, good on live video streams

**Reference implementations:**
- [LucaIaco/QRFileTransfer](https://github.com/LucaIaco/QRFileTransfer) — vanilla JS, closest in spirit; read for protocol ideas
- [divan/txqr](https://github.com/divan/txqr) — fountain codes; reference for future missed-frame recovery
- [QR-io/QR.io](https://github.com/QR-io/QR.io) — bidirectional ACK; reference if handshake is added later

## Proposed File Structure
```
/
├── index.html        # Single page — sender + receiver modes
├── qr-transfer.js   # Core logic: chunking, encoding, decoding, reassembly
└── CLAUDE.md         # This file
```

Deploy via Cloudflare Pages (push static files, done).

## Future Enhancements

- Colour QR codes (3–6× density) via HiQ or JAB Code
- Fountain codes for robust out-of-order recovery (txqr approach)
- Explicit ACK handshake (receiver displays confirmation QR back to sender)
- Deflate compression before chunking (CompressionStream API — available in browsers and Workers)
- Drag-and-drop file input
- Auto-tune QR size based on screen/camera resolution
