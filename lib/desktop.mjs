import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BOT_MARKER } from './claude.mjs';

// Read-only view of Claude Code sessions on this host: transcripts under ~/.claude/projects
// and the CLI's own live-process registry ~/.claude/sessions/<pid>.json. The registry and
// transcript formats are internal to Claude Code; everything here degrades to "unknown".

const HOME = homedir();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readSlice(path, start, length) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  return lines.flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
}

// Pasted blocks arrive wrapped in <pasted_content id="…"> tags; keep only the text.
const unwrap = text => text.replace(/<\/?pasted_content[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();

export function userPrompt(record) {
  if (record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary) return null;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some(c => c.type === 'tool_result')) return null;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
  const images = Array.isArray(content) ? content.filter(c => c.type === 'image').length : 0;
  if (/^\s*<(command-|local-command|system-reminder|task-notification)/.test(text) || /^\s*\[SYSTEM NOTIFICATION/.test(text)) return null;
  const clean = unwrap(text);
  if (!clean && !images) return null;
  return `${images ? `${'🖼 '.repeat(Math.min(images, 3))}` : ''}${clean}`.trim();
}

// A finished background task (agent, shell, workflow) that the CLI queues back into the session.
export function taskNotification(record) {
  const text = record.type === 'attachment' && record.attachment?.type === 'queued_command' ? String(record.attachment.prompt ?? '') : '';
  if (!text.startsWith('<task-notification>')) return null;
  const field = name => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
  return { toolUseId: field('tool-use-id'), taskId: field('task-id'), status: field('status'), summary: field('summary') };
}

export function assistantText(record) {
  if (record.type !== 'assistant' || record.isSidechain) return null;
  return (record.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || null;
}

export class Desktop {
  constructor({ root = join(HOME, '.claude'), days = 30 } = {}) {
    this.projectsDir = join(root, 'projects');
    this.registryDir = join(root, 'sessions');
    this.days = days;
    this.meta = new Map();
    this.paths = new Map();
  }

  // Transcript metadata, cached by (size, mtime).
  async info(path) {
    const s = await stat(path);
    const cached = this.meta.get(path);
    if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs) return cached;
    const head = parseLines(await readSlice(path, 0, Math.min(s.size, 64 * 1024)), { dropLast: s.size > 64 * 1024 });
    const tailStart = Math.max(0, s.size - 256 * 1024);
    const tail = tailStart ? parseLines(await readSlice(path, tailStart, s.size - tailStart), { dropFirst: true }) : head;
    const first = head.find(r => r.sessionId && r.cwd) ?? tail.find(r => r.sessionId && r.cwd);
    let title = null; let aiTitle = null; let prompt = null; let lastActivity = 0;
    for (const record of tail) {
      if ((record.type === 'user' || record.type === 'assistant') && !record.isSidechain) lastActivity = Math.max(lastActivity, Date.parse(record.timestamp) || 0);
    }
    for (const record of [...head, ...tail]) {
      if (record.type === 'custom-title' && record.customTitle) title = record.customTitle;
      if (record.type === 'ai-title' && record.aiTitle) aiTitle = record.aiTitle;
      if (record.type === 'last-prompt' && record.lastPrompt) prompt = record.lastPrompt;
    }
    const value = { path, size: s.size, mtimeMs: s.mtimeMs, sessionId: first?.sessionId,
      cwd: first?.cwd, entrypoint: first?.entrypoint ?? null, title: title || aiTitle || prompt?.slice(0, 60) || null,
      created: Date.parse(first?.timestamp) || s.mtimeMs,
      // Conversation time, not file mtime: a process writes to its transcript on exit/archive too.
      lastActivity: lastActivity || s.mtimeMs };
    this.meta.set(path, value);
    if (value.sessionId) this.paths.set(value.sessionId, path);
    return value;
  }

  async list({ limit = 40 } = {}) {
    const since = Date.now() - this.days * 86400000;
    const files = [];
    for (const dir of await readdir(this.projectsDir).catch(() => [])) {
      if (dir.startsWith('-tmp-')) continue;
      for (const name of await readdir(join(this.projectsDir, dir)).catch(() => [])) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(this.projectsDir, dir, name);
        const s = await stat(path).catch(() => null);
        if (s?.isFile() && s.mtimeMs >= since && s.size > 0) files.push({ path, mtimeMs: s.mtimeMs });
      }
    }
    const sessions = [];
    for (const file of files) {
      const info = await this.info(file.path).catch(() => null);
      if (info?.sessionId && info.cwd && ['claude-desktop', 'cli', 'sdk-ts'].includes(info.entrypoint)) sessions.push(info);
    }
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit);
  }

  async pathFor(sessionId) {
    if (this.paths.has(sessionId)) return this.paths.get(sessionId);
    for (const dir of await readdir(this.projectsDir).catch(() => [])) {
      const path = join(this.projectsDir, dir, `${sessionId}.jsonl`);
      if (await stat(path).then(s => s.isFile(), () => false)) { this.paths.set(sessionId, path); return path; }
    }
    return null;
  }

  // Live processes from the CLI registry; a record is trusted only when /proc confirms the
  // same process (pid + start time), because stale files of dead pids stay in the directory.
  async live() {
    const result = [];
    for (const name of await readdir(this.registryDir).catch(() => [])) {
      if (!/^\d+\.json$/.test(name)) continue;
      let record;
      try { record = JSON.parse(await readFile(join(this.registryDir, name), 'utf8')); } catch { continue; }
      const pid = Number(record.pid);
      const statLine = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
      if (!statLine) continue;
      const fields = statLine.slice(statLine.lastIndexOf(')') + 2).split(' ');
      if (String(record.procStart) !== fields[19]) continue;
      const environ = await readFile(`/proc/${pid}/environ`).catch(() => Buffer.alloc(0));
      result.push({ pid, sessionId: record.sessionId, status: record.status ?? null, entrypoint: record.entrypoint,
        hostSessionId: record.hostSessionId ?? null, startedAt: record.startedAt, statusUpdatedAt: record.statusUpdatedAt,
        procStart: String(record.procStart), ours: environ.includes(Buffer.from(`${BOT_MARKER}=1`)) });
    }
    return result;
  }

  async foreign(sessionId) {
    return (await this.live()).find(p => p.sessionId === sessionId && !p.ours) ?? null;
  }

  // SIGTERM one verified idle process and wait for it to exit. Transcript stays intact.
  async terminate(proc, timeoutMs = 15000) {
    const again = (await this.live()).find(p => p.pid === proc.pid && p.procStart === proc.procStart);
    if (!again) return true;
    if (again.status != null && again.status !== 'idle') return false;
    try { process.kill(proc.pid, 'SIGTERM'); } catch { return true; }
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await delay(250)) {
      const statLine = await readFile(`/proc/${proc.pid}/stat`, 'utf8').catch(() => null);
      if (!statLine || statLine.slice(statLine.lastIndexOf(')') + 2).split(' ')[19] !== proc.procStart) return true;
    }
    return false;
  }

  // New complete records appended after `offset`.
  async read(path, offset) {
    const s = await stat(path);
    const WINDOW = 8 * 1024 * 1024;
    // A rewritten (shorter) file restarts from its end, so old prompts are not mirrored again.
    if (s.size < offset) return { records: [], offset: s.size };
    if (s.size === offset) return { records: [], offset };
    const text = await readSlice(path, offset, Math.min(s.size - offset, WINDOW));
    const end = text.lastIndexOf('\n');
    // A single record longer than the window is skipped instead of being re-read forever.
    if (end < 0) return { records: [], offset: s.size - offset >= WINDOW ? offset + WINDOW : offset };
    return { records: parseLines(text.slice(0, end)), offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  }

  async size(path) { return (await stat(path)).size; }

  async lastAnswer(sessionId) {
    const path = await this.pathFor(sessionId);
    if (!path) return null;
    const s = await stat(path);
    const start = Math.max(0, s.size - 2 * 1024 * 1024);
    const records = parseLines(await readSlice(path, start, s.size - start), { dropFirst: start > 0 });
    for (let i = records.length - 1; i >= 0; i--) {
      const text = assistantText(records[i]);
      if (text && records[i].message?.stop_reason === 'end_turn') return text;
    }
    return null;
  }
}
