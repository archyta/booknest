/* 条码扫描：优先 BarcodeDetector（Android/Chrome 快），iOS 等退回 ZXing 纯 JS；
 * 另外提供「拍照识别」，在 http 非安全上下文/摄像头被拒时也能用。
 */
(function () {
  'use strict';

  const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'];
  const state = {
    stream: null,
    track: null,
    detector: null,
    zxing: null,
    video: null,
    canvas: null,
    ctx: null,
    running: false,
    paused: false,
    torchOn: false,
    devices: [],
    deviceIndex: 0,
    facing: 'environment',
    onDetect: null,
    onStatus: null,
    lastTick: 0,
    rafId: 0,
  };

  function status(msg, kind) {
    if (state.onStatus) state.onStatus(msg, kind);
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1320;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
      setTimeout(() => ctx.close().catch(() => {}), 400);
    } catch (err) {
      /* 忽略 */
    }
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ---------------- ZXing 兜底 ---------------- */

  function hasZXing() {
    return typeof window.ZXing !== 'undefined' && window.ZXing.MultiFormatReader;
  }

  function makeZXingReader() {
    const hints = new Map();
    const formats = [
      window.ZXing.BarcodeFormat.EAN_13,
      window.ZXing.BarcodeFormat.EAN_8,
      window.ZXing.BarcodeFormat.UPC_A,
      window.ZXing.BarcodeFormat.CODE_128,
      window.ZXing.BarcodeFormat.ITF,
    ];
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
    const reader = new window.ZXing.MultiFormatReader();
    reader.setHints(hints);
    return reader;
  }

  function decodeCanvasZXing(canvas) {
    if (!hasZXing()) return null;
    if (!state.zxing) state.zxing = makeZXingReader();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return null;
    const data = ctx.getImageData(0, 0, w, h).data;
    try {
      const source = new window.ZXing.RGBLuminanceSource(data, w, h);
      const bitmap = new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(source));
      const result = state.zxing.decode(bitmap);
      state.zxing.reset();
      return result ? { text: result.getText(), format: String(result.getBarcodeFormat()) } : null;
    } catch (err) {
      try {
        state.zxing.reset();
      } catch (e2) {
        state.zxing = null;
      }
      return null;
    }
  }

  async function detectOnCanvasBD(canvas) {
    if (!state.detector) return null;
    try {
      const results = await state.detector.detect(canvas);
      if (results && results.length) return { text: results[0].rawValue, format: results[0].format };
    } catch (err) {
      /* 忽略 */
    }
    return null;
  }

  async function ensureDetector() {
    if (state.detector !== null) return state.detector;
    if (!('BarcodeDetector' in window)) {
      state.detector = false;
      return false;
    }
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const usable = BARCODE_FORMATS.filter((f) => supported.includes(f));
      if (!usable.length) {
        state.detector = false;
        return false;
      }
      state.detector = new window.BarcodeDetector({ formats: usable });
      return state.detector;
    } catch (err) {
      state.detector = false;
      return false;
    }
  }

  /* ---------------- 摄像头 ---------------- */

  function liveSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch (err) {
      return [];
    }
  }

  async function start(options) {
    const { video, onDetect, onStatus, deviceId } = options || {};
    if (!video) throw new Error('缺少 video 元素');
    if (!liveSupported()) throw new Error('当前浏览器不支持调用摄像头（需要用 https 或 localhost 打开）');
    stop(false);
    state.video = video;
    state.onDetect = onDetect || state.onDetect;
    state.onStatus = onStatus || state.onStatus;

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    };

    status('正在启动摄像头…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError' || err.name === 'TypeError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else {
        throw err;
      }
    }

    state.stream = stream;
    state.track = stream.getVideoTracks()[0] || null;
    // 拿到权限后再枚举设备，才能看到完整的 deviceId
    state.devices = await listCameras();
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    try {
      await video.play();
    } catch (err) {
      /* 自动播放失败时用户手势也可继续 */
    }

    state.canvas = state.canvas || document.createElement('canvas');
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });
    state.running = true;
    state.paused = false;
    state.lastTick = 0;

    await ensureDetector();
    status('把条码放进框内…');
    loop();
    return { usingBarcodeDetector: !!state.detector };
  }

  function stop(updateStatus = true) {
    state.running = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    state.track = null;
    state.torchOn = false;
    if (state.video) state.video.srcObject = null;
    if (updateStatus) status('摄像头已关闭', 'idle');
  }

  function pause() {
    state.paused = true;
  }

  function resume() {
    state.paused = false;
    state.lastTick = 0;
    if (state.running && !state.rafId) loop();
  }

  function loop() {
    if (!state.running) return;
    state.rafId = requestAnimationFrame(loop);
    const now = performance.now();
    const interval = state.detector ? 110 : 220;
    if (state.paused || now - state.lastTick < interval) return;
    state.lastTick = now;
    tick();
  }

  function grabFrame(maxWidth) {
    const video = state.video;
    const canvas = state.canvas;
    if (!video || !canvas) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, (maxWidth || 800) / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    state.ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  }

  async function tick() {
    if (state.paused) return;
    const canvas = grabFrame(state.detector ? 900 : 760);
    if (!canvas) return;
    let hit = null;
    if (state.detector) hit = await detectOnCanvasBD(canvas);
    if (!hit) hit = decodeCanvasZXing(canvas);
    if (hit && hit.text) onHit(hit);
  }

  function onHit(hit) {
    state.paused = true;
    beep();
    vibrate([28, 40, 28]);
    status(`已识别：${hit.text}`, 'ok');
    if (state.onDetect) state.onDetect(hit.text, hit.format);
  }

  async function switchCamera() {
    const devices = await listCameras();
    if (devices.length > 1) {
      state.deviceIndex = (state.deviceIndex + 1) % devices.length;
      const target = devices[state.deviceIndex];
      return start({ video: state.video, onDetect: state.onDetect, onStatus: state.onStatus, deviceId: target.deviceId });
    }
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    return start({ video: state.video, onDetect: state.onDetect, onStatus: state.onStatus });
  }

  async function toggleTorch() {
    if (!state.track) return false;
    const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
    if (!caps || !caps.torch) {
      status('这个镜头不支持补光', 'warn');
      return false;
    }
    state.torchOn = !state.torchOn;
    try {
      await state.track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
      return state.torchOn;
    } catch (err) {
      status('补光切换失败', 'warn');
      return false;
    }
  }

  /* ---------------- 图片（拍照）识别 ---------------- */

  function loadImage(fileOrUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片读取失败'));
      if (typeof fileOrUrl === 'string') {
        img.crossOrigin = 'anonymous';
        img.src = fileOrUrl;
      } else {
        img.src = URL.createObjectURL(fileOrUrl);
      }
    });
  }

  async function decodeImageElement(img) {
    const maxW = 1800;
    const scale = Math.min(1, maxW / (img.naturalWidth || img.width));
    const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    await ensureDetector();
    let hit = await detectOnCanvasBD(canvas);
    if (hit) return hit;

    hit = decodeCanvasZXing(canvas);
    if (hit) return hit;

    // 中间区域放大再试一次（条码常见于照片中部）
    const crops = [
      [0.1, 0.25, 0.8, 0.5],
      [0.0, 0.3, 1.0, 0.4],
      [0.15, 0.15, 0.7, 0.7],
    ];
    for (const [rx, ry, rw, rh] of crops) {
      const c2 = document.createElement('canvas');
      const sx = Math.round(w * rx);
      const sy = Math.round(h * ry);
      const sw = Math.max(1, Math.round(w * rw));
      const sh = Math.max(1, Math.round(h * rh));
      const outW = Math.min(2000, sw * 2);
      const outH = Math.round((sh * outW) / sw);
      c2.width = outW;
      c2.height = outH;
      const c2ctx = c2.getContext('2d', { willReadFrequently: true });
      c2ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
      hit = await detectOnCanvasBD(c2);
      if (!hit) hit = decodeCanvasZXing(c2);
      if (hit) return hit;
    }
    return null;
  }

  async function decodeFile(file) {
    const img = await loadImage(file);
    try {
      return await decodeImageElement(img);
    } finally {
      if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    }
  }

  window.BookScanner = {
    start,
    stop,
    pause,
    resume,
    switchCamera,
    toggleTorch,
    decodeFile,
    decodeImageElement,
    liveSupported,
    isRunning: () => state.running,
    isPaused: () => state.paused,
    beep,
    vibrate,
  };
})();
