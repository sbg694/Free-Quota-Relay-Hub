#!/usr/bin/env bash
# FQRH v4 一键部署到 systemd（Debian/Ubuntu/CentOS/Fedora 均可）
#
#   sudo bash scripts/install-linux.sh
#
# 幂等：可以重复执行（升级代码时也是重新跑一遍）。
# 安装到：
#   /opt/fqrh        程序（只读运行）
#   /etc/fqrh        config.json + fqrh.env + keys/（root:组 640，服务只读）
#   /var/lib/fqrh    数据目录（账本 data/fqrh.db，服务可写）
set -euo pipefail

APP_DIR=/opt/fqrh
ETC_DIR=/etc/fqrh
DATA_DIR=/var/lib/fqrh
SVC_NAME=fqrh
SVC_USER=fqrh

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "请用 root 运行：sudo bash scripts/install-linux.sh" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "没有 systemd（容器环境请改用 deploy/Dockerfile）" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node：请先安装 Node.js 24（或 22.5+）：https://nodejs.org/" >&2
  exit 1
fi
NODE_BIN=$(command -v node)
NODE_VER=$("$NODE_BIN" -p 'process.versions.node')
NODE_MAJOR=${NODE_VER%%.*}
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 版本过低：$NODE_VER（需要 22.5+，推荐 24）" >&2
  exit 1
fi
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

echo "[1/6] 创建服务用户与目录"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
    || useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin "$SVC_USER"
fi
install -d -m 0755 "$APP_DIR" "$DATA_DIR" "$DATA_DIR/data" "$DATA_DIR/data/keys"
install -d -m 0750 "$ETC_DIR" "$ETC_DIR/keys"

echo "[2/6] 复制程序到 $APP_DIR"
for item in src scripts deploy config.example.json config.demo.json README.md; do
  if [ -e "$SRC_DIR/$item" ]; then
    rm -rf "$APP_DIR/$item"
    cp -a "$SRC_DIR/$item" "$APP_DIR/"
  fi
done

echo "[3/6] 初始化配置"
# 配置放在服务可写的数据目录（面板改配置要写盘）；/etc 只放 env 与密钥
CFG="$DATA_DIR/config.json"
if [ ! -f "$CFG" ]; then
  if [ -f "$ETC_DIR/config.json" ]; then
    mv "$ETC_DIR/config.json" "$CFG"
  else
    cp "$APP_DIR/config.example.json" "$CFG"
  fi
  echo "  已生成 $CFG（记得编辑 providers / clientKeys，或用面板添加）"
fi
chown "$SVC_USER:$SVC_USER" "$CFG"
chmod 640 "$CFG"
if [ ! -f "$ETC_DIR/fqrh.env" ]; then
  cp "$APP_DIR/deploy/systemd/fqrh.env.example" "$ETC_DIR/fqrh.env"
fi
chmod 640 "$ETC_DIR/fqrh.env"
# Node 22 的 node:sqlite 需要实验开关；Node 24 不需要
if [ "$NODE_MAJOR" -eq 22 ] && ! grep -q '^NODE_OPTIONS=' "$ETC_DIR/fqrh.env"; then
  printf '\nNODE_OPTIONS=--experimental-sqlite\n' >> "$ETC_DIR/fqrh.env"
fi
chown -R root:"$SVC_USER" "$ETC_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR" "$APP_DIR"

echo "[4/6] 安装 systemd 单元"
sed "s#__NODE_BIN__#$NODE_BIN#g" "$APP_DIR/deploy/systemd/fqrh.service" > "/etc/systemd/system/$SVC_NAME.service"
chmod 644 "/etc/systemd/system/$SVC_NAME.service"
systemctl daemon-reload

echo "[5/6] 启动服务"
systemctl enable "$SVC_NAME" >/dev/null
systemctl restart "$SVC_NAME"
sleep 1
systemctl --no-pager --lines=15 status "$SVC_NAME" || true

echo "[6/6] 自检"
PORT=$("$NODE_BIN" -e "try{const c=require('$ETC_DIR/config.json');process.stdout.write(String((c.listen&&c.listen.port)||8790))}catch{process.stdout.write('8790')}" 2>/dev/null || echo 8790)
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "  healthz OK：http://127.0.0.1:$PORT/healthz"
  else
    echo "  healthz 未通过：journalctl -u $SVC_NAME -n 50 看原因（常见：配置未填 / 端口被占）"
  fi
fi
IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -5 || true)
cat <<EOF

部署完成。
  配置    $DATA_DIR/config.json  （chmod 640 $SVC_USER，面板可写）
  密钥    $ETC_DIR/fqrh.env 或 $ETC_DIR/keys/（config 里用 env 或 file 字段引用）
  数据    $DATA_DIR/data/fqrh.db
  日志    journalctl -u $SVC_NAME -f
  重启    systemctl restart $SVC_NAME
  停止    systemctl stop $SVC_NAME
  局域网  $(for ip in $IPS; do echo -n "http://$ip:$PORT/v1  "; done)

防火墙：
  ufw:            ufw allow $PORT/tcp
  firewalld:      firewall-cmd --add-port=$PORT/tcp --permanent && firewall-cmd --reload
  nftables/iptables: 放行 tcp $PORT

下一步：浏览器打开面板「中转站管理」添加官方提供商，或编辑 $DATA_DIR/config.json 后 systemctl restart $SVC_NAME
EOF
