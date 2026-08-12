const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync, execSync } = require('child_process')

// safer than execSync with template strings — passes args as array so paths with quotes/spaces are safe
function runSync(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${path.basename(exe)} exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`)
  return (r.stdout || '').toString()
}
const https = require('https')

const HOME = os.homedir()
const VIRGIL_DIR = path.join(HOME, 'Virgil')
const TOOLS_DIR = path.join(VIRGIL_DIR, 'tools')
const FFMPEG_DIR = path.join(TOOLS_DIR, 'ffmpeg')
const VIDEO2X_DIR = path.join(TOOLS_DIR, 'video2x')
const OUTPUT_DIR = path.join(HOME, 'Downloads')

const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
const VIDEO2X_URL = 'https://github.com/k4yt3x/video2x/releases/download/6.3.0/video2x-windows-amd64.zip'

let mainWindow
let currentProc = null
let cancelRequested = false

// Jobs run anywhere from ~1 minute to many hours — the whole point is
// starting one and walking away, so a silent finish (success OR failure)
// defeats that. Clicking the notification brings Virgil back to front.
function notifyJobDone(title, body) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: path.join(__dirname, 'icon.ico') })
  n.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  n.show()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 720,
    minHeight: 580,
    frame: false,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.ico'),
    titleBarStyle: 'hidden'
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // External links (the About-panel credit links) must open in the user's real
  // browser. Without this, clicking one navigates the whole app window to the
  // URL — there's no back button on a frameless window, so the app appears
  // bricked until restart. Route every off-app navigation to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })
}

app.whenReady().then(() => {
  [VIRGIL_DIR, TOOLS_DIR, FFMPEG_DIR, VIDEO2X_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  })
  sweepOrphanedTempFiles()
  createWindow()
})

// Each run's stripped/pre-converted intermediate is meant to be deleted by
// cleanupTemp() when that run finishes — but a crash or force-quit mid-run
// skips that, and cleanupTemp's own unlinkSync is wrapped in a silent
// catch(e){}, so a failure there wouldn't show up anywhere either. No run
// spans an app restart, so anything matching this pattern still here at
// startup is orphaned by definition — safe to clear unconditionally.
function sweepOrphanedTempFiles() {
  try {
    const orphans = fs.readdirSync(TOOLS_DIR).filter(f => /^_virgil_stripped_\d+\.mkv$/.test(f))
    let freedBytes = 0
    for (const f of orphans) {
      const p = path.join(TOOLS_DIR, f)
      try {
        freedBytes += fs.statSync(p).size
        fs.unlinkSync(p)
      } catch(e) {}
    }
    if (orphans.length) {
      console.log(`Swept ${orphans.length} orphaned temp file(s), freed ${(freedBytes / 1e9).toFixed(2)}GB`)
    }
  } catch(e) {}
}

app.on('window-all-closed', () => app.quit())

// Single source of truth for the version shown in the UI — reads package.json
// via Electron's own app.getVersion() instead of a hand-typed string, so it
// can't drift out of sync with a real release again (found stale twice now).
ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('window-minimize', () => mainWindow.minimize())
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window-close', () => mainWindow.close())

ipcMain.handle('pick-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video Files', extensions: ['mp4','mkv','avi','mov','wmv','m4v','flv','webm','ts','mts','m2ts','mpg','mpeg','ogv','ogm','vob','3gp','rmvb','rm','divx','xvid'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('pick-output', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('open-folder', (_, folderPath) => {
  shell.openPath(folderPath)
})

ipcMain.handle('cancel-process', () => {
  cancelRequested = true
  if (currentProc) {
    try { currentProc.kill('SIGTERM') } catch(e) {}
    setTimeout(() => { try { currentProc && currentProc.kill('SIGKILL') } catch(e) {} }, 2000)
  }
  return { cancelled: true }
})

ipcMain.handle('get-default-output', () => OUTPUT_DIR)

ipcMain.handle('check-tools', async () => {
  const ffmpeg = fs.existsSync(path.join(FFMPEG_DIR, 'ffmpeg.exe'))
  const video2x = fs.existsSync(path.join(VIDEO2X_DIR, 'video2x.exe'))
  return { ffmpeg, video2x }
})

// Classify a GPU by its name. Pattern-matches the common families and gives
// a rough tier + expected processing time multiplier vs beastie-tier hardware.
// Better than reading AdapterRAM (which caps at ~4GB on 32-bit WMI fields and
// reports wrong values for modern cards).
function classifyGPU(rawName) {
  const n = (rawName || '').toLowerCase()
  // Integrated graphics — slowest, AI upscale will be painful
  if (/intel\s*(hd|uhd|iris|xe)/.test(n))                    return { tier: 'integrated', multiplier: 8, label: 'Integrated Intel — VERY SLOW' }
  if (/(radeon\s*graphics|amd\s*vega|amd\s*radeon\s*vega)/.test(n) && !/rx/.test(n))
                                                              return { tier: 'integrated', multiplier: 8, label: 'Integrated AMD — VERY SLOW' }
  // NVIDIA modern (RTX 30/40/50)
  if (/rtx\s*50\d{2}/.test(n))                                return { tier: 'strong', multiplier: 1.0, label: 'NVIDIA RTX 50 — top tier' }
  if (/rtx\s*40\d{2}/.test(n))                                return { tier: 'strong', multiplier: 1.1, label: 'NVIDIA RTX 40 — fast' }
  if (/rtx\s*30\d{2}/.test(n))                                return { tier: 'strong', multiplier: 1.5, label: 'NVIDIA RTX 30 — solid' }
  if (/rtx\s*20\d{2}/.test(n))                                return { tier: 'mid', multiplier: 2.5, label: 'NVIDIA RTX 20 — ok' }
  // NVIDIA GTX
  if (/gtx\s*16\d{2}/.test(n))                                return { tier: 'mid', multiplier: 3.5, label: 'NVIDIA GTX 16xx — slow' }
  if (/gtx\s*10\d{2}/.test(n))                                return { tier: 'weak', multiplier: 5,   label: 'NVIDIA GTX 10xx — aging' }
  if (/gtx\s*9\d{2}|gtx\s*7\d{2}|gtx\s*titan/.test(n))        return { tier: 'weak', multiplier: 8,   label: 'NVIDIA GTX legacy — very slow' }
  // AMD discrete
  if (/rx\s*[78]\d{3}/.test(n))                               return { tier: 'strong', multiplier: 1.3, label: 'AMD RX 7000/8000 — fast' }
  if (/rx\s*[56]\d{3}/.test(n))                               return { tier: 'mid', multiplier: 2.2, label: 'AMD RX 5000/6000 — ok' }
  if (/rx\s*[45]\d{2}/.test(n))                               return { tier: 'weak', multiplier: 5, label: 'AMD RX legacy — slow' }
  return { tier: 'unknown', multiplier: 4, label: 'Unknown GPU — assuming mid-low tier' }
}

// Detect the most powerful GPU on the system. We pick the one with the highest
// tier rating since many laptops have both integrated + dedicated.
ipcMain.handle('detect-system', async () => {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance -ClassName Win32_VideoController | Where-Object {$_.Name -notmatch "Basic|Mirror|Remote"} | Select-Object Name | ConvertTo-Json -Compress'
    ], { windowsHide: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { ps.kill() } catch(e) {}
    }, 4000)

    ps.stdout.on('data', d => out += d.toString())
    ps.on('close', () => {
      clearTimeout(timer)
      if (timedOut) return resolve({ ok: false, error: 'timeout', tier: 'unknown', multiplier: 4 })
      try {
        let raw = JSON.parse(out)
        if (!Array.isArray(raw)) raw = raw ? [raw] : []
        const gpus = raw.map(g => ({ name: g.Name || 'unknown', ...classifyGPU(g.Name) }))
        // Prefer the strongest GPU (lowest multiplier wins)
        const best = gpus.reduce((a, b) => (a && a.multiplier < b.multiplier) ? a : b, gpus[0]) || { name: 'unknown', tier: 'unknown', multiplier: 4 }
        // Estimate processing time per 20-min episode (rough baseline: 25 min on RTX 50)
        const baselineMinutes = 25
        const estimatedMinutes = Math.round(baselineMinutes * best.multiplier)
        resolve({
          ok: true,
          gpus: gpus.map(g => g.name),
          primary: best,
          estimatedMinutesPerEpisode: estimatedMinutes,
          warning: best.tier === 'integrated' || best.tier === 'weak'
            ? `Your GPU "${best.name}" is below recommended specs. Expect ~${estimatedMinutes} min per 20-min episode at 1080p (vs ~25 min on a modern dedicated GPU). Test on a short clip first.`
            : null
        })
      } catch(e) {
        resolve({ ok: false, error: e.message, tier: 'unknown', multiplier: 4 })
      }
    })
    ps.on('error', e => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message, tier: 'unknown', multiplier: 4 })
    })
  })
})

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const request = (u) => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location)
        }
        const total = parseInt(res.headers['content-length'] || '0')
        let downloaded = 0
        res.on('data', chunk => {
          downloaded += chunk.length
          if (total && onProgress) onProgress(Math.round(downloaded / total * 100))
        })
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        res.on('error', reject)
      }).on('error', reject)
    }
    request(url)
  })
}

ipcMain.handle('install-tools', async (event) => {
  const send = (msg, pct, type) => {
    mainWindow.webContents.send('install-progress', { msg, pct, type })
  }

  try {
    send('Downloading FFmpeg...', 5, 'info')
    const ffmpegZip = path.join(TOOLS_DIR, 'ffmpeg.zip')
    await downloadFile(FFMPEG_URL, ffmpegZip, pct => send(`Downloading FFmpeg... ${pct}%`, Math.round(pct * 0.4), 'info'))

    send('Extracting FFmpeg...', 42, 'info')
    try {
      execSync(`powershell -Command "Expand-Archive -Path '${ffmpegZip}' -DestinationPath '${TOOLS_DIR}\\ffmpeg_tmp' -Force"`)
      const extracted = fs.readdirSync(path.join(TOOLS_DIR, 'ffmpeg_tmp'))
      const ffmpegFolder = extracted.find(f => f.startsWith('ffmpeg'))
      if (ffmpegFolder) {
        const binSrc = path.join(TOOLS_DIR, 'ffmpeg_tmp', ffmpegFolder, 'bin')
        const binFiles = fs.readdirSync(binSrc)
        binFiles.forEach(f => {
          fs.copyFileSync(path.join(binSrc, f), path.join(FFMPEG_DIR, f))
        })
        fs.rmSync(path.join(TOOLS_DIR, 'ffmpeg_tmp'), { recursive: true })
      }
      fs.unlinkSync(ffmpegZip)
    } catch (e) {
      send('FFmpeg extract issue: ' + e.message, 42, 'warn')
    }
    send('FFmpeg ready', 45, 'ok')

    send('Downloading Video2X AI engine...', 48, 'info')
    const v2xZip = path.join(TOOLS_DIR, 'video2x.zip')
    await downloadFile(VIDEO2X_URL, v2xZip, pct => send(`Downloading Video2X... ${pct}%`, Math.round(48 + pct * 0.45), 'info'))

    send('Extracting Video2X...', 95, 'info')
    try {
      execSync(`powershell -Command "Expand-Archive -Path '${v2xZip}' -DestinationPath '${VIDEO2X_DIR}' -Force"`)
      fs.unlinkSync(v2xZip)
    } catch (e) {
      send('Video2X extract issue: ' + e.message, 95, 'warn')
    }
    send('Virgil is armed and ready', 100, 'ok')
    return { success: true }
  } catch (err) {
    send('Setup failed: ' + err.message, 0, 'error')
    return { success: false, error: err.message }
  }
})

function probeFrameRate(filePath, ffprobeExe) {
  try {
    const out = runSync(ffprobeExe, ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).trim()
    const m = out.match(/^(\d+)\/(\d+)$/)
    if (m) return parseInt(m[1]) / parseInt(m[2])
    const f = parseFloat(out)
    return Number.isFinite(f) ? f : null
  } catch(e) { return null }
}

function probeVideoDuration(filePath, ffprobeExe) {
  try {
    const out = runSync(ffprobeExe, ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).trim()
    const f = parseFloat(out)
    return Number.isFinite(f) && f > 0 ? f : null
  } catch(e) { return null }
}

// ───────────── content-type auto detection ─────────────
// Sample saturation across the video to guess anime/cartoon vs live action.
// Cel/cartoon content runs more saturated and flatter than live-action footage,
// so average saturation is a cheap, real signal. Returns median SATAVG
// (0..~180 on the YUV chroma magnitude scale) or null if it can't sample.
function probeMedianSaturation(filePath, ffmpegExe, ffprobeExe) {
  if (!fs.existsSync(ffmpegExe)) return null
  const duration = fs.existsSync(ffprobeExe) ? probeVideoDuration(filePath, ffprobeExe) : null
  // Sample several points across the middle of the video (skip intros/credits).
  const points = (duration && duration > 12)
    ? [0.2, 0.4, 0.6, 0.8].map(p => Math.round(duration * p))
    : [1]
  const sats = []
  for (const t of points) {
    try {
      const r = spawnSync(ffmpegExe, [
        '-ss', String(t), '-i', filePath,
        '-frames:v', '1',
        '-vf', 'signalstats,metadata=print',
        '-an', '-f', 'null', '-'
      ], { encoding: 'utf8' })
      const out = (r.stderr || '') + (r.stdout || '')
      const m = out.match(/SATAVG=\s*([\d.]+)/)
      if (m) sats.push(parseFloat(m[1]))
    } catch(e) {}
  }
  if (!sats.length) return null
  sats.sort((a, b) => a - b)
  return sats[Math.floor(sats.length / 2)]  // median resists one weird frame
}

// SAFE-BIASED toward anime (which is a non-destructive stream copy): we only
// switch to the live-action color/contrast pass when footage is clearly
// desaturated — exactly the washed-out old live content that benefits from it.
const AUTO_LIVE_SAT_THRESHOLD = 45

function autoDetectContentType(filePath, ffmpegExe, ffprobeExe, send) {
  const sat = probeMedianSaturation(filePath, ffmpegExe, ffprobeExe)
  if (sat == null) {
    send('Auto-detect: could not sample frames — defaulting to Anime/Cartoon treatment', 7, 'warn')
    return 'anime'
  }
  const decided = sat < AUTO_LIVE_SAT_THRESHOLD ? 'live' : 'anime'
  send(`Auto-detect: median saturation ${sat.toFixed(1)} → ${decided === 'live' ? 'Live Action' : 'Anime/Cartoon'}`, 7, 'info')
  return decided
}

// ───────────── process-video helpers ─────────────
// Extracted from the giant process-video handler so each phase is testable
// and the handler reads as a clear pipeline instead of 230 lines of god-mode.

function probeSourceResolution(filePath, ffprobeExe, logPath) {
  if (!fs.existsSync(ffprobeExe)) return { sourceWidth: 0, sourceHeight: 0 }
  try {
    const dims = runSync(ffprobeExe, [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=,:p=0',
      filePath
    ]).trim()
    const parts = dims.split(',').map(n => parseInt(n))
    if (parts[0] && parts[1]) return { sourceWidth: parts[0], sourceHeight: parts[1] }
  } catch(e) {
    if (logPath) {
      try { fs.appendFileSync(logPath, `[probe error: resolution] ${e.message}\n`) } catch(_) {}
    }
  }
  return { sourceWidth: 0, sourceHeight: 0 }
}

function calculateSmartScale(sourceHeight, scale) {
  // Target heights per preset. 4K removed in v1.5.5 — too slow for marginal benefit.
  const targetMap = { '720p': 720, '1080p': 1080, '1440p': 1440 }
  const targetHeight = targetMap[scale] || 1080

  if (sourceHeight > 0) {
    const ratio = targetHeight / sourceHeight
    // Real-ESRGAN supports 2x/3x/4x only
    let smartScale = 2
    if (ratio <= 2.1)      smartScale = 2
    else if (ratio <= 3.1) smartScale = 3
    else                   smartScale = 4
    return { smartScale, targetHeight, knownSource: true }
  }
  // Probe failed — fall back to a sensible default per preset
  const fallbackMap = { '720p': 2, '1080p': 2, '1440p': 3 }
  return { smartScale: fallbackMap[scale] || 2, targetHeight, knownSource: false }
}

// Legacy codecs that crash Video2X during output finalization (AVI container
// quirks, non-standard timestamps, DivX/XviD metadata). Re-encode to H264
// MKV before upscaling so Video2X gets a clean modern input.
const LEGACY_CODECS = new Set(['mpeg4', 'msmpeg4v2', 'msmpeg4v3', 'divx', 'xvid', 'h263', 'wmv1', 'wmv2', 'flv1', 'rv10', 'rv20', 'theora'])

function probeVideoCodec(filePath, ffprobeExe) {
  try {
    const out = runSync(ffprobeExe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', filePath])
    const data = JSON.parse(out)
    return (data.streams && data.streams[0] && data.streams[0].codec_name) || null
  } catch(e) { return null }
}

function stripNonVideoTracks(filePath, ffmpegExe, video2xExe, send, ffprobeExe) {
  // Video2X chokes on subtitle/data/extra audio tracks. Strip down to clean
  // video first; the original file is still used as the source of audio
  // during the final merge step.
  if (!fs.existsSync(ffmpegExe) || !fs.existsSync(video2xExe)) {
    return { input: filePath, tempStripped: null }
  }
  try {
    const codec = ffprobeExe ? probeVideoCodec(filePath, ffprobeExe) : null
    const isLegacy = codec && LEGACY_CODECS.has(codec.toLowerCase())
    const ext = path.extname(filePath).toLowerCase()
    const isAvi = ext === '.avi'

    if (isLegacy || isAvi) {
      send(`Legacy codec detected (${codec || 'AVI'}) — pre-converting to H264 for Video2X compatibility...`, 7, 'warn')
      const tempStripped = path.join(TOOLS_DIR, `_virgil_stripped_${Date.now()}.mkv`)
      runSync(ffmpegExe, [
        '-i', filePath,
        '-map', '0:v:0',
        '-c:v', 'libx264', '-crf', '16', '-preset', 'fast',
        '-an', '-sn', '-dn',
        '-y', tempStripped,
        '-loglevel', 'error'
      ])
      if (fs.existsSync(tempStripped) && fs.statSync(tempStripped).size > 1024) {
        send('Pre-conversion done — clean H264 ready for upscale', 8, 'ok')
        return { input: tempStripped, tempStripped }
      }
    }

    send('Stripping non-video tracks for Video2X compatibility...', 7, 'info')
    const tempStripped = path.join(TOOLS_DIR, `_virgil_stripped_${Date.now()}.mkv`)
    runSync(ffmpegExe, [
      '-i', filePath,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an', '-sn', '-dn',
      '-copyts',
      '-y', tempStripped,
      '-loglevel', 'error'
    ])
    if (fs.existsSync(tempStripped) && fs.statSync(tempStripped).size > 0) {
      send('Clean video extracted for upscale', 8, 'ok')
      return { input: tempStripped, tempStripped }
    }
    return { input: filePath, tempStripped: null }
  } catch (e) {
    send('Strip failed, using original: ' + e.message.substring(0, 120), 7, 'warn')
    return { input: filePath, tempStripped: null }
  }
}

function detectEnglishAudioTrack(filePath, ffprobeExe, requestedTrack, logPath) {
  // User-specified track wins unconditionally
  if (typeof requestedTrack === 'number') return requestedTrack
  if (!fs.existsSync(ffprobeExe)) return 0
  try {
    const probeOut = runSync(ffprobeExe, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      filePath
    ])
    const probeData = JSON.parse(probeOut)
    const tracks = probeData.streams || []
    const eng = tracks.findIndex(s => {
      const lang = (s.tags && (s.tags.language || s.tags.LANGUAGE) || '').toLowerCase()
      return lang === 'eng' || lang === 'en' || lang === 'english'
    })
    return eng >= 0 ? eng : 0
  } catch (e) {
    if (logPath) {
      try { fs.appendFileSync(logPath, `[probe error: audio tracks] ${e.message}\n`) } catch(_) {}
    }
    return 0
  }
}

function buildUpscalerCommand({ video2xExe, ffmpegExe, video2xInput, originalFile, outFile, smartScale, scale, enhance, contentType }) {
  const maxQuality = enhance === 'max'
  if (fs.existsSync(video2xExe)) {
    // Balanced: realesr-animevideov3 ships x2/x3/x4 params, so it honors the
    //   smart scale and stays fast — good default for any content.
    // Max Quality: the realesrgan-plus models are sharper but the installed
    //   build ONLY ships their x4 param (verified), so they MUST run at -s 4.
    //   plus-anime for cartoon/anime, plus for live-action photographic detail.
    let model, useScale
    if (maxQuality) {
      model = (contentType === 'live') ? 'realesrgan-plus' : 'realesrgan-plus-anime'
      useScale = 4
    } else {
      model = 'realesr-animevideov3'
      useScale = smartScale
    }
    return {
      mode: 'video2x',
      exe: video2xExe,
      model,
      scaleUsed: useScale,
      maxQuality,
      args: [
        '-i', video2xInput,
        '-o', outFile,
        '-s', String(useScale),
        '--processor', 'realesrgan',
        '--realesrgan-model', model,
        // 0 = auto (video2x's own default) — was hardcoded to 2, artificially
        // capping the final x264 re-encode step regardless of actual CPU core
        // count. This only affects the CPU-bound encode stage, not the
        // GPU-bound upscaling itself. Tried adding --hwaccel cuda for the
        // decode side too (idle GPU during decode otherwise) but video2x's
        // realesrgan/ncnn-vulkan path can't consume CUDA-resident frames —
        // confirmed via a real test run, it hard-fails with "cuda is not
        // supported as input pixel format" — so decode stays software-only.
        '--thread-count', '0'
      ]
    }
  }
  if (fs.existsSync(ffmpegExe)) {
    const scaleMap = { '720p': '1280:720', '1080p': '1920:1080', '1440p': '2560:1440' }
    const resolution = scaleMap[scale] || '1920:1080'
    // No AI engine — plain lanczos resize. Max Quality nudges the encode sharper.
    return {
      mode: 'ffmpeg',
      exe: ffmpegExe,
      model: 'lanczos',
      scaleUsed: null,
      maxQuality,
      args: [
        '-i', originalFile,
        '-vf', `scale=${resolution}:flags=lanczos`,
        '-c:v', 'libx264',
        '-crf', maxQuality ? '16' : '18',
        '-preset', maxQuality ? 'slow' : 'fast',
        '-c:a', 'copy',
        '-y', outFile
      ]
    }
  }
  return null
}

function runMerge({ upscaledFile, originalFile, audioOffset, audioTrack, outFile, contentType, sendProgress, logPath, keepAllAudio }) {
  return new Promise((resolve) => {
    const ffmpegExe = path.join(FFMPEG_DIR, 'ffmpeg.exe')
    const ffprobeExe = path.join(FFMPEG_DIR, 'ffprobe.exe')
    if (!fs.existsSync(ffmpegExe)) {
      sendProgress('FFmpeg not found — cannot merge', 0, 'error')
      return resolve({ success: false })
    }

    // compute itsscale using DURATIONS (most reliable — works even with corrupt fps metadata)
    let itsScale = null
    if (fs.existsSync(ffprobeExe)) {
      const srcDur = probeVideoDuration(originalFile, ffprobeExe)
      const upDur = probeVideoDuration(upscaledFile, ffprobeExe)
      if (srcDur && upDur && Math.abs(srcDur - upDur) / srcDur > 0.001) {
        itsScale = srcDur / upDur
        sendProgress(`Duration mismatch: upscaled ${upDur.toFixed(2)}s → source ${srcDur.toFixed(2)}s (scale ${itsScale.toFixed(5)})`, 40, 'info')
      } else {
        const srcFps = probeFrameRate(originalFile, ffprobeExe)
        const upFps = probeFrameRate(upscaledFile, ffprobeExe)
        if (srcFps && upFps && Math.abs(srcFps - upFps) > 0.01 && upFps < 200) {
          itsScale = upFps / srcFps
          sendProgress(`FPS drift detected: ${upFps.toFixed(3)} → ${srcFps.toFixed(3)} (scale ${itsScale.toFixed(5)})`, 40, 'info')
        }
      }
    }
    // -fflags +genpts: regenerate timestamps on input read, fixes the "non strictly monotonic PTS"
    // warnings caused by source videos with wonky/duplicate/backwards timestamps.
    // Applied globally before any -i so it covers both inputs.
    const ptsFix = ['-fflags', '+genpts']
    const inputUpscaled = itsScale
      ? [...ptsFix, '-itsscale', String(itsScale), '-i', upscaledFile]
      : [...ptsFix, '-i', upscaledFile]

    // pick English track if not specified; always verify track count and clamp
    let trackIdx = (typeof audioTrack === 'number') ? audioTrack : 0
    let totalAudioTracks = 0
    if (fs.existsSync(ffprobeExe)) {
      try {
        const probeOut = runSync(ffprobeExe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'a', originalFile])
        const data = JSON.parse(probeOut)
        const tracks = data.streams || []
        totalAudioTracks = tracks.length
        // auto-detect English only if caller didn't pass an explicit track
        if (typeof audioTrack !== 'number') {
          const eng = tracks.findIndex(s => {
            const lang = (s.tags && (s.tags.language || s.tags.LANGUAGE) || '').toLowerCase()
            return lang === 'eng' || lang === 'en' || lang === 'english'
          })
          if (eng >= 0) trackIdx = eng
        }
        // clamp to valid range
        if (totalAudioTracks > 0 && trackIdx >= totalAudioTracks) {
          sendProgress(`Track ${trackIdx} out of range (file has ${totalAudioTracks}) — using track 0`, 41, 'warn')
          trackIdx = 0
        }
      } catch(e) {}
    }

    const offset = (typeof audioOffset === 'number') ? audioOffset : 0
    const needsReencode = contentType === 'live'
    // unified live-action color treatment (was inconsistent between audio modes before)
    const liveVideoArgs = ['-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-vf', 'eq=saturation=1.15:contrast=1.05:gamma=0.95',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
    const videoArgs = needsReencode ? liveVideoArgs : ['-c:v', 'copy']
    const audioFilter = offset < 0
      ? `atrim=start=${Math.abs(offset)},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0`
      : `adelay=${offset * 1000}|${offset * 1000},aresample=async=1:first_pts=0`

    const tmpOut = outFile + '.tmp.mp4'

    let mergeArgs
    if (keepAllAudio) {
      const liveColorArgs = (contentType === 'live') ? liveVideoArgs : ['-c:v', 'copy']
      sendProgress(`Keep-all-audio mode · ${contentType === 'live' ? 'color-corrected' : 'stream copy'} · audio→AAC`, 50, 'info')
      mergeArgs = [
        ...inputUpscaled,
        '-fflags', '+genpts',
        '-i', originalFile,
        '-map', '0:v:0',
        '-map', '1:a',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        ...liveColorArgs,
        '-c:a', 'aac', '-b:a', '192k',
        '-disposition:a', '0',
        `-disposition:a:${trackIdx}`, 'default',
        '-movflags', '+faststart',
        '-sn', '-dn', '-y', tmpOut, '-loglevel', 'error'
      ]
    } else {
      // detect source audio codec to decide whether we can stream-copy
      let srcAudioCodec = null
      if (fs.existsSync(ffprobeExe)) {
        try {
          const acOut = runSync(ffprobeExe, ['-v', 'quiet', '-select_streams', `a:${trackIdx}`, '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', originalFile]).trim()
          srcAudioCodec = acOut.toLowerCase()
        } catch(e) {}
      }
      const mp4FriendlyCodecs = ['aac', 'mp3', 'ac3', 'eac3', 'alac']
      const canCopyAudio = offset === 0 && srcAudioCodec && mp4FriendlyCodecs.includes(srcAudioCodec)
      const audioCodecArgs = canCopyAudio
        ? ['-c:a', 'copy']
        : ['-af', audioFilter, '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
      sendProgress(`Audio: ${canCopyAudio ? `stream copy (${srcAudioCodec})` : `re-encode AAC, offset ${offset}s`} · track ${trackIdx}`, 50, 'info')
      mergeArgs = [
        ...inputUpscaled,
        '-fflags', '+genpts',
        '-i', originalFile,
        '-map', '0:v:0', '-map', `1:a:${trackIdx}`,
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        ...videoArgs,
        ...audioCodecArgs,
        '-metadata:s:a:0', 'language=eng',
        '-metadata:s:a:0', 'title=English',
        '-movflags', '+faststart',
        '-sn', '-dn', '-y', tmpOut, '-loglevel', 'error'
      ]
    }
    const merge = spawn(ffmpegExe, mergeArgs)
    let mergeStderr = ''
    const STDERR_CAP = 32 * 1024  // 32KB max — enough for diagnostics, won't balloon memory
    merge.stderr.on('data', d => {
      mergeStderr += d.toString()
      if (mergeStderr.length > STDERR_CAP) {
        mergeStderr = '...[truncated]...\n' + mergeStderr.slice(-STDERR_CAP)
      }
    })
    merge.on('close', code => {
      if (logPath) {
        try { fs.appendFileSync(logPath, `[merge stderr]\n${mergeStderr}\n`) } catch(e) {}
      }
      if (code === 0 && fs.existsSync(tmpOut)) {
        // Sanity-check: confirm the merged output actually has a video stream.
        // ffmpeg can exit 0 with audio-only output if the upscaled input was
        // corrupt (e.g. after a Video2X crash) — catch it before overwriting.
        let hasVideo = true
        if (fs.existsSync(ffprobeExe)) {
          try {
            const probeOut = runSync(ffprobeExe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v', tmpOut])
            const probeData = JSON.parse(probeOut)
            const vStream = probeData.streams && probeData.streams[0]
            // Must have a video stream with more than a handful of frames
            // (Video2X crash writes 1-frame MP4 that passes a naive stream check)
            const frameCount = vStream ? parseInt(vStream.nb_frames || '0') : 0
            hasVideo = vStream && (frameCount > 10 || frameCount === 0) // nb_frames=0 means container didn't store count (MKV) — trust it
          } catch(e) { /* probe failed — assume ok and let user see the file */ }
        }
        if (!hasVideo) {
          sendProgress('Merge produced a broken video (only 1 frame) — Video2X crashed before finishing. Re-run the job.', 0, 'error')
          try { fs.unlinkSync(tmpOut) } catch(_) {}
          if (logPath) {
            try { fs.appendFileSync(logPath, '[merge error] output has no video stream — upscaled file was corrupt\n') } catch(_) {}
          }
          return resolve({ success: false, error: 'audio-only output — upscaled video corrupt' })
        }
        // Atomic-ish swap of tmpOut → outFile. Real bug if this fails: the
        // user gets a "Merge done" message but the final file doesn't exist.
        try {
          if (fs.existsSync(outFile)) fs.unlinkSync(outFile)
          fs.renameSync(tmpOut, outFile)
        } catch(e) {
          sendProgress(`Merge succeeded but final rename failed: ${e.message}`, 0, 'error')
          sendProgress(`Intermediate file kept at: ${tmpOut}`, 0, 'warn')
          if (logPath) {
            try { fs.appendFileSync(logPath, `[rename error] ${e.stack || e.message}\n`) } catch(_) {}
          }
          return resolve({ success: false, error: 'rename failed: ' + e.message, intermediatePath: tmpOut })
        }
        sendProgress(`Merge done — saved to ${outFile}`, 100, 'ok')
        resolve({ success: true, outFile })
      } else {
        sendProgress(`Merge failed (code ${code})`, 0, 'error')
        // Surface a snippet of the actual ffmpeg stderr so the user sees what went wrong
        // instead of just "code 1". Strip ANSI codes for readability.
        const last = mergeStderr
          .split('\n')
          .filter(l => l.trim())
          .slice(-4)
          .join(' | ')
          .replace(/\x1b\[[0-9;]*m/g, '')
          .slice(0, 300)
        if (last) sendProgress(`ffmpeg: ${last}`, 0, 'error')
        sendProgress(`Full log: ${logPath || '(no log)'}`, 0, 'error')
        resolve({ success: false, error: mergeStderr.substring(0, 500) })
      }
    })
    merge.on('error', e => {
      sendProgress('Merge launch failed: ' + e.message, 0, 'error')
      resolve({ success: false })
    })
  })
}

ipcMain.handle('remerge-audio', async (event, opts) => {
  const { upscaledFile, originalFile, audioOffset, audioTrack, outputDir, keepAllAudio } = opts
  const send = (msg, pct, type) => {
    mainWindow.webContents.send('process-progress', { msg, pct, type })
  }
  if (!upscaledFile || !originalFile) {
    send('Remerge needs both upscaled video and original source', 0, 'error')
    return { success: false }
  }
  send('Re-merging audio with current offset...', 5, 'info')
  const outDir = outputDir || OUTPUT_DIR
  const base = path.basename(upscaledFile, path.extname(upscaledFile)).replace(/_remerge.*$/, '')
  const offsetTag = audioOffset >= 0 ? `+${audioOffset}` : `${audioOffset}`
  const outFile = path.join(outDir, `${base}_remerge${offsetTag}s.mp4`)
  return runMerge({
    upscaledFile,
    originalFile,
    audioOffset,
    audioTrack,
    outFile,
    contentType: 'anime',
    sendProgress: send,
    keepAllAudio
  })
})

ipcMain.handle('process-video', async (event, opts) => {
  const { filePath, contentType, scale, outputDir, audioTrack, audioOffset } = opts

  // Per-run log file — timestamp + source filename so runs don't overwrite each other.
  // Old behaviour wrote everything to last-run.log which got destroyed on the next
  // process-video call — meaning a crash followed by a retry erased the crash log.
  // Now each run is preserved as its own file under data/logs/.
  const LOG_DIR = path.join(VIRGIL_DIR, 'logs')
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }) } catch(e) {}
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeSourceName = path.basename(filePath).replace(/[^\w.-]/g, '_').slice(0, 60)
  const logPath = path.join(LOG_DIR, `virgil-${runTimestamp}__${safeSourceName}.log`)

  try {
    fs.writeFileSync(logPath, `Virgil run @ ${new Date().toISOString()}\nFile: ${filePath}\nScale: ${scale}, Type: ${contentType}\nLog: ${logPath}\n\n`)
  } catch(e) {}

  // Trim oldest log files so the logs/ folder doesn't grow unbounded.
  // Keeps the 30 most recent runs — plenty for debugging without disk bloat.
  try {
    const allLogs = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('virgil-') && f.endsWith('.log'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    allLogs.slice(30).forEach(f => {
      try { fs.unlinkSync(path.join(LOG_DIR, f.name)) } catch(e) {}
    })
  } catch(e) {}
  // send() is called dozens of times per second by stderr/stdout listeners.
  // Without throttling, the UI gets bombarded with re-renders and jitters.
  // We throttle informational messages to one per ~150ms, while errors/warnings
  // and progress jumps that the user must see go through immediately.
  // Pct is also kept monotonically non-decreasing so the progress bar doesn't
  // visually rewind when stderr reports a slightly lower percentage.
  let lastInfoSendTime = 0
  let lastSentPct = 0
  const SEND_THROTTLE_MS = 150
  const send = (msg, pct, type) => {
    // Always write to log regardless of throttle so debugging stays complete
    try { fs.appendFileSync(logPath, `[${type || 'info'}] ${msg}\n`) } catch(e) {}

    // Lock progress bar to never go backwards (avoids visual rewind)
    let safePct = pct
    if (typeof pct === 'number') {
      if (pct < lastSentPct && pct !== 0 && pct !== 100) safePct = lastSentPct
      lastSentPct = safePct
    }

    // Throttle only "info" messages — errors, warns, ok, completions go through
    const t = type || 'info'
    if (t === 'info') {
      const now = Date.now()
      if (now - lastInfoSendTime < SEND_THROTTLE_MS) return
      lastInfoSendTime = now
    }

    mainWindow.webContents.send('process-progress', { msg, pct: safePct, type })
  }

  const ffmpegExe = path.join(FFMPEG_DIR, 'ffmpeg.exe')
  const video2xExe = path.join(VIDEO2X_DIR, 'video2x.exe')
  const ffprobeExe = path.join(FFMPEG_DIR, 'ffprobe.exe')
  const outDir = outputDir || OUTPUT_DIR

  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  const outFile = path.join(outDir, `${base}_virgil_${scale}.mp4`)
  // Video2X outputs to MKV — crash-resilient (MKV writes frames as it goes,
  // no clean footer needed). MP4 loses everything if the process crashes before
  // writing the MOOV atom at the end.
  const video2xOutFile = path.join(outDir, `${base}_virgil_${scale}_v2x.mkv`)

  send('Initializing Virgil engine...', 5, 'info')
  send(`Input:  ${path.basename(filePath)}`, 6, 'info')
  send(`Output: ${outFile}`, 7, 'info')

  // 1. Probe source resolution
  const { sourceWidth, sourceHeight } = probeSourceResolution(filePath, ffprobeExe, logPath)

  // 2. Decide on scale factor (2x/3x/4x for Real-ESRGAN)
  const { smartScale, targetHeight, knownSource } = calculateSmartScale(sourceHeight, scale)
  if (knownSource) {
    const projectedHeight = sourceHeight * smartScale
    send(`Source: ${sourceWidth}×${sourceHeight} · Target: ${targetHeight}p · Scale: ${smartScale}× · Projected: ${sourceWidth * smartScale}×${projectedHeight}`, 7, 'info')
    if (sourceHeight >= targetHeight) {
      send(`⚠ Source is already ${sourceHeight}p — upscaling will only add fake detail`, 7, 'warn')
    }
  } else {
    send(`Source resolution unknown — using ${smartScale}× fallback`, 7, 'warn')
  }

  // 3. Strip subs/audio/data so Video2X sees clean video
  const { input: video2xInput, tempStripped } = stripNonVideoTracks(filePath, ffmpegExe, video2xExe, send, ffprobeExe)

  // 4. Detect English audio track from the original (NOT the stripped file)
  const englishTrackIdx = detectEnglishAudioTrack(filePath, ffprobeExe, audioTrack, logPath)

  // 4b. Resolve "Auto Detect" content type by sampling frame saturation
  let effectiveType = contentType
  if (contentType === 'auto') {
    effectiveType = autoDetectContentType(filePath, ffmpegExe, ffprobeExe, send)
  }

  // 5. Build the right upscaler command (model depends on enhance + content type)
  const cmd = buildUpscalerCommand({
    video2xExe, ffmpegExe,
    video2xInput, originalFile: filePath, outFile: video2xOutFile,
    smartScale, scale,
    enhance: opts.enhance, contentType: effectiveType
  })
  if (!cmd) {
    send('No processing tools found — please run Setup first', 0, 'error')
    return { success: false }
  }
  if (cmd.mode === 'video2x') {
    send('GPU acceleration · Vulkan · hardware encoder', 8, 'ok')
    send(`AI model: ${cmd.model} · ${cmd.maxQuality ? 'Max Quality' : 'Balanced'} · ${cmd.scaleUsed}× (${effectiveType})`, 8, 'info')
    if (cmd.maxQuality) {
      send('Max Quality: plus model runs at native 4× — target resolution is approximate in this mode', 8, 'info')
    }
    send(`Audio: English only (track ${englishTrackIdx}) · subtitles stripped`, 9, 'info')
  } else {
    send('Video2X not found — using FFmpeg fallback', 8, 'warn')
  }

  // 6. Run upscale + merge
  return new Promise((resolve) => {
    const { exe, args } = cmd

    send(`Processing: ${path.basename(filePath)}`, 10, 'info')

    cancelRequested = false
    const proc = spawn(exe, args)
    currentProc = proc
    let pct = 10

    const ticker = setInterval(() => {
      if (pct < 90) { pct += 1; send('Processing frames...', pct, 'info') }
    }, 4000)

    const parseProgress = (line) => {
      const pctMatch = line.match(/(\d{1,3})\s*%/)
      const etaMatch = line.match(/(?:ETA|eta|remaining)[:\s=]+([\d:]+)/i)
      const fpsMatch = line.match(/fps[:=\s]+(\d+(?:\.\d+)?)/i)
      if (pctMatch || etaMatch) {
        const livePct = pctMatch ? Math.min(88, 10 + Math.floor(parseInt(pctMatch[1]) * 0.78)) : pct
        const parts = []
        if (pctMatch) parts.push(`${pctMatch[1]}%`)
        if (fpsMatch) parts.push(`${fpsMatch[1]} fps`)
        if (etaMatch) parts.push(`ETA ${etaMatch[1]}`)
        send(parts.join(' · '), livePct, 'info')
        if (pctMatch) pct = livePct
        return true
      }
      return false
    }

    proc.stderr.on('data', data => {
      if (cancelRequested) return
      const line = data.toString().trim()
      try { fs.appendFileSync(logPath, `[stderr] ${line}\n`) } catch(e) {}
      if (parseProgress(line)) return
      if (line.includes('frame=')) {
        const match = line.match(/frame=\s*(\d+)/)
        if (match) send(`Frame ${match[1]} processed`, Math.min(pct, 88), 'info')
      }
      if (line.includes('Error') || line.includes('error') || line.includes('failed') || line.includes('FAILED')) {
        send('ERR: ' + line.substring(0, 200), pct, 'warn')
      }
    })

    proc.stdout.on('data', data => {
      if (cancelRequested) return
      const line = data.toString().trim()
      try { fs.appendFileSync(logPath, `[stdout] ${line}\n`) } catch(e) {}
      if (!parseProgress(line) && line) send(line.substring(0, 100), pct, 'info')
    })

    const cleanupTemp = () => {
      if (tempStripped && fs.existsSync(tempStripped)) {
        try { fs.unlinkSync(tempStripped) } catch(e) {}
      }
    }

    proc.on('close', code => {
      clearInterval(ticker)
      currentProc = null
      if (cancelRequested) {
        cleanupTemp()
        // wipe any partial output
        try { if (fs.existsSync(video2xOutFile)) fs.unlinkSync(video2xOutFile) } catch(e) {}
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile) } catch(e) {}
        send('Cancelled by user — cleaning up...', 0, 'warn')
        send('Ready for next job', 0, 'info')
        return resolve({ success: false, cancelled: true })
      }
      const outOk = fs.existsSync(video2xOutFile) && fs.statSync(video2xOutFile).size > 1024 * 100
      if (code === 0 || outOk) {
        if (code !== 0 && outOk) {
          send(`Video2X exited ${code} but output saved successfully — continuing`, 91, 'warn')
        }
        send('Video done — merging audio with FPS fix...', 92, 'ok')

        runMerge({
          upscaledFile: video2xOutFile,
          originalFile: filePath,
          audioOffset,
          audioTrack: englishTrackIdx,
          outFile,
          contentType: effectiveType,
          sendProgress: send,
          logPath,
          keepAllAudio: opts.keepAllAudio
        }).then(result => {
          // remove the MKV intermediate
          try { if (fs.existsSync(video2xOutFile)) fs.unlinkSync(video2xOutFile) } catch(e) {}
          cleanupTemp()
          send(`Done — saved to ${outFile}`, 100, 'ok')
          notifyJobDone('Virgil — Remaster Complete', path.basename(outFile))
          resolve(result)
        })
      } else {
        cleanupTemp()
        send(`Process exited with code ${code}`, 0, 'error')
        send(`Log: ${logPath}`, 0, 'error')
        notifyJobDone('Virgil — Remaster Failed', `${path.basename(filePath)} (exit code ${code})`)
        resolve({ success: false })
      }
    })

    proc.on('error', err => {
      clearInterval(ticker)
      cleanupTemp()
      send('Failed to launch: ' + err.message, 0, 'error')
      notifyJobDone('Virgil — Remaster Failed', `${path.basename(filePath)} — ${err.message}`)
      resolve({ success: false })
    })
  })
})

ipcMain.handle('probe-tracks', async (event, filePath) => {
  const ffprobe = path.join(FFMPEG_DIR, 'ffprobe.exe')
  if (!fs.existsSync(ffprobe)) return { tracks: [] }
  return new Promise((resolve) => {
    const proc = spawn(ffprobe, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      filePath
    ])
    let out = ''
    proc.stdout.on('data', d => out += d.toString())
    proc.on('close', () => {
      try {
        const data = JSON.parse(out)
        const tracks = (data.streams || []).map((s, i) => ({
          index: i,
          codec: s.codec_name || 'unknown',
          language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'unknown',
          title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
          channels: s.channels || 2
        }))
        resolve({ tracks })
      } catch(e) {
        resolve({ tracks: [] })
      }
    })
    proc.on('error', () => resolve({ tracks: [] }))
  })
})
