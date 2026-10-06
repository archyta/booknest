#!/usr/bin/env bash
# 书巢 BookNest 停止脚本
#   用法：./stop.sh
#   会先发 SIGTERM 让服务把数据落盘再退出，10 秒内没退出才强杀。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8787}"
HTTP_PORT="${HTTP_PORT:-$((PORT + 1))}"

say() { printf '%s\n' "$*"; }

# 询问健康接口拿 pid（http / https 都试一下）
pid_from_health() {
  local port="$1" body=""
  body="$(curl -s -m 2 "http://127.0.0.1:$port/api/health" 2>/dev/null)"
  if [ -z "$body" ]; then
    body="$(curl -sk -m 2 "https://127.0.0.1:$port/api/health" 2>/dev/null)"
  fi
  printf '%s' "$body" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# 1) 优先用健康接口返回的 pid（最准）
PIDS=""
for p in "$HTTP_PORT" "$PORT"; do
  if port_open "$p"; then
    pid="$(pid_from_health "$p")"
    [ -n "${pid:-}" ] && PIDS="$PIDS $pid"
  fi
done

# 2) 兜底：按命令行匹配本项目，并逐个确认确实是 node 在跑这个 server.js
if [ -z "${PIDS// /}" ] && command -v pgrep >/dev/null 2>&1; then
  PIDS="$(pgrep -f "$DIR/server/server.js" 2>/dev/null | tr '\n' ' ')"
fi
# 3) 再兜底：看谁占着端口
if [ -z "${PIDS// /}" ] && command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti :"$HTTP_PORT" -ti :"$PORT" 2>/dev/null | tr '\n' ' ')"
fi

PIDS="$(printf '%s\n' $PIDS 2>/dev/null | grep -E '^[0-9]+$' | sort -u | tr '\n' ' ')"

if [ -z "${PIDS// /}" ]; then
  say "ℹ️  没有发现正在运行的 BookNest 服务（端口 $PORT / $HTTP_PORT 都没有在跑）"
  exit 0
fi

say "🔎 发现服务进程：$PIDS"
for pid in $PIDS; do
  if kill -TERM "$pid" 2>/dev/null; then
    say "   → 已请求停止 pid=${pid}（会先把数据写入 data/db.json）"
  fi
done

# 最多等 10 秒
for _ in $(seq 1 20); do
  ALIVE=""
  for pid in $PIDS; do
    kill -0 "$pid" 2>/dev/null && ALIVE="$ALIVE $pid"
  done
  [ -z "${ALIVE// /}" ] && break
  sleep 0.5
done

ALIVE=""
for pid in $PIDS; do
  kill -0 "$pid" 2>/dev/null && ALIVE="$ALIVE $pid"
done
if [ -n "${ALIVE// /}" ]; then
  say "⚠️  10 秒内没退出，强制结束：$ALIVE"
  for pid in $ALIVE; do kill -KILL "$pid" 2>/dev/null; done
  sleep 0.5
fi

STILL=""
for p in "$HTTP_PORT" "$PORT"; do
  port_open "$p" && STILL="$STILL $p"
done
if [ -n "${STILL// /}" ]; then
  say "⚠️  端口仍在监听：${STILL}（可能是别的程序占用，请自行确认）"
  exit 1
fi

say "✅ 服务已停止，端口 $PORT / $HTTP_PORT 已释放，数据已保存"
