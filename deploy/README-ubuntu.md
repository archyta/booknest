# 部署到云端 Ubuntu（Linux）

> 目标：在一台 Ubuntu 服务器上跑起书巢，手机/电脑通过域名或 IP 访问，封面识别用 **Tesseract OCR**（macOS 才有的 Vision 会自动禁用）。
> 实测环境：Ubuntu 22.04 / 24.04，Node 22+（代理功能需要 Node 24）。

---

## 0. 先决条件

| 组件 | 说明 |
| --- | --- |
| Node.js | **建议 24.x**（`NODE_USE_ENV_PROXY` 让 fetch 走代理需要 Node ≥ 24；不挂代理则 18+ 也能跑） |
| tesseract-ocr | 封面文字识别（Linux 上的 OCR 引擎） |
| tesseract-ocr-chi-sim | 中文语言包，**必须装**，否则中文封面识别基本不可用（程序会在启动日志里提示） |
| openssl | 可选，生成 https 自签证书（用反向代理 + 正式证书时不需要） |

---

## 1. 安装依赖

```bash
sudo apt update
sudo apt install -y curl ca-certificates tesseract-ocr tesseract-ocr-chi-sim unzip

# 确认中文语言包在
tesseract --list-langs | grep chi_sim || echo "缺 chi_sim，请检查包名"

# Node 24（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 期望 v24.x
```

## 2. 上传代码

```bash
sudo useradd -r -m -d /opt/booknest -s /usr/sbin/nologin booknest || true
sudo mkdir -p /opt/booknest

# 方式一：本机打包上传（在你自己电脑上执行）
#   rsync -av --exclude data --exclude certs ./booknest/ user@server:/tmp/booknest/
#   ssh user@server 'sudo mv /tmp/booknest/* /opt/booknest/'
# 方式二：服务器上直接 git clone / unzip

sudo chown -R booknest:booknest /opt/booknest
sudo -u booknest mkdir -p /opt/booknest/data
```

## 3. 先手动跑一次，确认 OCR 引擎

```bash
cd /opt/booknest
sudo -u booknest BOOKNEST_PASSWORD='你的密码' node server/server.js
```

启动横幅里应出现：

```
🔍 封面识别: Tesseract OCR（chi_sim）
🔒 访问密码: 已开启（BOOKNEST_PASSWORD）
```

- 如果显示 **`封面上识别: 不可用`** → 检查 `tesseract --list-langs`；也可手动指定：
  `BOOKNEST_OCR=tesseract BOOKNEST_TESSERACT_BIN=/usr/bin/tesseract`
- 如果显示 **缺少中文语言包** → `sudo apt install tesseract-ocr-chi-sim`
- 确认无误后 `Ctrl+C` 停掉，改用 systemd 托管。

## 4. 交给 systemd

```bash
sudo cp /opt/booknest/deploy/booknest.service /etc/systemd/system/booknest.service
sudo nano /etc/systemd/system/booknest.service     # 改掉 BOOKNEST_PASSWORD
sudo systemctl daemon-reload
sudo systemctl enable --now booknest
systemctl status booknest --no-pager
journalctl -u booknest -f                          # 看日志
```

> 如果你把 `BOOKNEST_DATA` 指到了 `/var/lib/booknest`，记得
> `sudo mkdir -p /var/lib/booknest && sudo chown booknest:booknest /var/lib/booknest`。

## 5. 域名 + HTTPS（手机扫码必需）

手机浏览器调用摄像头要求**安全上下文**：`https://` 或 `localhost`。云端有两种做法：

**A. 反向代理 + 正式证书（推荐）**

```bash
sudo apt install -y caddy     # 自动申请 Let's Encrypt 证书
```

`/etc/caddy/Caddyfile`：

```
books.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

```bash
sudo systemctl reload caddy
```

之后用 `https://books.example.com` 访问。注意：此时只需暴露 80/443，
8787/8788 可以只监听内网：

```bash
sudo ufw allow 80,443/tcp
# 不要把 8787/8788 暴露到公网
```

**B. 直接用自签证书**

```bash
cd /opt/booknest && sudo -u booknest ./start.sh    # 生成 certs/ 后 Ctrl+C
```

然后手机访问 `https://<服务器IP>:8787`，首次提示"证书不受信任"→ 继续访问。
（浏览器若因自签证书拒绝摄像头，改用页面里的「拍照识别条码」，它不需要安全上下文。）

## 6. 常用环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8787 | HTTPS 端口（有证书时） |
| `HTTP_PORT` | 8788 | HTTP 端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `BOOKNEST_DATA` | `<项目>/data` | 数据目录（db.json + 封面 + 上传） |
| `BOOKNEST_PASSWORD` | 空 | **云端必设**，设置后所有页面/接口都要登录 |
| `BOOKNEST_PROXY` | 空 | 海外数据源代理，如 `http://127.0.0.1:7890`（服务器在境外则不需要） |
| `BOOKNEST_OCR` | auto | `auto` / `vision` / `tesseract` / `none` |
| `BOOKNEST_TESSERACT_BIN` | 自动查找 | tesseract 可执行文件路径 |
| `BOOKNEST_TESSERACT_LANGS` | 自动 | 语言，默认 `chi_sim`（实测中文封面最好；需要中英混排可试 `chi_sim+eng`） |
| `BOOKNEST_TESSERACT_PSM` | 3 | 页面分割模式，封面建议 3 |
| `BOOKNEST_TESSDATA_PREFIX` | 系统默认 | 自定义语言包目录 |
| `BOOKNEST_HTTP_PROXY` 等 | — | 兼容标准 `HTTPS_PROXY`/`HTTP_PROXY` |

## 7. 备份与迁移

```bash
# 数据就是一个目录
sudo tar czf booknest-backup-$(date +%F).tar.gz -C /opt/booknest data
```

也可以直接在页面「设置 → 导出 JSON」下载带书单/标签的完整备份，换服务器后导入。

## 8. 云端注意事项

1. **务必备份 + 设密码**：数据是明文 JSON，放在公网无密码等于公开你的书架。
2. **豆瓣对机房 IP 更敏感**：云服务器 IP 触发反爬的概率更高，表现为"豆瓣页面结构异常"或 403。
   程序会自动退避重试并缓存结果；实在不行可在「设置」里查看数据源状态，或换个网络出口。
3. **海外源**：服务器在境外（美/日/新等）时 Google Books / Open Library 直连即可，无需代理；
   在境内则设置 `BOOKNEST_PROXY`。
4. **图片上传**：封面照片存放在 `data/uploads/`，7 天后自动清理，可放心。
5. **iOS 拍照格式**：Safari 上传时通常会转成 JPEG；若遇到 HEIC，tesseract 需要
   `sudo apt install libheif-examples` 之类的解码支持，建议在手机上直接拍照上传（一般已是 JPEG）。
6. **升级**：替换代码后 `sudo systemctl restart booknest` 即可，`data/` 不受影响。

## 9. 快速自检清单

```bash
systemctl is-active booknest                 # active
curl -s localhost:8788/api/health            # {"ok":true,...}
tesseract --list-langs | grep chi_sim        # 有输出
journalctl -u booknest -n 30 --no-pager      # 横幅里有 🔍 与 🔒
```
