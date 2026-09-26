# Claude Telegram Bot — notes for AI agents

- **Installing for a user?** Follow the «Для ИИ-агента» section of [INSTALL.md](INSTALL.md) step by step and verify each step with a command. Finish only when `npm run doctor` shows no ❌ and the user got an answer in Telegram.
- **Subscription only.** Claude runs through the official CLI with the owner's `claude auth login` (Pro/Max). Never add `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper` or `claude setup-token`: the bot refuses them by design.
- Never print, echo or commit secret values (`.env`, bot token, OpenAI key, `~/.claude/.credentials.json`, my.telegram.org api_hash).
- Threaded Mode can be switched on only in the BotFather mini app (Open → My bots → bot → Bot Settings → Threads Settings); there is no command for it. Ask the user to do it.
- After `scripts/install-local-bot-api.sh` never call `api.telegram.org` with the bot token (not even `getMe`): the bot drops out of its own server.
- Run exactly one bot process per token (a service or `npm start`, not both). Do not edit transcripts in `~/.claude/projects` or the CLI registry `~/.claude/sessions`.

## Development

- Node.js 22.13+, ESM, no build step. Tests: `npm test` (node:test with fake Claude and Telegram; real `ffmpeg` is required).
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Keep the concurrency rules of `lib/gateway.mjs`: one worker, event chain and download per chat; buttons and commands never run inside the poller; turn lock for dispatch/finish/queue/closing a runner; card lock for every card edit; lock order turn → mirror → card. After touching them run `LOAD_SEEDS=80 npm test`.
- User-facing text is Russian.
