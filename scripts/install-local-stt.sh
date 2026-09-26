#!/usr/bin/env bash
# Free, offline voice transcription (Russian + English) on this machine through whisper.cpp.
# Builds the command-line tool, downloads the model and writes LOCAL_STT_CLI / LOCAL_STT_MODEL into .env.
#
# Usage: bash scripts/install-local-stt.sh [parakeet|whisper-small|whisper-large-v3-turbo]
#   parakeet (default)      NVIDIA Parakeet TDT 0.6B v3, 25 languages incl. Russian and English; fast on CPU, ~0.7 GB
#   whisper-small           OpenAI Whisper small, ~0.5 GB; noticeably slower on CPU
#   whisper-large-v3-turbo  Whisper large v3 turbo, ~1.6 GB; best Whisper quality, slow without a GPU
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHOICE="${1:-parakeet}"
case "$CHOICE" in
  parakeet) TARGET=parakeet-cli; URL="https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q8_0.bin" ;;
  whisper-small|whisper-large-v3-turbo) TARGET=whisper-cli; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${CHOICE#whisper-}.bin" ;;
  *) echo "Вариант: parakeet, whisper-small или whisper-large-v3-turbo" >&2; exit 1 ;;
esac
PREFIX="${LOCAL_STT_HOME:-$HOME/.local/share/whisper.cpp}"
CLI="$PREFIX/bin/$TARGET"
FILE="$PREFIX/models/$(basename "$URL")"
mkdir -p "$PREFIX/bin" "$PREFIX/models"

if [[ ! -x "$CLI" ]]; then
  for tool in git cmake make; do
    command -v "$tool" >/dev/null || {
      echo "Не найден $tool. Ubuntu/Debian: sudo apt install -y git cmake g++ make; macOS: xcode-select --install && brew install cmake" >&2; exit 1; }
  done
  SRC="$PREFIX/src"
  [[ -d "$SRC/.git" ]] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
  # A static binary keeps working when the source folder is removed.
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF
  CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  cmake --build "$SRC/build" --config Release --target "$TARGET" -j "$(( CPUS > 1 ? CPUS - 1 : 1 ))"
  install -m 0755 "$SRC/build/bin/$TARGET" "$CLI"
fi
"$CLI" --help >/dev/null 2>&1 || { echo "$TARGET не запускается: $CLI" >&2; exit 1; }

if [[ ! -s "$FILE" ]]; then
  echo "Скачиваю модель $(basename "$FILE")…"
  curl -fL --retry 3 -o "$FILE.part" "$URL"
  mv "$FILE.part" "$FILE"
fi

ENV_FILE="$ROOT/.env"
touch "$ENV_FILE"
for pair in "LOCAL_STT_CLI=$CLI" "LOCAL_STT_MODEL=$FILE"; do
  key="${pair%%=*}"
  { grep -v "^$key=" "$ENV_FILE" || true; echo "$pair"; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
done
chmod 600 "$ENV_FILE"
echo "Готово: $CLI"
echo "Модель: $FILE"
echo "LOCAL_STT_CLI и LOCAL_STT_MODEL записаны в .env. Если в .env задан OPENAI_API_KEY, приоритет у OpenAI."
echo "Перезапусти бота, чтобы он подхватил настройки."
