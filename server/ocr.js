'use strict';

/* 封面文字识别（多引擎，便于部署到 Ubuntu 等 Linux 环境）
 *   macOS : 系统自带 Vision 框架（引擎名 vision），中文准、零安装
 *   Linux : Tesseract OCR（引擎名 tesseract），需要二进制 + 中文语言包
 *   都没有时返回明确提示，前端退化成"手动输入书名"。
 *
 * 环境变量：
 *   BOOKNEST_OCR=auto|vision|tesseract|none     强制/自动选择引擎（默认 auto）
 *   BOOKNEST_TESSERACT_BIN=/usr/bin/tesseract   指定 tesseract 路径
 *   BOOKNEST_TESSERACT_LANGS=chi_sim+eng        指定语言（默认自动挑）
 *   BOOKNEST_TESSERACT_PSM=3                    页面分割模式（默认 3）
 *   BOOKNEST_TESSDATA_PREFIX=…                  自定义语言包目录
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { similarity, clean } = require('./util');

const DATA_DIR = process.env.BOOKNEST_DATA || path.resolve(__dirname, '..', 'data');
const SCRIPT_FILE = path.join(DATA_DIR, 'vision-ocr.jxa');

/* ---------------- macOS Vision ---------------- */

const JXA_SOURCE = `ObjC.import('Foundation');
ObjC.import('Vision');
function recognize(imagePath) {
  const url = $.NSURL.fileURLWithPath(imagePath);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, {});
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.recognitionLanguages = ['zh-Hans', 'en-US'];
  request.usesLanguageCorrection = true;
  const requests = $([request]);
  handler.performRequestsError(requests, null);
  const results = request.results;
  const out = [];
  for (let i = 0; i < (results ? results.count : 0); i++) {
    const cands = results.objectAtIndex(i).topCandidates(1);
    if (cands.count > 0) {
      const c = cands.objectAtIndex(0);
      out.push(ObjC.unwrap(c.string) + '\\t' + c.confidence.toFixed(3));
    }
  }
  return out.join('\\n');
}
const args = $.NSProcessInfo.processInfo.arguments;
const imagePath = ObjC.unwrap(args.objectAtIndex(args.count - 1));
try {
  // 注意：JXA 里 console.log 会写到 stderr，这里显式写 stdout，方便 Node 读取
  const text = recognize(imagePath);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text).dataUsingEncoding(4));
} catch (e) {
  $.NSFileHandle.fileHandleWithStandardError.writeData($('OCR_ERROR ' + e + '\\n').dataUsingEncoding(4));
  $.exit(1);
}
`;

function ensureScript() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let current = '';
  try {
    current = fs.existsSync(SCRIPT_FILE) ? fs.readFileSync(SCRIPT_FILE, 'utf8') : '';
  } catch (err) {
    current = '';
  }
  if (current !== JXA_SOURCE) fs.writeFileSync(SCRIPT_FILE, JXA_SOURCE, 'utf8');
  return SCRIPT_FILE;
}

function visionAvailable() {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/osascript');
}

function recognizeVision(imagePath, { timeout = 25000 } = {}) {
  const script = ensureScript();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script, imagePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('封面识别超时'));
    }, timeout);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动系统 OCR：${e.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (/OCR_ERROR/.test(err)) return reject(new Error('系统 OCR 识别失败（图片可能已损坏）'));
      const lines = out
        .split('\n')
        .map((row) => {
          const [text, conf] = row.split('\t');
          return { text: clean(text || ''), confidence: Number(conf) || 0 };
        })
        .filter((l) => l.text);
      return resolve({ lines, text: lines.map((l) => l.text).join('\n'), engine: 'vision' });
    });
  });
}

/* ---------------- Tesseract（Linux 主力，macOS 也可用） ---------------- */

let tessCache = null;

/** 语言包目录：BOOKNEST_TESSDATA_PREFIX 会映射成 tesseract 认的 TESSDATA_PREFIX */
function tessEnv() {
  const env = { ...process.env };
  if (process.env.BOOKNEST_TESSDATA_PREFIX && !env.TESSDATA_PREFIX) {
    env.TESSDATA_PREFIX = process.env.BOOKNEST_TESSDATA_PREFIX;
  }
  return env;
}

function findTesseractBin() {  const explicit = process.env.BOOKNEST_TESSERACT_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    '/usr/bin/tesseract',
    '/usr/local/bin/tesseract',
    '/opt/homebrew/bin/tesseract',
    '/snap/bin/tesseract',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const p = execFileSync('bash', ['-lc', 'command -v tesseract'], { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch (err) {
    /* ignore */
  }
  return '';
}

function tesseractInfo() {
  if (tessCache) return tessCache;
  const bin = findTesseractBin();
  if (!bin) {
    tessCache = { bin: '', available: false, langs: '', allLangs: [], hasChinese: false, reason: '未找到 tesseract 可执行文件' };
    return tessCache;
  }
  let allLangs = [];
  try {
    const out = execFileSync(bin, ['--list-langs'], { encoding: 'utf8', timeout: 10000, env: tessEnv() });
    allLangs = String(out)
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !/[:：]/.test(s) && !/^List of/i.test(s));
  } catch (err) {
    allLangs = [];
  }
  const envLangs = String(process.env.BOOKNEST_TESSERACT_LANGS || '').trim();
  const has = (name) => allLangs.includes(name);
  let langs = envLangs;
  if (!langs) {
    // 实测：中文封面上 `chi_sim` 单独用最好；一旦把 eng 加进去，大号汉字会被英文模型抢走，
    // 出现 "AWE / Mopi2l Lit" 这类乱码。而 chi_sim 本身对英文也识别得不错，所以默认只用它。
    if (has('chi_sim')) langs = 'chi_sim';
    else if (has('chi_tra')) langs = 'chi_tra';
    else if (has('eng')) langs = 'eng';
    else langs = allLangs[0] || 'eng';
  }
  const hasChinese = /chi_sim|chi_tra/.test(langs) && (!!envLangs || has('chi_sim') || has('chi_tra'));
  tessCache = {
    bin,
    available: true,
    langs,
    allLangs,
    hasChinese,
    reason: hasChinese ? '' : '缺少中文语言包 chi_sim',
  };
  return tessCache;
}

/** 把 tesseract 的 TSV 输出按行聚合（中文常按单字输出，拼接时中文之间不加空格） */
function parseTsv(out) {
  const rows = String(out || '').split('\n');
  const lineMap = new Map();
  const order = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i].split('\t');
    if (cols.length < 12) continue;
    const key = `${cols[2]}-${cols[3]}-${cols[4]}`;
    const conf = Number(cols[10]);
    const text = cols.slice(11).join('\t').trim();
    if (!text) continue;
    if (!lineMap.has(key)) {
      lineMap.set(key, { words: [], confs: [] });
      order.push(key);
    }
    const entry = lineMap.get(key);
    entry.words.push(text);
    if (Number.isFinite(conf) && conf >= 0) entry.confs.push(conf);
  }
  return order
    .map((key) => {
      const { words, confs } = lineMap.get(key);
      let text = '';
      for (const w of words) {
        if (!text) {
          text = w;
          continue;
        }
        const prev = text[text.length - 1];
        const needSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(w);
        text += (needSpace ? ' ' : '') + w;
      }
      const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
      return { text: clean(text), confidence: avg > 0 ? Math.round((avg / 100) * 1000) / 1000 : 0 };
    })
    .filter((l) => l.text);
}

function recognizeTesseract(imagePath, { timeout = 45000 } = {}) {
  const info = tesseractInfo();
  if (!info.available) return Promise.reject(new Error(info.reason || '未找到 tesseract'));
  const psm = String(process.env.BOOKNEST_TESSERACT_PSM || '3');
  // 用配置变量而不是 `tsv` 配置文件：自定义 TESSDATA_PREFIX 目录里通常没有 configs/tsv
  const args = [imagePath, 'stdout', '-l', info.langs, '--psm', psm, '-c', 'tessedit_create_tsv=1'];
  return new Promise((resolve, reject) => {
    const child = spawn(info.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: tessEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('封面识别超时（tesseract）'));
    }, timeout);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 tesseract：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = parseTsv(out);
      if (!lines.length) {
        if (code !== 0) {
          const hint = /Failed loading language|Error opening data file/.test(err)
            ? '（语言包缺失，Ubuntu 可执行 sudo apt install tesseract-ocr-chi-sim）'
            : '';
          return reject(new Error(`tesseract 识别失败${hint}`));
        }
        return resolve({ lines: [], text: '', engine: 'tesseract' });
      }
      return resolve({ lines, text: lines.map((l) => l.text).join('\n'), engine: 'tesseract' });
    });
  });
}

/* ---------------- 引擎选择 ---------------- */

function resolveEngine() {
  const forced = String(process.env.BOOKNEST_OCR || 'auto').toLowerCase();
  if (forced === 'none' || forced === 'off') return 'none';
  if (forced === 'vision') return visionAvailable() ? 'vision' : 'none';
  if (forced === 'tesseract') return tesseractInfo().available ? 'tesseract' : 'none';
  if (visionAvailable()) return 'vision';
  if (tesseractInfo().available) return 'tesseract';
  return 'none';
}

/** 供接口与页面展示的引擎状态 */
function engineAvailable() {
  const engine = resolveEngine();
  if (engine === 'vision') {
    return { ok: true, engine: 'vision', label: 'macOS Vision', platform: process.platform, hint: '' };
  }
  if (engine === 'tesseract') {
    const info = tesseractInfo();
    return {
      ok: true,
      engine: 'tesseract',
      label: `Tesseract OCR（${info.langs}）`,
      platform: process.platform,
      langs: info.langs,
      hasChinese: !!info.hasChinese,
      hint: info.hasChinese
        ? ''
        : '未安装中文语言包 chi_sim，中文识别效果很差；Ubuntu 上执行 sudo apt install tesseract-ocr-chi-sim',
    };
  }
  return {
    ok: false,
    engine: 'none',
    platform: process.platform,
    reason:
      process.platform === 'linux'
        ? '未检测到 tesseract，封面文字识别不可用（可用「手动输入书名」录入）'
        : `封面文字识别不可用（当前系统 ${process.platform}）`,
    hint:
      process.platform === 'linux'
        ? 'Ubuntu/Debian 安装：sudo apt install tesseract-ocr tesseract-ocr-chi-sim'
        : 'macOS 通常自带 Vision；也可安装 tesseract 后设置 BOOKNEST_OCR=tesseract',
  };
}

/** 识别图片中的文字 */
async function recognize(imagePath, opts = {}) {
  const engine = resolveEngine();
  if (engine === 'vision') return recognizeVision(imagePath, opts);
  if (engine === 'tesseract') return recognizeTesseract(imagePath, opts);
  const info = engineAvailable();
  throw new Error(info.reason || '没有可用的 OCR 引擎');
}

/* ---------------- 从识别文本里挑书名候选 ---------------- */

const NOISE_PATTERNS = [
  /^(著|译|编|编著|主编|作者|责任编辑|封面设计|排版|印刷|发行|出版发行)/,
  /(ISBN|定价|印刷|发行|版权所有|图书在版编目|CIP|开本|印张|字数)/i,
  /^[\d\s.\-—]+$/,
  /^[\d.]+\s*元$/,
  /^第?\s*\d+\s*(版|次|册|卷)$/,
];

function isNoiseLine(line) {
  const t = String(line || '').replace(/\s+/g, '');
  if (t.length < 2) return true;
  if (t.length > 40) return true;
  for (const re of NOISE_PATTERNS) if (re.test(t)) return true;
  if (/(出版社|出版公司|出版集团|书局|书店|印书馆|文化传媒|图书有限公司)$/.test(t) && t.length <= 14) return true;
  if (/(著|译|编|主编|编著)$/.test(t) && t.length <= 16) return true;
  return false;
}

function lineScore(line, index) {
  let score = 0;
  if (index === 0) score += 0.6;
  else if (index === 1) score += 0.3;
  const len = line.length;
  if (len >= 2 && len <= 16) score += 0.5;
  else if (len <= 24) score += 0.25;
  if (/[\u4e00-\u9fa5]/.test(line)) score += 0.2;
  else if (/[A-Za-z]/.test(line)) score += 0.15;
  return score;
}

/** 从 OCR 行里挑出可能的书名行（最多 2 条查询，避免过多请求） */
function pickQueries(lines) {
  const cleaned = (lines || [])
    .filter((l) => l.confidence === 0 || l.confidence >= 0.25)
    .map((l) => l.text)
    .filter(Boolean);
  const usable = cleaned.filter((t) => !isNoiseLine(t));
  const pool = usable.length ? usable : cleaned;
  const ranked = pool
    .map((text, index) => ({ text, score: lineScore(text, cleaned.indexOf(text)) }))
    .sort((a, b) => b.score - a.score);
  const queries = [];
  for (const item of ranked) {
    if (queries.length >= 2) break;
    if (queries.some((q) => similarity(q, item.text) > 0.85)) continue;
    queries.push(item.text);
  }
  return { queries, cleaned, usable };
}

/** 依据整段封面文字给候选打分（书名相似度 85% + 作者命中 15%） */
function rankCandidates(candidates, lines, text) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\-_:：·、,，.。()（）\[\]【】《》<>《》"'’“”]/g, '');
  const full = norm(text);
  const lineList = (lines || []).map((l) => l.text).filter(Boolean);

  // 作者名是否出现在封面文字里（去掉 [以] / 【美】 这类国别前缀后取子串匹配）
  const authorHit = (author) => {
    let name = norm(author).replace(/^\[[^\]]*\]/, '').replace(/^【[^】]*】/, '');
    name = name.replace(/^(著|编著|主编|译|等)/, '');
    if (name.length < 2) return 0;
    const limit = Math.min(name.length, 10);
    for (let len = Math.min(4, limit); len >= 2; len -= 1) {
      for (let i = 0; i + len <= limit; i += 1) {
        if (full.includes(name.slice(i, i + len))) return 1;
      }
    }
    return 0;
  };

  const out = [];
  for (const c of candidates) {
    if (!c || !c.title) continue;
    let best = 0;
    for (const line of lineList) best = Math.max(best, similarity(c.title, line));
    if (full && norm(c.title).length >= 2 && full.includes(norm(c.title))) best = Math.max(best, 0.95);
    const authorScore = c.author ? authorHit(c.author) : 0;
    const score = Math.min(1, Math.round((Math.min(1, best) * 0.85 + authorScore * 0.15) * 100) / 100);
    out.push({ ...c, score, authorHit: !!authorScore });
  }
  out.sort((a, b) => b.score - a.score);

  // 同名同作者的条目（多为同一本书的不同版本）只留分数最高的一个
  const authorKey = (a) =>
    norm(String(a || '').replace(/^\[[^\]]*\]/, '').replace(/^【[^】]*】/, '')).slice(0, 4);
  const seen = new Set();
  return out.filter((c) => {
    const key = `${norm(c.title)}|${authorKey(c.author)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  recognize,
  engineAvailable,
  pickQueries,
  rankCandidates,
  isNoiseLine,
  parseTsv,
  resolveEngine,
  tesseractInfo,
  SCRIPT_FILE,
};
