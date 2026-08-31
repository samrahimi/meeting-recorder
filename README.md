# Meeting Recorder

A local webapp that records a Chrome tab, the entire screen, or an app window — along with
system/tab audio and your microphone — and saves a compact, universally playable MP4.

Built for recording browser-based Zoom/Meet/Teams meetings without the desktop apps.

Audio capture per source (a macOS/Chrome limitation, reflected in the UI):

| Source        | Source audio                                | Microphone |
| ------------- | ------------------------------------------- | ---------- |
| Chrome tab    | ✅ tab audio ("Also share tab audio")        | ✅         |
| Entire screen | ✅ system audio (macOS 13+, recent Chrome)   | ✅         |
| App window    | ❌ not supported by Chrome on macOS          | ✅         |

## Requirements

- macOS with Chrome
- Node.js
- ffmpeg (`brew install ffmpeg`)

## Usage

```
npm start
```

Then open **http://localhost:4470** in Chrome.

1. Optionally give the recording a name, click **Choose tab & start recording**.
2. In Chrome's picker, choose the **Chrome Tab** section, pick your meeting tab, and turn on
   **“Also share tab audio”** — that toggle is what captures the other participants' voices.
3. Allow microphone access when prompted (first time only).
4. Click **Stop & save** when done (or Chrome's own "Stop sharing" bar). The server converts
   the recording to MP4 and it appears in the list.

Recordings are saved to `recordings/` in this folder.

## How it works

- The page uses `getDisplayMedia` to capture the tab (video + tab audio) and `getUserMedia`
  for the mic, mixes the two audio sources with the Web Audio API, and records with
  `MediaRecorder` (VP9/Opus WebM).
- Chunks are streamed to the local Node server every 2 seconds, so long meetings never pile
  up in browser memory and a crash loses at most a couple of seconds.
- On stop, the server transcodes with ffmpeg to H.264 (`libx264`, CRF 23) + AAC at the
  original capture resolution, 10 fps — small files with crisp screen-share text.
- If transcoding ever fails, the raw `.webm` is kept in `recordings/` so nothing is lost.

## Notes

- Mic echo cancellation is enabled, so meeting audio playing through your speakers is
  filtered out of the mic track (it's captured cleanly from the tab instead). Headphones
  still give the cleanest result.
- Video-heavy meetings still work fine; 10 fps output just favors screen shares. Bump the
  `-r` value in `server.js` (`transcode()`) if you want smoother motion.
