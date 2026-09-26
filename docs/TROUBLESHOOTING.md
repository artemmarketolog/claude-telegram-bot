# 🛠 Если что-то не работает

Сначала всегда:

```bash
cd ~/claude-telegram-bot
npm run doctor
```

Doctor проверяет Node.js, `.env`, ffmpeg, Claude Code и вход по подписке (делает один короткий запрос), связь с Telegram, Threaded Mode, чат владельца, большие файлы, голосовые и проекты. Каждая ❌ пишет, что сделать. Потом смотри лог:

- Linux: `journalctl --user -u claude-telegram -n 50 --no-pager`
- macOS: `tail -n 50 ~/Library/Logs/claude-telegram/bot.log`

## Бот молчит

| Признак | Причина и решение |
| --- | --- |
| `❌ Чат владельца` | Ты не нажал **Start** в своём боте, или `TELEGRAM_OWNER_ID` не твой. ID смотри в [@userinfobot](https://t.me/userinfobot). |
| В логе `401` / `Unauthorized` | Неверный или перевыпущенный токен. Возьми актуальный в @BotFather и обнови `.env`. |
| В логе `409` / `Conflict` | Этого бота опрашивает второй процесс: запущен и сервис, и `npm start`, или бот работает на другой машине. Оставь один. |
| В логе «Бот работает только по подписке Claude: убери …» | В `.env` или окружении есть `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` или `CLAUDE_CODE_OAUTH_TOKEN`. Удали и перезапусти. |
| Сервис не `active` | `systemctl --user status claude-telegram` покажет ошибку запуска. После правки `.env` — `systemctl --user restart claude-telegram`. |

## «Включи темы для бота» / `the chat is not a forum`

Не включён Threaded Mode. Он включается **только в мини-приложении BotFather**: [@BotFather](https://t.me/BotFather) → кнопка **Open** → **My bots** → бот → **Bot Settings** → **Threads Settings** → **Threaded Mode**. Командами в чате BotFather этого не сделать. После включения перезапуск не нужен, просто напиши боту снова.

## Claude

| Признак | Что делать |
| --- | --- |
| `❌ Claude Code` | Не установлен: `curl -fsSL https://claude.ai/install.sh | bash`. Если установлен не в `PATH`, укажи путь в `CLAUDE_BIN` в `.env`. |
| `❌ Вход в Claude` | `claude auth login` в своём терминале, войди аккаунтом с подпиской Pro или Max. Вход через Console (API) не подходит: `claude auth logout`, затем `claude auth login --claudeai`. |
| Карточка: «Claude запустился не по подписке — остановлен» | CLI нашёл API-ключ или токен вместо входа по подписке. Проверь `claude auth status` и убери `apiKeyHelper` из `~/.claude/settings.json`, если он там есть. |
| `❌ Claude отвечает` | Вход устарел или кончились лимиты подписки: запусти `claude` в терминале, отправь любое сообщение и посмотри, что он скажет. |
| Сообщение получило `✍` и ждёт | Эта сессия сейчас работает в приложении Claude или терминале. Сообщение уйдёт, как только там закончится ход. Остановить работу на компьютере: `/stop` в этой теме. |
| Приложение Claude пишет «Session was interrupted» | Бот продолжил сессию из Telegram и остановил её простаивающий процесс в приложении. Переоткрой чат в приложении — там будут и ходы из Telegram. |
| Долго нет ответа | Смотри карточку хода: там текущее действие и время. `/stop` останавливает ход, следующий запрос продолжит ту же сессию. |

## Голосовые

| Сообщение под голосовым | Что делать |
| --- | --- |
| «Расшифровка голосовых не настроена» | Добавь `OPENAI_API_KEY` или поставь локальную модель ([VOICE.md](VOICE.md)). |
| «Сервис распознавания отклонил ключ OpenAI» | Ключ неверный или удалён: создай новый на [platform.openai.com/api-keys](https://platform.openai.com/api-keys). |
| «Сервис распознавания вернул ошибку 429» | Закончился баланс API OpenAI или превышен лимит: пополни [Billing](https://platform.openai.com/settings/organization/billing/overview). |
| «Не удалось запустить ffmpeg» | Поставь ffmpeg: `sudo apt-get install -y ffmpeg` или `brew install ffmpeg`, перезапусти бота. |
| «Локальная модель речи не найдена» | Неверный `LOCAL_STT_CLI` в `.env`: запусти `bash scripts/install-local-stt.sh` ещё раз. |

## Файлы

| Признак | Причина |
| --- | --- |
| «Файл больше 20 МБ…» | Облачный Bot API не отдаёт ботам файлы больше 20 МБ. Поставь свой [Local Bot API](LOCAL-BOT-API.md): `bash scripts/install-local-bot-api.sh`. |
| После установки Local Bot API бот замолчал | Кто-то обратился с токеном к `api.telegram.org` (даже `getMe`), и бот вернулся в облако. Останови бота, один раз выполни облачный `logOut` ([LOCAL-BOT-API.md](LOCAL-BOT-API.md#️-главное-правило-после-переезда)) и запусти снова. Проверь, что сервис `telegram-bot-api` работает: `systemctl --user status telegram-bot-api`. |
| «файл … больше 50 МБ — облачный Telegram Bot API не отправит его» | Лимит отправки для ботов в облаке 50 МБ. Файл остался на машине по указанному пути. |
| Claude сделал файл, а он не пришёл | Бот отправляет файлы, на которые Claude дал ссылку с **абсолютным путём** в финальном ответе. Попроси: «пришли файл ссылкой». Файлы с секретами бот не отправляет намеренно. |

## Полная переустановка без потери сессий

Сессии Claude хранятся в `~/.claude`, переустановка бота их не трогает.

```bash
bash scripts/install-service.sh --uninstall
cd ~ && rm -rf ~/claude-telegram-bot          # .env удалится: сохрани токен заранее
git clone https://github.com/artemmarketolog/claude-telegram-bot.git ~/claude-telegram-bot
```

Дальше по [INSTALL.md](../INSTALL.md). База бота (`~/.claude-telegram`) хранит привязку тем к сессиям; если удалить и её, старые темы перестанут быть связаны с сессиями, но сами сессии откроются через `/sessions`.

## Обновление бота

```bash
cd ~/claude-telegram-bot
git pull
npm install
npm test
systemctl --user restart claude-telegram      # macOS: launchctl kickstart -k gui/$(id -u)/local.claude-telegram
```

Перезапуск прерывает ходы, идущие в боте. Ответ, который Claude уже успел записать, бот доставит после старта.
