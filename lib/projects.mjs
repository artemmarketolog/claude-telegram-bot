import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const keyOf = path => createHash('sha256').update(path).digest('hex').slice(0, 12);

// Projects are folders on this machine. `projects.json` lists them ([{ "label", "path" }]); folders of
// other Claude Code sessions appear on their own in /sessions and «сменить проект» (recent folders).
export function readProjects(configPath, { home = homedir(), defaultPath = process.env.DEFAULT_PROJECT } = {}) {
  let seeds = [];
  if (configPath && existsSync(configPath)) {
    seeds = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!Array.isArray(seeds)) throw new Error(`${configPath}: ожидается массив [{ "label": "...", "path": "/абсолютный/путь" }].`);
  }
  const projects = new Map();
  const add = (path, label) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    const clean = resolve(path);
    if (!projects.has(clean) && existsSync(clean)) projects.set(clean, { id: null, label: label || folderLabel(clean, home), path: clean, key: keyOf(clean) });
  };
  for (const seed of seeds) add(seed?.path, seed?.label);
  if (defaultPath) add(defaultPath);
  if (!projects.size) add(home);
  return [...projects.values()];
}

export function folderLabel(cwd, home = homedir()) {
  if (cwd === home) return 'home';
  return basename(cwd) || cwd;
}

// A project entry for any working directory, listed or not.
export function projectFor(projects, cwd) {
  return projects.find(p => p.path === cwd) ?? { id: null, label: folderLabel(cwd), path: cwd, key: keyOf(cwd) };
}
