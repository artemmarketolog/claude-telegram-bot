#!/usr/bin/env bash
# Own Telegram Bot API server on this machine: files of any size from Telegram (the cloud gives bots
# 20 MB) and up to 2000 MB back (the cloud takes 50 MB). Builds the official tdlib/telegram-bot-api,
# runs it on 127.0.0.1 only, moves the bot to it once (cloud logOut) and restarts the bot.
#
# Before running put the Telegram application keys from https://my.telegram.org → API development tools
# into .env as TELEGRAM_API_ID=... and TELEGRAM_API_HASH=... — the script moves them to a private file.
# Usage: bash scripts/install-local-bot-api.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOT_SERVICE="$(node -e 'console.log(require(process.argv[1]).name.replace(/-bot$/, ""))' "$ROOT/package.json")"
PORT="${LOCAL_BOT_API_PORT:-8081}"
PREFIX="${LOCAL_BOT_API_HOME:-$HOME/.local/share/telegram-bot-api}"
CLOUD="${TELEGRAM_CLOUD_API:-https://api.telegram.org}"
LOCAL="http://127.0.0.1:$PORT"
ENV_FILE="$ROOT/.env"
KEYS="$PREFIX/api.env"
OS="$(uname -s)"

get() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
set_env() {
  { grep -vE "^$1=" "$ENV_FILE" || true; echo "$1=$2"; } > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}
# The token goes to curl through stdin, not the command line (visible to other users in `ps`).
call() { curl -s -K - <<<"url = \"$1/bot$TOKEN/$2\"" || true; }
drop_env() { { grep -vE "^$1=" "$ENV_FILE" || true; } > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"; }

[[ -f "$ENV_FILE" ]] || { echo "Нет $ENV_FILE: сначала настрой бота (INSTALL.md)." >&2; exit 1; }
TOKEN="$(get TELEGRAM_BOT_TOKEN "$ENV_FILE")"
[[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "В .env нет корректного TELEGRAM_BOT_TOKEN." >&2; exit 1; }
mkdir -p "$PREFIX/bin" "$PREFIX/data" "$PREFIX/temp"
chmod 700 "$PREFIX"

# 1. Application keys: from .env into a private file of the server (not the bot's environment).
API_ID="$(get TELEGRAM_API_ID "$ENV_FILE")"
API_HASH="$(get TELEGRAM_API_HASH "$ENV_FILE")"
if [[ -n "$API_ID" && -n "$API_HASH" ]]; then
  [[ "$API_ID" =~ ^[0-9]+$ && "$API_HASH" =~ ^[0-9a-f]{32}$ ]] || { echo "TELEGRAM_API_ID — число, TELEGRAM_API_HASH — 32 символа 0-9a-f. Проверь .env." >&2; exit 1; }
  umask 077
  printf 'TELEGRAM_API_ID=%s\nTELEGRAM_API_HASH=%s\n' "$API_ID" "$API_HASH" > "$KEYS"
  chmod 600 "$KEYS"
  drop_env TELEGRAM_API_ID
  drop_env TELEGRAM_API_HASH
fi
[[ -s "$KEYS" ]] || { echo "Нужны ключи приложения: my.telegram.org → API development tools. Впиши в .env TELEGRAM_API_ID и TELEGRAM_API_HASH и запусти снова." >&2; exit 1; }

# 2. Build the official server once (20–60 minutes, the longest step).
BIN="$PREFIX/bin/telegram-bot-api"
if [[ ! -x "$BIN" ]]; then
  if [[ "$OS" == "Darwin" ]]; then
    command -v brew >/dev/null || { echo "Нужен Homebrew: https://brew.sh" >&2; exit 1; }
    brew install gperf cmake openssl@3 >/dev/null
    EXTRA=(-DOPENSSL_ROOT_DIR="$(brew --prefix openssl@3)")
  else
    for tool in git cmake g++ make gperf; do
      command -v "$tool" >/dev/null || { echo "Не найден $tool. Ubuntu/Debian: sudo apt-get install -y make git zlib1g-dev libssl-dev gperf cmake g++" >&2; exit 1; }
    done
    [[ -f /usr/include/openssl/ssl.h && -f /usr/include/zlib.h ]] || { echo "Нужны libssl-dev и zlib1g-dev: sudo apt-get install -y libssl-dev zlib1g-dev" >&2; exit 1; }
    EXTRA=()
    MEM_KB="$(awk '/MemTotal|SwapTotal/ {s+=$2} END {print s}' /proc/meminfo)"
    if (( MEM_KB < 3500000 )); then
      echo "⚠️  Для сборки нужно ~4 ГБ памяти (RAM + swap), сейчас $((MEM_KB / 1024)) МБ. Добавь swap:"
      echo "    sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
      exit 1
    fi
  fi
  SRC="$PREFIX/src"
  [[ -d "$SRC/.git" ]] || git clone --recursive --depth 1 --shallow-submodules https://github.com/tdlib/telegram-bot-api.git "$SRC"
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release "${EXTRA[@]}"
  # Each compiler job of this project needs up to ~2.5 GB of memory: as many jobs as memory allows.
  CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  if [[ "$OS" == "Darwin" ]]; then MEM_GB="$(( $(sysctl -n hw.memsize) / 1073741824 ))"; else MEM_GB="$(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1048576 ))"; fi
  JOBS="$(( MEM_GB * 2 / 5 ))"; (( JOBS > CPUS )) && JOBS="$CPUS"; (( JOBS < 1 )) && JOBS=1
  echo "Собираю telegram-bot-api (потоков: $JOBS), это 20–60 минут…"
  nice cmake --build "$SRC/build" --target telegram-bot-api -j "$JOBS"
  install -m 0755 "$SRC/build/telegram-bot-api" "$BIN"
fi

# 3. Run it on localhost only, as this user (the bot reads downloaded files straight from its folder).
# --verbosity=0: its debug logs can contain the bot token.
ARGS=(--local --http-ip-address=127.0.0.1 "--http-port=$PORT" "--dir=$PREFIX/data" "--temp-dir=$PREFIX/temp" --verbosity=0)
if [[ "$OS" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/local.telegram-bot-api.plist"
  set -a; . "$KEYS"; set +a
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict><key>Label</key><string>local.telegram-bot-api</string><key>ProgramArguments</key><array>'
    echo "<string>$BIN</string>"; for arg in "${ARGS[@]}"; do echo "<string>$arg</string>"; done
    echo '</array><key>EnvironmentVariables</key><dict>'
    echo "<key>TELEGRAM_API_ID</key><string>$TELEGRAM_API_ID</string><key>TELEGRAM_API_HASH</key><string>$TELEGRAM_API_HASH</string>"
    echo '</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>'
  } > "$PLIST"
  chmod 600 "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 || {
    echo "Сервер собран ($BIN), но на этой машине нет systemd для автозапуска (WSL без systemd, контейнер)." >&2
    echo "WSL: включи systemd (/etc/wsl.conf: [boot] systemd=true, затем wsl --shutdown) и запусти скрипт снова." >&2
    exit 1; }
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/telegram-bot-api.service" <<EOF
[Unit]
Description=Local Telegram Bot API (127.0.0.1:$PORT)
After=network-online.target

[Service]
EnvironmentFile=$KEYS
ExecStart="$BIN" ${ARGS[*]}
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable telegram-bot-api.service >/dev/null
  systemctl --user restart telegram-bot-api.service
fi
for _ in $(seq 1 30); do
  curl -s -o /dev/null "$LOCAL/" && break
  sleep 1
done
curl -s "$LOCAL/" | grep -q '"ok":false' || { echo "Local Bot API не отвечает на $LOCAL." >&2; exit 1; }
echo "✅ Local Bot API работает на $LOCAL"

# 4. Move the bot: one cloud logOut, then every request goes to the local server only.
CURRENT="$(get TELEGRAM_API_BASE "$ENV_FILE")"
if [[ "$CURRENT" != "$LOCAL" ]]; then
  if [[ "$OS" == "Darwin" ]]; then launchctl bootout "gui/$(id -u)/local.$BOT_SERVICE" 2>/dev/null || true
  else systemctl --user stop "$BOT_SERVICE.service" 2>/dev/null || true; fi
  REPLY="$(call "$CLOUD" logOut)"
  if ! grep -q '"ok":true' <<<"$REPLY" && ! grep -qi 'logged out' <<<"$REPLY"; then
    echo "Облачный logOut не прошёл: $(sed "s/$TOKEN/[token]/g" <<<"$REPLY")" >&2
    exit 1
  fi
  set_env TELEGRAM_API_BASE "$LOCAL"
  echo "✅ Бот переведён на свой Local Bot API (облачный logOut выполнен)"
fi
ME="$(call "$LOCAL" getMe)"
if ! grep -q '"ok":true' <<<"$ME"; then
  echo "Local Bot API не принял бота: $(sed "s/$TOKEN/[token]/g" <<<"$ME")" >&2
  echo "Проверь TELEGRAM_BOT_TOKEN и ключи my.telegram.org: впиши TELEGRAM_API_ID и TELEGRAM_API_HASH в .env заново и запусти скрипт ещё раз (облачный logOut повторно не выполнится). Вернуться в облако — docs/LOCAL-BOT-API.md." >&2
  exit 1
fi

# 5. Start the bot again if autostart is installed.
if [[ "$OS" == "Darwin" ]]; then
  PLIST_BOT="$HOME/Library/LaunchAgents/local.$BOT_SERVICE.plist"
  [[ -f "$PLIST_BOT" ]] && launchctl bootstrap "gui/$(id -u)" "$PLIST_BOT" 2>/dev/null || true
elif [[ -f "$HOME/.config/systemd/user/$BOT_SERVICE.service" ]]; then
  systemctl --user restart "$BOT_SERVICE.service"
fi
echo "Готово: файлы до 2000 МБ в обе стороны."
echo "Важно: больше не обращайся с этим токеном к api.telegram.org (даже getMe) — бот выпадет из своего сервера."
