#!/usr/bin/env node
// Local meeting recorder server — zero npm dependencies.
// Serves the frontend, receives recorded WebM chunks, and transcodes to MP4 with ffmpeg.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4470;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const TMP_DIR = path.join(RECORDINGS_DIR, '.tmp');

fs.mkdirSync(TMP_DIR, { recursive: true });

// id -> { writeStream, tmpPath, name }
const sessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120);
}

// Serve a file with Range support so recordings can be scrubbed in the browser.
function serveFile(res, filePath, headers) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || start >= stat.size) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 65536) stderr = stderr.slice(-32768); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-4000)}`));
    });
  });
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    proc.stdout.on('data', (d) => out += d);
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const v = parseFloat(out.trim());
      resolve(isFinite(v) ? v : null);
    });
  });
}

// Settings accepted from the client, whitelisted here.
const ALLOWED_FPS = [5, 10, 15, 24, 30];
const ALLOWED_CRF = [20, 23, 28];

async function transcode(tmpPath, outPath, { fps, crf, audioOnly }) {
  const args = ['-hide_banner', '-y', '-i', tmpPath];
  if (audioOnly) {
    // Drop the video stream entirely and encode the mixed audio as MP3.
    args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '160k', '-ac', '2');
  } else {
    // Screen-share-friendly encode: original resolution, chosen frame rate,
    // H.264 via libx264 (crisp text at low bitrate), AAC audio.
    // yuv420p + faststart for QuickTime/web compatibility. Dimensions are
    // rounded down to even numbers as yuv420p requires.
    args.push(
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
    );
  }
  args.push(outPath);
  await runFfmpeg(args);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- API ----
    if (req.method === 'POST' && p === '/api/start') {
      const id = crypto.randomBytes(8).toString('hex');
      const name = safeName(url.searchParams.get('name')) ||
        `meeting-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}`;
      const tmpPath = path.join(TMP_DIR, `${id}.webm`);
      const writeStream = fs.createWriteStream(tmpPath);
      sessions.set(id, { writeStream, tmpPath, name });
      return json(res, 200, { id, name });
    }

    if (req.method === 'POST' && p === '/api/chunk') {
      const id = url.searchParams.get('id');
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'unknown session' });
      const body = await readBody(req);
      await new Promise((resolve, reject) =>
        s.writeStream.write(body, (err) => err ? reject(err) : resolve()));
      return json(res, 200, { ok: true, bytes: body.length });
    }

    if (req.method === 'POST' && p === '/api/finish') {
      const id = url.searchParams.get('id');
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'unknown session' });
      sessions.delete(id);
      await new Promise((resolve) => s.writeStream.end(resolve));

      const stat = fs.statSync(s.tmpPath);
      if (stat.size === 0) {
        fs.unlinkSync(s.tmpPath);
        return json(res, 400, { error: 'no data was recorded' });
      }

      const audioOnly = url.searchParams.get('audioOnly') === '1';
      const fpsParam = parseInt(url.searchParams.get('fps'), 10);
      const crfParam = parseInt(url.searchParams.get('crf'), 10);
      const fps = ALLOWED_FPS.includes(fpsParam) ? fpsParam : 10;
      const crf = ALLOWED_CRF.includes(crfParam) ? crfParam : 23;

      const ext = audioOnly ? '.mp3' : '.mp4';
      let outName = `${s.name}${ext}`;
      let outPath = path.join(RECORDINGS_DIR, outName);
      let n = 2;
      while (fs.existsSync(outPath)) {
        outName = `${s.name} (${n})${ext}`;
        outPath = path.join(RECORDINGS_DIR, outName);
        n++;
      }

      try {
        await transcode(s.tmpPath, outPath, { fps, crf, audioOnly });
      } catch (e) {
        // Keep the raw webm so the recording is never lost.
        const keepPath = path.join(RECORDINGS_DIR, `${s.name}.webm`);
        fs.renameSync(s.tmpPath, keepPath);
        return json(res, 500, {
          error: 'transcode failed; raw recording saved as ' + path.basename(keepPath),
          detail: String(e.message).slice(0, 2000),
        });
      }
      fs.unlinkSync(s.tmpPath);

      const outStat = fs.statSync(outPath);
      const duration = await ffprobeDuration(outPath);
      return json(res, 200, { file: outName, size: outStat.size, duration });
    }

    if (req.method === 'POST' && p === '/api/cancel') {
      const id = url.searchParams.get('id');
      const s = sessions.get(id);
      if (s) {
        sessions.delete(id);
        s.writeStream.end(() => fs.unlink(s.tmpPath, () => {}));
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/recordings') {
      const files = fs.readdirSync(RECORDINGS_DIR)
        .filter((f) => /\.(mp4|mp3|webm)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(RECORDINGS_DIR, f));
          return { file: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { recordings: files });
    }

    // ---- Static / recordings ----
    if (req.method === 'GET' && p.startsWith('/recordings/')) {
      const file = path.normalize(decodeURIComponent(p.slice('/recordings/'.length)));
      if (file.includes('..') || file.includes('/')) { res.writeHead(400); return res.end(); }
      return serveFile(res, path.join(RECORDINGS_DIR, file), req.headers);
    }

    if (req.method === 'GET') {
      let file = p === '/' ? '/index.html' : p;
      file = path.normalize(decodeURIComponent(file));
      if (file.includes('..')) { res.writeHead(400); return res.end(); }
      return serveFile(res, path.join(PUBLIC_DIR, file), req.headers);
    }

    res.writeHead(405);
    res.end();
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Meeting recorder running at http://localhost:${PORT}`);
  console.log(`Recordings are saved to ${RECORDINGS_DIR}`);
});
