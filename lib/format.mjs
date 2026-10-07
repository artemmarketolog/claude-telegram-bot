import { homedir } from 'node:os';
import { basename } from 'node:path';

// Pure presentation helpers for the status card (contract: docs/ux.md).

export function shortModel(model = '') {
  const name = String(model).replace(/\[1m\]$/i, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const match = name.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
  return match ? `${match[1]}-${match[2]}${match[3] ? `.${match[3]}` : ''}` : name || '—';
}

export function tokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(n % 1e6 ? 2 : 0))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function duration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function age(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}ч` : `${Math.floor(hours / 24)}д`;
}

const cut = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function actionLabel(tool, input = {}) {
  const file = input.file_path || input.notebook_path || input.path;
  switch (tool) {
    case 'Bash': return `Bash: ${cut(String(input.command ?? '').split('\n')[0], 40)}`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return `Edit: ${cut(file ? basename(file) : '', 40)}`;
    case 'Read': return `Read: ${cut(file ? basename(file) : '', 40)}`;
    case 'Grep': case 'Glob': return `${tool}: ${cut(input.pattern, 36)}`;
    case 'WebSearch': return `Web: ${cut(input.query, 40)}`;
    case 'WebFetch': try { return `Web: ${new URL(input.url).hostname}`; } catch { return 'Web'; }
    case 'Agent': case 'Task': return `Agent: ${cut(input.description || input.subagent_type, 36)}`;
    case 'Skill': return `Skill: ${cut(input.skill || input.command, 36)}`;
    case 'TodoWrite': return 'план';
    case 'AskUserQuestion': return 'вопрос';
    default: {
      const mcp = String(tool).match(/^mcp__(.+?)__(.+)$/);
      return mcp ? `MCP: ${cut(`${mcp[1].replace(/^plugin_[^_]+_/, '')}.${mcp[2]}`, 40)}` : cut(tool, 40);
    }
  }
}

export function limitsLine(limits) {
  const parts = [];
  if (Number.isFinite(limits?.fiveHour)) parts.push(`5ч ${Math.round(limits.fiveHour * 100)}%`);
  if (Number.isFinite(limits?.sevenDay)) parts.push(`7д ${Math.round(limits.sevenDay * 100)}%`);
  return parts.length ? `лимит ${parts.join(' · ')}` : '';
}

function contextLine(usage) {
  if (!usage?.max) return '';
  const pct = Math.min(100, Math.round(usage.total / usage.max * 100));
  return `контекст ${pct}% · ${tokens(usage.total)}/${tokens(usage.max)}`;
}

export function backgroundLine(chat, now = Date.now()) {
  const items = Object.values(chat.background ?? {});
  if (!items.length) return '';
  const item = b => `${cut(b.name, 30)} ${duration(now - b.startedAt)}${b.total ? ` · агенты ${b.done ?? 0}/${b.total}` : ''}`;
  return `фон: ${items.slice(-3).map(item).join(' · ')}${items.length > 3 ? ` · +${items.length - 3}` : ''}`;
}

// Monospace card while a turn runs; one line once it is over.
// ⤷ marks a turn that started by itself (a background task finished), not from a message.
export function cardText(chat, { now = Date.now(), limits, queued = 0 } = {}) {
  const model = `${shortModel(chat.model)}${chat.effort ? ` · ${chat.effort}` : ''}`;
  if (chat.status === 'active' || chat.status === 'desktop') {
    const lines = [`${chat.status === 'desktop' ? '💻 ' : '▶ '}${chat.trigger ? '⤷ ' : ''}${duration(now - (chat.turnStartedAt ?? now))} · ${model}`];
    if (chat.trigger) lines.push(chat.trigger);
    const context = contextLine(chat.usage);
    if (context) lines.push(context);
    const since = chat.actionSince ? ` · ${duration(now - chat.actionSince)}` : '';
    lines.push(`${chat.action || 'думаю'}${chat.action && !['думаю', 'пишу ответ'].includes(chat.action) ? since : ''}`);
    const agents = Object.values(chat.agents ?? {});
    if (agents.length) {
      const shown = agents.slice(-3).map(a => `${cut(a.name, 14)} ${a.status === 'running' ? duration(now - a.startedAt) : a.status === 'completed' ? '✓' : '✗'}`);
      lines.push(`агенты ${agents.filter(a => a.status === 'running').length}/${agents.length}: ${shown.join(' · ')}`);
    }
    const background = backgroundLine(chat, now);
    if (background) lines.push(background);
    if (chat.question) lines.push('❓ жду ответа');
    if (queued) lines.push(`очередь ${queued}`);
    const limit = limitsLine(limits);
    if (limit) lines.push(limit);
    return lines.join('\n');
  }
  return finalLine(chat, limits);
}

export function finalLine(chat, limits) {
  const time = duration(chat.turnMs ?? 0);
  const running = Object.keys(chat.background ?? {}).length;
  const background = running ? ` · фон ${running}` : '';
  const prefix = `${chat.source === 'desktop' ? '💻 ' : ''}${chat.trigger ? '⤷ ' : ''}`;
  if (chat.outcome === 'stopped') return `${prefix}■ остановлено · ${time}${background}`;
  if (chat.outcome === 'error') return `${prefix}✗ ${cut(chat.error || 'ошибка', 120)}`;
  const context = chat.usage?.max ? ` · ctx ${Math.min(100, Math.round(chat.usage.total / chat.usage.max * 100))}%` : '';
  const five = Number.isFinite(limits?.fiveHour) ? ` · 5ч ${Math.round(limits.fiveHour * 100)}%` : '';
  return `${prefix}✓ ${time} · ${shortModel(chat.model)}${chat.effort ? ` · ${chat.effort}` : ''}${context}${five}${background}`;
}

// Title first, project last: the topic list shows the start of a name, and the icon already names the project.
export function topicName(project, title) {
  const name = `${titleFrom(title)} · ${project}`;
  return Array.from(name).slice(0, 128).join('');
}

// First message → a short title, cut at a word boundary.
export function titleFrom(text) {
  const clean = String(text ?? '').replace(/[`*_#>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 45) return clean || 'Новый чат';
  const head = clean.slice(0, 44);
  const space = head.lastIndexOf(' ');
  return `${(space >= 20 ? head.slice(0, space) : head).replace(/[\s,.;:!?—-]+$/, '')}…`;
}

// Topic icon per project: a meaningful emoji by keyword, otherwise a stable pick from a neutral
// set. Emoji must exist in getForumTopicIconStickers; callers map emoji → custom_emoji_id.
const ICON_RULES = [
  [/workspace/, '💼'], [/infra|server|vps|deploy/, '⚡️'], [/ads|meta|marketing|seo/, '📈'],
  [/telegram|bot|agent/, '🤖'], [/school|course|lesson/, '🎓'], [/clinic|health/, '🩺'],
  [/food|cafe|restaurant/, '🍽'], [/game/, '🎮'], [/task|planner|todo/, '📝'], [/home/, '🏠'],
  [/crm|finance|invoice|money/, '💰'], [/whisper|voice|audio/, '🎙'],
  [/research/, '🔮'], [/design|carousel|brand/, '🎨'], [/video|reels|creative/, '🎬'],
];
const ICON_FALLBACK = ['💡', '📁', '🔎', '📚', '💎', '🧠', '🔭', '🧪', '📰', '🗣', '✍️', '🔥'];

// Pass the project label and/or its path; the home directory prefix is ignored.
export function topicIcon(project = '') {
  const key = String(project).toLowerCase().replaceAll(`${homedir().toLowerCase()}/`, '');
  for (const [pattern, emoji] of ICON_RULES) if (pattern.test(key)) return emoji;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ICON_FALLBACK[hash % ICON_FALLBACK.length];
}
