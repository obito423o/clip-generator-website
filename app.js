'use strict';
/* Podcast Clip Generator — browser-only, FFmpeg.wasm single-thread core (no SharedArrayBuffer needed). */
const CLIP_SEC = 60;
const V = { ffmpeg: '0.12.10', util: '0.12.1', core: '0.12.6' };
const CDN = 'https://cdn.jsdelivr.net/npm/';
// Sources tried in order: self-hosted ./vendor (recommended for WordPress), then CDN.
const SOURCES = [
  { ffmpeg: 'vendor/ffmpeg.js', util: 'vendor/util.js', worker: 'vendor/814.ffmpeg.js', core: 'vendor/ffmpeg-core.js', wasm: 'vendor/ffmpeg-core.wasm' },
  { ffmpeg: `${CDN}@ffmpeg/ffmpeg@${V.ffmpeg}/dist/umd/ffmpeg.js`, util: `${CDN}@ffmpeg/util@${V.util}/dist/umd/index.js`,
    worker: `${CDN}@ffmpeg/ffmpeg@${V.ffmpeg}/dist/umd/814.ffmpeg.js`,
    core: `${CDN}@ffmpeg/core@${V.core}/dist/umd/ffmpeg-core.js`, wasm: `${CDN}@ffmpeg/core@${V.core}/dist/umd/ffmpeg-core.wasm` }
];
const ZIP_MAX_BYTES = 3.5e9; // keep each ZIP below 4 GB so no ZIP64 is needed

const $ = id => document.getElementById(id);
let file = null, inputFile = null, duration = 0, total = 0, clips = [];
let running = false, cancelled = false, abortRun = null, ff = null, mounted = false, previewURL = null, logTail = [];

/* ---------- helpers ---------- */
const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
const fmtTime = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const pad = n => String(n).padStart(3, '0');
function status(msg, cls = '') { const el = $('status'); el.textContent = msg; el.className = cls; }
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src)); document.head.appendChild(s); }); }
const T = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function download(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }

/* ---------- FFmpeg ---------- */
async function initFFmpeg() {
  if (ff) return ff;
  let last;
  for (const s of SOURCES) {
    try {
      if (!window.FFmpegWASM) await loadScript(s.ffmpeg);
      if (!window.FFmpegUtil) await loadScript(s.util);
      const { toBlobURL } = FFmpegUtil, inst = new FFmpegWASM.FFmpeg();
      inst.on('log', ({ message }) => { logTail.push(message); if (logTail.length > 40) logTail.shift(); });
      inst.on('progress', ({ progress }) => { if (running) setProgress(clips.length + Math.min(Math.max(progress, 0), 1) * 0.98); });
      await inst.load({ // blob URLs avoid cross-origin Worker restrictions when using the CDN
        classWorkerURL: await toBlobURL(s.worker, 'text/javascript'),
        coreURL: await toBlobURL(s.core, 'text/javascript'),
        wasmURL: await toBlobURL(s.wasm, 'application/wasm')
      });
      ff = inst; return ff;
    } catch (e) { last = e; }
  }
  throw new Error('Could not load FFmpeg (' + (last && last.message) + '). Check your connection or self-host the files in ./vendor (see README).');
}
function killFFmpeg() { try { ff && ff.terminate(); } catch (e) {} ff = null; mounted = false; }

function buildArgs(i, o) {
  const last = i === total - 1, a = ['-ss', String(i * CLIP_SEC), '-i', '/in/' + inputFile.name];
  if (!last) a.push('-t', String(CLIP_SEC)); // last clip runs to end of file so no footage is dropped
  a.push('-map', '0:v:0', '-map', '0:a:0?');
  if (o.method === 'copy') a.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  else {
    if (o.format === 'vert') {
      const [w, h] = o.res.split('x');
      a.push('-vf', o.vmode === 'crop'
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`);
    }
    a.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k');
  }
  a.push('-movflags', '+faststart', '-y', 'out.mp4');
  return a;
}
const getOpts = () => ({ format: $('format').value, vmode: $('vmode').value, res: $('res').value, method: $('method').value });

/* ---------- processing ---------- */
async function run() {
  if (running || !file) return;
  running = true; cancelled = false; status(''); updateUI();
  const o = getOpts(), kill = new Promise((_, rej) => { abortRun = () => rej(new Error('cancelled')); });
  kill.catch(() => {});
  try {
    const f = await Promise.race([initFFmpeg(), kill]);
    if (!mounted) { // WORKERFS reads the File lazily: the whole video is NOT copied into WASM memory
      await f.createDir('/in'); await f.mount('WORKERFS', { files: [inputFile] }, '/in'); mounted = true;
    }
    const t0 = Date.now(), startN = clips.length;
    for (let i = clips.length; i < total; i++) {
      if (cancelled) break;
      logTail = [];
      const code = await Promise.race([f.exec(buildArgs(i, o)), kill]);
      if (code !== 0) throw new Error(`FFmpeg failed on clip ${i + 1} (exit code ${code}). ${o.method === 'copy' ? 'This codec/container may not support stream copy; try the re-encode method.' : ''}`);
      const data = await f.readFile('out.mp4'); await f.deleteFile('out.mp4');
      if (!data || !data.length) throw new Error(`Clip ${i + 1} came out empty.`);
      const c = { name: `clip_${pad(i + 1)}.mp4`, blob: new Blob([data], { type: 'video/mp4' }), crc: crc32(data), start: i * CLIP_SEC, end: Math.min((i + 1) * CLIP_SEC, duration) };
      clips.push(c); addCard(c); setProgress(clips.length);
      const done = clips.length - startN;
      $('eta').textContent = done >= 3 && clips.length < total ? 'About ' + fmtTime((Date.now() - t0) / done / 1000 * (total - clips.length)) + ' remaining (estimate)' : '';
    }
    if (!cancelled) {
      if (clips.length === total) status(`Done: ${clips.length} of ${total} clips created.`, 'ok');
      else throw new Error('Processing ended early; not all clips were created.');
    }
  } catch (e) {
    killFFmpeg();
    if (cancelled) status(`Cancelled after ${clips.length} of ${total} clips. Completed clips are still downloadable.`);
    else {
      const m = String(e.message), tail = logTail.slice(-3).join(' | ');
      status('Error: ' + (/memory|abort|out of bounds|OOM|unreachable/i.test(m + tail)
        ? 'FFmpeg ran out of memory or crashed. Close other tabs, use a Chromium browser, try the stream-copy method or a smaller file. ' : '') + m + (tail ? ' — ' + tail : ''), 'err');
    }
  } finally { running = false; abortRun = null; updateUI(); }
}

/* ---------- UI ---------- */
function setProgress(v) { const p = total ? Math.min(100, v / total * 100) : 0; $('barFill').style.width = p + '%'; $('pct').textContent = p.toFixed(1) + '%'; $('count').textContent = `${clips.length} / ${total} clips`; }
function addCard(c) {
  const li = document.createElement('li');
  li.innerHTML = `<strong>${c.name}</strong><small>${fmtTime(c.start)} – ${fmtTime(c.end)} · ${fmtSize(c.blob.size)}</small>`;
  const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Download'; b.onclick = () => download(c.blob, c.name);
  li.appendChild(b); $('clips').appendChild(li);
}
function updateUI() {
  const complete = clips.length === total && total > 0, partial = clips.length > 0 && !complete;
  $('start').disabled = running || complete; $('start').textContent = partial ? 'Resume Processing' : 'Start Processing';
  $('cancel').hidden = !running; $('retry').hidden = running || !partial;
  $('clear').disabled = false; $('zip').disabled = running || !clips.length;
  ['format', 'vmode', 'res', 'method'].forEach(id => $(id).disabled = running || clips.length > 0);
}
function syncOpts() {
  const vert = $('format').value === 'vert';
  $('vmodeL').hidden = $('resL').hidden = !vert;
  if (vert) $('method').value = 'encode';
  $('method').querySelector('[value=copy]').disabled = vert;
  $('hint').textContent = $('method').value === 'copy'
    ? 'Stream copy is fast and lossless, but cuts land on keyframes: clips may be a few seconds off 60 s and neighbouring clips may overlap slightly or start with a brief freeze.'
    : 'Re-encoding gives exact 60 s boundaries and is required for 9:16, but single-threaded WebAssembly is slow (often slower than real time at 1080p). A 2–3 h video can take many hours.';
}
function reset() {
  abortRun && abortRun(); cancelled = true; killFFmpeg();
  if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null;
  $('preview').removeAttribute('src'); $('preview').load();
  clips = []; $('clips').innerHTML = ''; file = inputFile = null; duration = total = 0;
  setProgress(0); $('eta').textContent = ''; status(''); $('panel').hidden = true; $('drop').hidden = false; $('file').value = '';
}
function unfinished() { return running || (clips.length > 0 && clips.length < total); }

function selectFile(f) {
  if (!f) return;
  if (running) return status('Cancel the current job before choosing another file.', 'err');
  if (!(f.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm)$/i.test(f.name))) return alert('That does not look like a video file.');
  if (!f.size) return alert('The file is empty.');
  reset();
  file = f; const ext = (f.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  inputFile = new File([f], 'input.' + ext, { type: f.type }); // no data copy; safe filename for FFmpeg
  $('drop').hidden = true; $('panel').hidden = false;
  $('fName').textContent = f.name; $('fSize').textContent = fmtSize(f.size); $('fDur').textContent = 'Reading…'; $('fTotal').textContent = '…';
  $('start').disabled = true; syncOpts();
  const v = $('preview'); previewURL = URL.createObjectURL(f); v.src = previewURL;
  v.onloadedmetadata = () => {
    duration = v.duration;
    if (!isFinite(duration) || duration <= 0) return v.onerror();
    total = Math.max(1, Math.ceil((duration - 0.05) / CLIP_SEC));
    $('fDur').textContent = fmtTime(duration) + ` (${duration.toFixed(1)} s)`; $('fTotal').textContent = total + ' clips';
    setProgress(0); updateUI();
  };
  v.onerror = () => { $('fDur').textContent = 'Unknown'; $('fTotal').textContent = '—'; status('Your browser cannot read this video (unsupported codec such as HEVC/H.265, or a corrupt file). Convert it to H.264 MP4 and try again.', 'err'); $('start').disabled = true; };
}

/* ---------- ZIP (store-only, built from Blobs without copying; split in parts < 4 GB) ---------- */
function buildZip(items) {
  const te = new TextEncoder(), parts = [], central = []; let off = 0, csize = 0;
  for (const c of items) {
    const n = te.encode(c.name), s = c.blob.size, h = new DataView(new ArrayBuffer(30)), d = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, c.crc, true); h.setUint32(18, s, true); h.setUint32(22, s, true); h.setUint16(26, n.length, true);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true); d.setUint16(14, 0x21, true);
    d.setUint32(16, c.crc, true); d.setUint32(20, s, true); d.setUint32(24, s, true); d.setUint16(28, n.length, true); d.setUint32(42, off, true);
    parts.push(h.buffer, n, c.blob); central.push(d.buffer, n); off += 30 + n.length + s; csize += 46 + n.length;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, items.length, true); e.setUint16(10, items.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
async function downloadZip() {
  const groups = []; let cur = [], size = 0;
  for (const c of clips) { if (cur.length && size + c.blob.size > ZIP_MAX_BYTES) { groups.push(cur); cur = []; size = 0; } cur.push(c); size += c.blob.size; }
  if (cur.length) groups.push(cur);
  for (let i = 0; i < groups.length; i++) {
    download(buildZip(groups[i]), groups.length > 1 ? `podcast_clips_part${i + 1}of${groups.length}.zip` : 'podcast_clips.zip');
    if (i < groups.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  if (groups.length > 1) status(`Clips are split into ${groups.length} ZIP files (browser limit ~4 GB each). Allow multiple downloads if prompted.`);
}

/* ---------- events ---------- */
$('browse').onclick = () => $('file').click();
$('file').onchange = e => selectFile(e.target.files[0]);
const dz = $('drop');
['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => selectFile(e.dataTransfer.files[0]));
dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); });
$('format').onchange = $('method').onchange = syncOpts;
$('start').onclick = $('retry').onclick = run;
$('cancel').onclick = () => { cancelled = true; abortRun && abortRun(); };
$('clear').onclick = () => { if (!unfinished() || confirm('Processing is unfinished. Clear the video and discard all generated clips?')) reset(); };
$('zip').onclick = downloadZip;
window.addEventListener('beforeunload', e => { if (unfinished()) { e.preventDefault(); e.returnValue = ''; } });
