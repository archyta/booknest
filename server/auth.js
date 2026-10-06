'use strict';

/* 可选的访问密码保护（部署到云端时强烈建议开启）
 *   设置环境变量 BOOKNEST_PASSWORD=你的密码 即开启；不设置则和以前完全一样（无需登录）。
 *   - 未登录访问页面 → 显示登录页；访问 /api/* → 401 JSON
 *   - 登录成功后下发 HttpOnly Cookie（进程重启即失效）
 *   - 支持用 ?token=密码 一次性登录并跳转（方便手机收藏链接）
 *   - 同一 IP 10 分钟内最多尝试 10 次
 */

const crypto = require('crypto');

const PASSWORD = String(process.env.BOOKNEST_PASSWORD || '').trim();
const SECRET = crypto.randomBytes(16).toString('hex');
const COOKIE = 'bn_auth';
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

function enabled() {
  return !!PASSWORD;
}

function token() {
  return crypto.createHash('sha256').update(`${PASSWORD}|${SECRET}`).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (err) {
    return false;
  }
}

function cookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  const c = cookies(req)[COOKIE];
  return !!c && safeEqual(c, token());
}

function clientIp(req) {
  return String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'unknown').trim();
}

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.at > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteAttempt(ip, ok) {
  if (ok) {
    attempts.delete(ip);
    return;
  }
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.at > WINDOW_MS) attempts.set(ip, { count: 1, at: Date.now() });
  else rec.count += 1;
}

function send(res, status, body, headers) {
  const type = typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function loginPage(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>书巢 BookNest · 登录</title>
<style>
:root{color-scheme:light dark}
body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#eef1f7;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,Roboto,sans-serif}
.card{width:min(92vw,340px);background:#171a21;border:1px solid #262b35;border-radius:16px;padding:22px}
h1{margin:0 0 4px;font-size:19px}
p{margin:0 0 16px;font-size:12.5px;color:#8b93a3}
input{width:100%;box-sizing:border-box;height:44px;border-radius:11px;border:1px solid #2c3240;background:#0f1115;
color:#eef1f7;padding:0 12px;font-size:15px;outline:none}
input:focus{border-color:#4f8cff}
button{width:100%;height:44px;margin-top:12px;border:0;border-radius:11px;background:#2563eb;color:#fff;
font-size:15px;font-weight:600;cursor:pointer}
.msg{margin-top:12px;font-size:12.5px;color:#f87171;min-height:18px}
</style></head><body>
<form class="card" method="POST" action="/login">
  <h1>📚 书巢 BookNest</h1>
  <p>这台服务器启用了访问密码，请输入后继续</p>
  <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="current-password">
  <button type="submit">进入书架</button>
  <div class="msg">${message ? String(message).replace(/[<>&]/g, '') : ''}</div>
</form>
</body></html>`;
}

/**
 * 认证中间件：需要拦截时直接写出响应并返回 true
 */
function handle(req, res, url) {
  if (!PASSWORD) return false;

  // 用 ?token=密码 直接登录（方便收藏一个带密码的链接）
  const qToken = url.searchParams.get('token');
  if (qToken && safeEqual(qToken, PASSWORD)) {
    url.searchParams.delete('token');
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      Location: `${url.pathname}${url.search}`,
    });
    res.end();
    return true;
  }

  const path = url.pathname;
  if (path === '/api/health') return false;

  if (path === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) {
      send(res, 429, loginPage('尝试次数过多，请 10 分钟后再试'));
      return true;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const pwd = String(params.get('password') || '');
      if (safeEqual(pwd, PASSWORD)) {
        noteAttempt(ip, true);
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          Location: '/',
        });
        res.end();
      } else {
        noteAttempt(ip, false);
        send(res, 401, loginPage('密码不正确'));
      }
    });
    return true;
  }

  if (path === '/logout') {
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`, Location: '/login' });
    res.end();
    return true;
  }

  if (isAuthed(req)) return false;

  if (path.startsWith('/api/')) {
    send(res, 401, { error: '未登录或登录已过期，请刷新页面重新登录' });
    return true;
  }
  if (path === '/login') {
    send(res, 200, loginPage(''));
    return true;
  }
  // 其它静态资源：只有页面请求给登录页，资源类给 401，避免把登录页当 JS 返回
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html')) {
    send(res, 200, loginPage(''));
  } else {
    send(res, 401, { error: 'unauthorized' });
  }
  return true;
}

module.exports = { enabled, handle, isAuthed, COOKIE };
