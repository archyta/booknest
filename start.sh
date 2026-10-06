#!/usr/bin/env bash
# 书巢 BookNest 启动脚本：自动找 node、按需生成 https 自签证书，然后启动服务
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-8787}"
HTTP_PORT="${HTTP_PORT:-$((PORT + 1))}"
CERT_DIR="$DIR/certs"

say() { printf '%s\n' "$*"; }

# ---------- 找 node ----------
find_node() {
  local candidates=()
  [ -n "${BOOKNEST_NODE:-}" ] && [ -x "${BOOKNEST_NODE}" ] && candidates+=("${BOOKNEST_NODE}")
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  candidates+=(
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "/usr/bin/node"
  )
  # nvm 安装的各个版本
  local p
  for p in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$p" ] && candidates+=("$p")
  done
  # 选主版本号最高的（代理功能需要 Node 24+）
  local best="" best_major=0 v major
  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    v="$("$c" -e 'process.stdout.write(process.versions.node)' 2>/dev/null)" || continue
    major="${v%%.*}"
    case "$major" in ''|*[!0-9]*) continue ;; esac
    if [ "$major" -gt "$best_major" ]; then best_major="$major"; best="$c"; fi
  done
  [ -n "$best" ] && printf '%s' "$best"
}

NODE_BIN="$(find_node || true)"
if [ -z "${NODE_BIN:-}" ]; then
  say "❌ 没有找到 node（需要 Node.js 18 以上）。"
  say "   安装方式：brew install node  或到 https://nodejs.org 下载。"
  exit 1
fi
say "✅ node: $NODE_BIN ($("$NODE_BIN" -v))"

# ---------- 生成 https 自签证书（手机摄像头需要安全上下文）----------
gen_cert() {
  if ! command -v openssl >/dev/null 2>&1; then
    say "ℹ️  没有 openssl，跳过证书生成：只能用电脑 localhost 打开（手机端摄像头不可用，可改用拍照识别）。"
    return
  fi
  mkdir -p "$CERT_DIR"
  # 本机局域网 IPv4：Linux 用 ip，macOS/BSD 用 ifconfig
  local ips=()
  if command -v ip >/dev/null 2>&1; then
    for i in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
      case "$i" in 127.*) ;; *) ips+=("$i") ;; esac
    done
  fi
  if [ "${#ips[@]}" -eq 0 ]; then
    for i in $(ifconfig 2>/dev/null | awk '/inet /{print $2}' | sed 's/^addr://'); do
      case "$i" in 127.*) ;; *) ips+=("$i") ;; esac
    done
  fi
  local san="DNS:localhost,IP:127.0.0.1"
  for i in "${ips[@]:-}"; do [ -n "$i" ] && san="$san,IP:$i"; done

  cat > "$CERT_DIR/openssl.cnf" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = BookNest Local

[v3_req]
keyUsage = keyEncipherment, dataEncipherment, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $san
EOF

  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" \
    -config "$CERT_DIR/openssl.cnf" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/server.key" || true
  say "🔐 已生成 https 自签证书（覆盖 IP: ${ips[*]:-无}）"
}

if [ ! -f "$CERT_DIR/server.key" ] || [ ! -f "$CERT_DIR/server.crt" ]; then
  gen_cert
else
  say "🔐 使用已有证书：$CERT_DIR/server.crt"
fi

# ---------- 代理（国内访问 Google Books / Open Library）----------
# 优先级：BOOKNEST_PROXY 环境变量 > 设置页保存的代理 > 已有 HTTPS_PROXY > 自动探测常见本地代理端口
read_stored_proxy() {
  [ -f "$DIR/data/db.json" ] || return 0
  "$NODE_BIN" -e "
    try {
      const s = require('$DIR/data/db.json').settings || {};
      const p = s.proxy || {};
      process.stdout.write(p.enabled === false ? '' : (p.url || ''));
    } catch (e) {}
  " 2>/dev/null || true
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

detect_proxy() {
  for p in 7890 7897 10809 10808 8888 8118 1087 2080; do
    if port_open "$p"; then printf 'http://127.0.0.1:%s' "$p"; return 0; fi
  done
  return 1
}

PROXY="${BOOKNEST_PROXY:-}"
PROXY_SRC="BOOKNEST_PROXY"
if [ -z "$PROXY" ]; then
  STORED_PROXY="$(read_stored_proxy)"
  if [ -n "$STORED_PROXY" ]; then PROXY="$STORED_PROXY"; PROXY_SRC="设置页保存"; fi
fi
if [ -z "$PROXY" ]; then
  ENV_PROXY="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
  if [ -n "$ENV_PROXY" ]; then PROXY="$ENV_PROXY"; PROXY_SRC="环境变量"; fi
fi
if [ -z "$PROXY" ]; then
  if DETECTED_PROXY="$(detect_proxy)"; then PROXY="$DETECTED_PROXY"; PROXY_SRC="自动探测"; fi
fi
case "${PROXY:-}" in off|none|OFF|NONE) PROXY=""; PROXY_SRC="已关闭" ;; esac

if [ -n "${PROXY:-}" ]; then
  NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  if [ "${NODE_MAJOR:-0}" -lt 24 ]; then
    say "⚠️  已配置代理 ${PROXY}，但当前 Node v${NODE_MAJOR} 的 fetch 不支持环境变量代理（需 Node 24+），海外源仍不可达"
  else
    export NODE_USE_ENV_PROXY=1
    export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
    export NO_PROXY="localhost,127.0.0.1,::1,douban.com,doubanio.com,qq.com,wechat.com,weread.qq.com"
    say "🌐 海外数据源（Google Books / Open Library）走代理：$PROXY  [$PROXY_SRC]"
  fi
else
  say "ℹ️  未启用代理：Google Books / Open Library 在国内通常不可达（会自动跳过，不影响豆瓣/微信读书）"
  say "   如需启用：BOOKNEST_PROXY=http://127.0.0.1:7890 ./start.sh，或在页面「设置 → 网络代理」填写后重启"
fi

# ---------- 启动 ----------
export PORT HTTP_PORT
say ""
say "启动中…（Ctrl+C 停止）"
exec "$NODE_BIN" "$DIR/server/server.js"
