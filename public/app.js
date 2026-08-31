'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  recorder: null,
  displayStream: null,
  micStream: null,
  mixedStream: null,
  audioCtx: null,
  analysers: {},
  uploadQueue: Promise.resolve(),
  uploadFailed: false,
  startedAt: 0,
  timerInterval: null,
  meterRaf: null,
};

// ---------- helpers ----------

function fmtTime(secs) {
  secs = Math.floor(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function show(cardId) {
  for (const id of ['setup-card', 'recording-card', 'processing-card', 'done-card']) {
    $(id).hidden = id !== cardId;
  }
}

const MODE_HINTS = {
  browser:
    'In the picker, pick the <strong>Chrome Tab</strong> section, select your meeting tab, and ' +
    'make sure <strong>“Also share tab audio”</strong> is switched on — that\'s how the other ' +
    'participants\' voices get recorded.',
  monitor:
    'In the picker, pick <strong>Entire Screen</strong> and switch on <strong>“Also share system ' +
    'audio”</strong> to capture everything your speakers play (needs macOS 13+ and a recent ' +
    'Chrome). First time only: macOS will ask you to grant Chrome <strong>Screen Recording</strong> ' +
    'permission in System Settings, then quit and reopen Chrome.',
  window:
    'In the picker, pick the <strong>Window</strong> section and choose the app. Note: on macOS, ' +
    'Chrome <strong>cannot capture audio from a single window</strong> — only your microphone will ' +
    'be recorded. If you need the app\'s sound too, choose “Entire screen” instead.',
};

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function getSettings() {
  return {
    audioOnly: document.querySelector('input[name="output"]:checked').value === 'audio',
    fps: parseInt($('fps').value, 10),
    crf: parseInt($('quality').value, 10),
    useMic: $('use-mic').checked,
  };
}

function updateModeHint() {
  let html = MODE_HINTS[selectedMode()];
  if (getSettings().audioOnly) {
    html += ' <em>Audio-only: the picker still shows video sources — that\'s just how the ' +
      'audio is captured; only the sound is kept.</em>';
  }
  document.getElementById('mode-hint').innerHTML = html;
}

function updateSettingsUI() {
  $('video-settings').classList.toggle('disabled', getSettings().audioOnly);
  updateModeHint();
}

const SETTINGS_KEY = 'recorder-settings';

function persistSettings() {
  const s = getSettings();
  s.mode = selectedMode();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function restoreSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch {}
  if (!s) return;
  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  if (s.mode) setRadio('mode', s.mode);
  setRadio('output', s.audioOnly ? 'audio' : 'video');
  if ([5, 10, 15, 24, 30].includes(s.fps)) $('fps').value = s.fps;
  if ([20, 23, 28].includes(s.crf)) $('quality').value = s.crf;
  if (typeof s.useMic === 'boolean') $('use-mic').checked = s.useMic;
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

// ---------- audio mixing ----------

function buildMixedStream(displayStream, micStream) {
  const videoTrack = displayStream.getVideoTracks()[0];
  const tabAudio = displayStream.getAudioTracks()[0] || null;
  const micAudio = micStream ? micStream.getAudioTracks()[0] || null : null;

  if (!tabAudio && !micAudio) {
    // Video-only recording.
    return { stream: new MediaStream([videoTrack]), tabAudio, micAudio };
  }

  const ctx = new AudioContext();
  state.audioCtx = ctx;
  const dest = ctx.createMediaStreamDestination();

  const hookUp = (track, key, gainValue) => {
    if (!track) return;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(gain);
    gain.connect(analyser);
    analyser.connect(dest);
    state.analysers[key] = analyser;
  };

  hookUp(tabAudio, 'tab', 1.0);
  hookUp(micAudio, 'mic', 1.0);

  return {
    stream: new MediaStream([videoTrack, dest.stream.getAudioTracks()[0]]),
    tabAudio, micAudio,
  };
}

function drawMeters() {
  const buf = new Uint8Array(128);
  const update = (key, elId) => {
    const analyser = state.analysers[key];
    const el = $(elId);
    if (!analyser) { el.style.width = '0%'; return; }
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    el.style.width = Math.min(100, (peak / 128) * 220) + '%';
  };
  update('tab', 'tab-level');
  update('mic', 'mic-level');
  state.meterRaf = requestAnimationFrame(drawMeters);
}

// ---------- upload pipeline ----------

function enqueueChunk(blob) {
  state.uploadQueue = state.uploadQueue.then(async () => {
    if (state.uploadFailed) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`/api/chunk?id=${state.sessionId}`, {
          method: 'POST', body: blob,
        });
        if (!res.ok) throw new Error('server responded ' + res.status);
        return;
      } catch (e) {
        if (attempt === 3) {
          state.uploadFailed = true;
          $('rec-warnings').textContent = '⚠ upload to local server failing — check that the server is still running';
        } else {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
  });
}

// ---------- main flow ----------

async function startRecording() {
  $('setup-error').hidden = true;
  const settings = getSettings();
  state.settings = settings;
  const wantMic = settings.useMic;

  const mode = selectedMode();
  // In audio-only mode a video track is still required (Chrome won't do
  // audio-only display capture), so grab a cheap low-fps one and discard it later.
  const captureFps = settings.audioOnly ? 5 : settings.fps;
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: captureFps, max: captureFps },
        displaySurface: mode, // pre-selects the matching section in Chrome's picker
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
      preferCurrentTab: false,
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      // Distinguish "user cancelled the picker" from "macOS blocked Chrome".
      if (/system|permission denied by/i.test(e.message)) {
        return showSetupError(
          'macOS blocked screen capture. Grant Chrome the Screen Recording permission in ' +
          'System Settings → Privacy & Security → Screen & System Audio Recording, then ' +
          'quit and reopen Chrome.');
      }
      return; // user cancelled the picker
    }
    return showSetupError('Could not capture: ' + e.message);
  }

  let micStream = null;
  if (wantMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      $('rec-warnings').textContent = '⚠ microphone unavailable (' + e.name + ') — recording without it';
    }
  }

  state.displayStream = displayStream;
  state.micStream = micStream;

  const { stream, tabAudio } = buildMixedStream(displayStream, micStream);
  state.mixedStream = stream;

  if (!tabAudio) {
    // Warn based on what was actually picked, not what was pre-selected.
    const surface = displayStream.getVideoTracks()[0].getSettings().displaySurface || mode;
    const warnings = {
      browser: '⚠ no tab audio — did you enable “Also share tab audio” in the picker?',
      monitor: '⚠ no system audio — enable “Also share system audio” in the picker (needs macOS 13+ and a recent Chrome)' +
        (micStream ? '; recording mic only' : ''),
      window: '⚠ window capture has no audio on macOS — recording ' + (micStream ? 'mic only' : 'video only'),
    };
    $('rec-warnings').textContent = warnings[surface] || '⚠ no source audio — recording ' + (micStream ? 'mic only' : 'video only');
  }

  // Start a server session.
  const name = $('rec-name').value.trim();
  let startRes;
  try {
    startRes = await fetch('/api/start?name=' + encodeURIComponent(name), { method: 'POST' });
    if (!startRes.ok) throw new Error('server responded ' + startRes.status);
  } catch (e) {
    stopAllTracks();
    return showSetupError('Local server not reachable — is it running? (' + e.message + ')');
  }
  state.sessionId = (await startRes.json()).id;
  state.uploadFailed = false;
  state.uploadQueue = Promise.resolve();

  // Recorder. Bitrate is generous because ffmpeg re-encodes to the final size.
  // In audio-only mode the video is thrown away, so starve it of bits.
  const trackSettings = displayStream.getVideoTracks()[0].getSettings();
  const pixels = (trackSettings.width || 1920) * (trackSettings.height || 1080);
  const videoBits = settings.audioOnly
    ? 150_000
    : Math.min(8_000_000, Math.max(1_500_000, Math.round(pixels * 1.4 * (captureFps / 15))));

  const recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: videoBits,
    audioBitsPerSecond: 128_000,
  });
  state.recorder = recorder;

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) enqueueChunk(ev.data);
  };
  recorder.onstop = finishRecording;

  // Stop when the user ends sharing from Chrome's own "Stop sharing" bar.
  displayStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (recorder.state === 'recording') recorder.stop();
  });

  recorder.start(2000); // flush a chunk every 2s

  // UI
  const preview = $('preview');
  preview.hidden = settings.audioOnly;
  if (!settings.audioOnly) {
    preview.srcObject = new MediaStream([displayStream.getVideoTracks()[0]]);
    preview.play().catch(() => {});
  }
  state.startedAt = Date.now();
  $('rec-timer').textContent = '00:00';
  state.timerInterval = setInterval(() => {
    $('rec-timer').textContent = fmtTime((Date.now() - state.startedAt) / 1000);
  }, 500);
  drawMeters();
  show('recording-card');
}

function stopAllTracks() {
  for (const s of [state.displayStream, state.micStream]) {
    if (s) for (const t of s.getTracks()) t.stop();
  }
  if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
  state.analysers = {};
  if (state.meterRaf) cancelAnimationFrame(state.meterRaf);
  if (state.timerInterval) clearInterval(state.timerInterval);
}

async function finishRecording() {
  stopAllTracks();
  show('processing-card');

  // Wait for all queued chunk uploads to land before finalizing.
  await state.uploadQueue;

  if (state.uploadFailed) {
    $('processing-msg').textContent =
      'Some chunks failed to upload. Attempting to finalize what was received…';
  }

  try {
    const s = state.settings || {};
    const params = new URLSearchParams({
      id: state.sessionId,
      fps: s.fps || 10,
      crf: s.crf || 23,
      audioOnly: s.audioOnly ? '1' : '0',
    });
    const res = await fetch(`/api/finish?${params}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'finalize failed');
    const dur = data.duration ? fmtTime(data.duration) : '?';
    $('done-msg').innerHTML =
      `✅ Saved <strong>${data.file}</strong> — ${fmtSize(data.size)}, ${dur}. ` +
      `<a href="/recordings/${encodeURIComponent(data.file)}" download>Download</a>`;
  } catch (e) {
    $('done-msg').textContent = '❌ ' + e.message;
  }
  show('done-card');
  loadRecordings();
}

function showSetupError(msg) {
  const el = $('setup-error');
  el.textContent = msg;
  el.hidden = false;
  show('setup-card');
}

async function loadRecordings() {
  try {
    const res = await fetch('/api/recordings');
    const { recordings } = await res.json();
    const list = $('recordings-list');
    list.innerHTML = '';
    if (!recordings.length) {
      list.innerHTML = '<li class="empty">No recordings yet.</li>';
      return;
    }
    for (const r of recordings) {
      const li = document.createElement('li');
      const url = '/recordings/' + encodeURIComponent(r.file);
      li.innerHTML =
        `<a class="name" href="${url}" target="_blank">${r.file}</a>` +
        `<span class="meta">${fmtSize(r.size)} · ${new Date(r.mtime).toLocaleString()}</span>` +
        `<a class="dl" href="${url}" download>⬇</a>`;
      list.appendChild(li);
    }
  } catch { /* server hiccup; list stays as-is */ }
}

$('start-btn').addEventListener('click', startRecording);
$('mode-group').addEventListener('change', () => { updateModeHint(); persistSettings(); });
$('output-group').addEventListener('change', () => { updateSettingsUI(); persistSettings(); });
for (const id of ['fps', 'quality', 'use-mic']) {
  $(id).addEventListener('change', persistSettings);
}
restoreSettings();
updateSettingsUI();
$('stop-btn').addEventListener('click', () => {
  if (state.recorder && state.recorder.state === 'recording') state.recorder.stop();
});
$('again-btn').addEventListener('click', () => show('setup-card'));

window.addEventListener('beforeunload', (e) => {
  if (state.recorder && state.recorder.state === 'recording') {
    e.preventDefault();
    e.returnValue = '';
  }
});

loadRecordings();
