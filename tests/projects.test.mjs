import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjects } from '../lib/projects.mjs';

test('projects come from projects.json; missing folders are skipped; without a list the home folder is used', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-projects-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'site'));
  const config = join(dir, 'projects.json');
  await writeFile(config, JSON.stringify([{ label: 'Сайт', path: join(dir, 'site') }, { label: 'Нет', path: join(dir, 'missing') }, { path: 'relative' }]));
  const projects = readProjects(config, { home: dir, defaultPath: dir });
  assert.deepEqual(projects.map(p => [p.label, p.path]), [['Сайт', join(dir, 'site')], ['home', dir]]);
  assert.equal(new Set(projects.map(p => p.key)).size, 2);
  assert.deepEqual(readProjects(join(dir, 'absent.json'), { home: dir }).map(p => p.path), [dir]);
  await writeFile(config, '{"label":"not a list"}');
  assert.throws(() => readProjects(config, { home: dir }), /ожидается массив/);
});
