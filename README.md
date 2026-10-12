# Podcast Clip Generator

Browser-only tool: splits one long video into consecutive 60-second MP4 clips using FFmpeg WebAssembly. No server, API key or upload.

## Architecture
- `@ffmpeg/ffmpeg` 0.12.10 + `@ffmpeg/core` 0.12.6 (**single-thread** core) running in a Web Worker. Single-thread means **no SharedArrayBuffer, no COOP/COEP headers** are needed, which is what makes WordPress hosting practical.
- The video is **not copied into WASM memory**. The `File` is attached with FFmpeg's `WORKERFS` mount and read lazily. Each clip is cut with `-ss <start> -i input -t 60`, read out, deleted from the virtual FS, and kept as a `Blob` (browsers can back large Blobs with disk).
- Clips are cut one at a time, in order. The last clip runs to the end of the file, so no footage is dropped and it is shorter than 60 s when needed. 3 h exactly → 180 clips.
- ZIP: a small built-in store-only ZIP writer (no compression; MP4 doesn't compress). Built from Blobs without copying. Split into parts under ~3.5 GB so ZIP64 isn't needed. JSZip is not used because it holds everything in memory.
- Dependencies: ffmpeg.wasm (LGPL/GPL build, contains x264), loaded from `./vendor/` first, then jsDelivr CDN.

## Methods and trade-offs
| Method | Speed | Quality | Cut accuracy |
|---|---|---|---|
| Stream copy (original ratio only) | Very fast (minutes for 3 h) | Lossless | Cuts snap to keyframes: clips can be a few seconds off 60 s, neighbours may overlap slightly, first frames may freeze |
| Re-encode H.264/AAC (CRF 23, ultrafast) | Slow; single-thread WASM is often slower than real time | Small loss, bigger files | Exact 60 s boundaries |
| Vertical 9:16 (crop or fit, 1080×1920 or 720×1280) | Re-encode only | As above | Exact |

For exact **and** fast processing of 2–3 h video you need native FFmpeg (a server, or a local desktop command such as `ffmpeg -i in.mp4 -f segment -segment_time 60 -reset_timestamps 1 -c copy out_%03d.mp4`). This project does not pretend the browser can match that.

## Limits (be realistic)
- Not every 2–3 h video works on every computer. 1080p podcasts are typically 2–8 GB. WORKERFS avoids loading it into RAM, but **inputs over 2 GB are not guaranteed** with this core (untested here; test with your own file). If it fails, remux/compress the source first or use native FFmpeg.
- Memory: peak use ≈ FFmpeg heap (a few hundred MB) + all finished clips (Blobs). 180 clips × ~30–60 MB can reach 5–10 GB total. On 8 GB RAM, **download clips/ZIP parts periodically** (or use stream copy) and close other tabs. A crash loses unsaved clips; use *Try Again/Resume* to continue from the last finished clip.
- Re-encoding 3 h at 1080×1920 on a laptop can take many hours; 720×1280 is faster. Keep the tab in the foreground and the computer awake.
- Inputs the browser cannot decode (HEVC/H.265 on some browsers) fail at duration detection; convert to H.264 first. Chrome/Edge desktop recommended.
- Vertical clips are re-encoded; very high bitrate sources may exceed Instagram's file-size limits.

## Run locally
1. `cd podcast-clip-generator` and serve with any static server, e.g. `python3 -m http.server 8080` (dev convenience only). Open `http://localhost:8080`. `file://` won't work.
2. Works with CDN loading as-is. For offline/self-hosted use, create `vendor/` and download:
```
mkdir vendor && cd vendor
curl -L -o ffmpeg.js          https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js
curl -L -o 814.ffmpeg.js      https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js
curl -L -o util.js            https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js
curl -L -o ffmpeg-core.js     https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
curl -L -o ffmpeg-core.wasm   https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
```
(If a version's worker chunk has a different filename, check `ffmpeg.js` for the `.ffmpeg.js` chunk name and update `SOURCES` in `app.js`.)

## Test plan
1. **Short MP4**: use a 3–5 min H.264 file. Expect `ceil(duration/60)` clips; the last is shorter.
2. **Boundaries**: re-encode method on a 3:30 file → clips 60, 60, 60, 30 s. Check with `ffprobe -v error -show_entries format=duration -of csv=p=0 clip_001.mp4`. In stream-copy mode expect small deviations.
3. **A/V sync and quality**: play a clip with speech, watch lips at the start, middle, end; compare to the source at the same timestamp. Check clip 2 starts where clip 1 ended.
4. **ZIP**: download all, extract with your OS tool (and `unzip -t`), confirm counts, names and that files play.
5. **Controls**: Cancel mid-run (finished clips stay downloadable), Clear Video (confirmation appears), Try Again/Resume, dropping a non-video file.
6. **Long video**: try a 30-minute file first, watch the browser's memory (Task Manager) and extrapolate. Only then try 2–3 h.

## WordPress
Requirements: self-hosted WordPress (or WordPress.com Business/Commerce plan) where you can upload files by FTP/SFTP/file manager. WordPress.com Free/Personal/Premium cannot host custom JS/WASM; use a separate static host (Netlify, GitHub Pages, Cloudflare Pages) and link or iframe to it.

**Recommended: upload as a folder and embed with an iframe** (the editor and many security plugins strip or break inline scripts, so don't paste into a Custom HTML block).
1. Upload the whole folder (including `vendor/`) to `public_html/podcast-clips/` so `https://yoursite.com/podcast-clips/index.html` loads.
2. Make sure `.wasm` is served as `application/wasm`. Apache `.htaccess`: `AddType application/wasm .wasm` (Nginx: add `application/wasm wasm;` in `mime.types`). Also enable gzip/brotli for `.wasm` and `.js`.
3. Don't send `X-Frame-Options: DENY`; same-origin framing must be allowed. No COOP/COEP headers are required.
4. In a page, add a Custom HTML block: `<iframe src="/podcast-clips/index.html" style="width:100%;height:1400px;border:0" title="Podcast Clip Generator"></iframe>`. (Or just link to the URL.) If your theme forbids iframes, use a plugin such as WPCode to include the files.
5. If a caching/security plugin or CDN minifies JS, exclude `/podcast-clips/`. Test with a short MP4 first.

## Security & privacy
Files stay in your browser; the only network requests are for the FFmpeg files (none if self-hosted). Pin versions as shown; if using the CDN, consider SRI hashes. Self-hosting is safer for production.

## Troubleshooting
- "Could not load FFmpeg": check `vendor/` file names, MIME type for `.wasm`, ad-blockers, or CDN access.
- Worker/CORS error: serve over http(s), not `file://`.
- "Out of memory"/abort: close tabs, download finished clips, use stream copy, lower resolution, or split the source first.
- Clips overlap or start frozen: that's stream-copy keyframe snapping; use re-encode.
- Browser blocks multiple downloads: allow them for the site (ZIP parts download sequentially).
