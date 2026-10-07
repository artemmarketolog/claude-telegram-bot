# 🎙 Голосовые сообщения

Бот расшифровывает голосовые, аудиофайлы и кружочки и отдаёт текст Claude. В теме расшифровка видна свёрнутой цитатой, оригинал сохраняется в `~/.claude-telegram/files`. Есть два способа, выбирается автоматически:

1. задан `OPENAI_API_KEY` → OpenAI;
2. ключа нет, но задан `LOCAL_STT_MODEL` → локальная модель;
3. нет ни того ни другого → голосовое сохраняется, Claude получает путь к файлу и пометку, что расшифровка не настроена.

После изменения `.env` перезапусти бота (Linux: `systemctl --user restart claude-telegram`, macOS: `launchctl kickstart -k gui/$(id -u)/local.claude-telegram`).

## Вариант 1. OpenAI (рекомендуется)

Модель `whisper-1`: хорошо понимает русский, английский и смесь языков (`gpt-4o-transcribe` на практике выбрасывал куски фраз, поэтому не используется). Длинные записи бот режет на части по 3 минуты. Цена около **$0,006 за минуту** голоса, то есть $5 хватает примерно на 13–14 часов.

### Как получить ключ

1. Открой [platform.openai.com](https://platform.openai.com) и войди. Аккаунт может быть тот же, что в ChatGPT, но **баланс API отдельный**: подписка ChatGPT Plus его не пополняет.
2. **Пополни баланс.** Settings → [Billing](https://platform.openai.com/settings/organization/billing/overview) → **Add payment details** → привяжи карту → **Add to credit balance**, от $5. Автопополнение можно не включать.
3. **Создай ключ.** [API keys](https://platform.openai.com/api-keys) → **Create new secret key** → любое имя (например, `telegram-bot`) → **Create**. Скопируй ключ `sk-...` сразу: второй раз его не покажут.
4. Впиши в `.env`: `OPENAI_API_KEY=sk-...` и перезапусти бота.

Проверка: `npm run doctor` покажет `✅ Голосовые: OpenAI — ключ принят`. Баланс doctor не видит. Если деньги закончатся, бот напишет под голосовым, что сервис распознавания вернул ошибку, а оригинал сохранится.

## Вариант 2. Бесплатно, на своей машине

Используется [whisper.cpp](https://github.com/ggml-org/whisper.cpp): он работает на обычном процессоре, без видеокарты и без интернета. Установка одной командой из папки бота:

```bash
bash scripts/install-local-stt.sh            # Parakeet v3 (по умолчанию)
bash scripts/install-local-stt.sh whisper-small
```

Скрипт собирает нужную программу в `~/.local/share/whisper.cpp`, скачивает модель и записывает `LOCAL_STT_CLI` и `LOCAL_STT_MODEL` в `.env`. Перед этим нужны инструменты сборки: Ubuntu/Debian — `sudo apt-get install -y git cmake g++ make`, macOS — `xcode-select --install` и `brew install cmake`.

| Модель | Размер | Языки | Скорость на CPU |
| --- | --- | --- | --- |
| **Parakeet TDT 0.6B v3** (`parakeet`, по умолчанию) | ~0,7 ГБ | 25 европейских, включая русский и английский; язык определяет сама | Быстрая, рассчитана на CPU |
| Whisper small (`whisper-small`) | ~0,5 ГБ | ~100 языков | Медленнее: на 6-ядерном VPS около 30 секунд на 25 секунд речи |
| Whisper large v3 turbo (`whisper-large-v3-turbo`) | ~1,6 ГБ | ~100 языков | Лучшее качество Whisper, без видеокарты медленная |

Модель Parakeet — [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), готовый для whisper.cpp файл — из [ggml-org/parakeet-GGUF](https://huggingface.co/ggml-org/parakeet-GGUF) (квантизация `q8_0`).

Бот сам понимает, какая программа нужна: если в имени файла модели есть `parakeet`, он вызывает `parakeet-cli`, иначе `whisper-cli`. Дополнительные настройки в `.env`:

- `LOCAL_STT_THREADS` — сколько ядер отдать (по умолчанию все, кроме одного, но не больше 8);
- `LOCAL_STT_LANGUAGE` — язык для Whisper (`ru`, `en`; по умолчанию `auto`). Parakeet определяет язык сам.

Памяти нужно примерно столько, сколько весит модель, плюс ~0,5 ГБ. На VPS с 1 ГБ RAM локальная модель не поместится рядом с Claude — бери OpenAI или сервер побольше.
