import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { attachmentFromMessage, incomingDownloadBudget, prepareMedia, safeFilename, transcribeAudio } from '../lib/media.mjs';

const exec = promisify(execFile);
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'codex-media-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('filenames cannot traverse directories and stay inside filesystem limits', () => {
  assert.equal(safeFilename('../../secret.zip'), 'secret.zip');
  assert.equal(safeFilename('C:\\folder\\file.png'), 'file.png');
  assert.equal(safeFilename('\u202ehidden\n.zip'), 'hidden.zip');
  const long = safeFilename('Я'.repeat(300) + '.zip');
  assert.ok(Buffer.byteLength(long) <= 160);
  assert.ok(long.endsWith('.zip'));
});

test('attachment selection takes the largest photo and accepts arbitrary documents', () => {
  assert.equal(attachmentFromMessage({ photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', width: 10, height: 10 }] }).file_id, 'big');
  assert.equal(attachmentFromMessage({ document: { file_id: 'zip', file_name: 'data.zip' } }).kind, 'document');
});

test('download budget keeps a 512 MiB reserve and accounts for local cache plus copy', () => {
  const reserve = 512 * 1024 * 1024;
  assert.equal(incomingDownloadBudget(reserve + 2000, 1000), 1000);
  assert.throws(() => incomingDownloadBudget(reserve + 1999, 1000), /недостаточно/);
  assert.throws(() => incomingDownloadBudget(reserve, 1), /недостаточно/);
  assert.equal(incomingDownloadBudget(reserve + 2000), 1000);
});

test('original, manifest, caption and verified image input are preserved', async t => {
  const filesRoot = await directory(t);
  const result = await prepareMedia({ message_id: 8, caption: 'Посмотри фото', document: { file_id: 'img', file_name: '../photo.png', mime_type: 'image/png' } }, {
    filesRoot, threadId: 'thread-123', api: { download: async (id, path) => {
      await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { mode: 0o600 });
      return { size: 8, file: { file_path: 'secret_should_never_be_used' } };
    } },
  });
  assert.equal(result.inputs[1].type, 'localImage');
  assert.match(result.inputs[0].text, /Посмотри фото/);
  assert.equal(result.attachments[0].name, 'photo.png');
  assert.ok(basename(result.attachments[0].path).endsWith('__photo.png'));
  const manifest = await readFile(`${result.attachments[0].path}.json`, 'utf8');
  assert.doesNotMatch(manifest, /secret_should_never_be_used/);
  assert.equal(JSON.parse(manifest).messageId, 8);
  assert.equal((await stat(`${result.attachments[0].path}.json`)).mode & 0o777, 0o600);
});

test('a forged image MIME remains a file, and thread traversal is rejected', async t => {
  const filesRoot = await directory(t);
  const message = { document: { file_id: 'x', file_name: 'fake.png', mime_type: 'image/png' } };
  const api = { download: async (id, path) => { await writeFile(path, 'plain data'); return { size: 10 }; } };
  const result = await prepareMedia(message, { api, filesRoot, threadId: 'thread' });
  assert.equal(result.inputs.length, 1);
  await assert.rejects(prepareMedia(message, { api, filesRoot, threadId: '../outside' }), /идентификатор/);
});

test('missing transcription credentials retain the original and explain the failure', async t => {
  const filesRoot = await directory(t);
  const result = await prepareMedia({ voice: { file_id: 'voice' } }, {
    filesRoot, threadId: 'voice', openaiKey: '', localModel: '',
    api: { download: async (id, path) => { await writeFile(path, 'audio-original'); return { size: 14 }; } },
  });
  assert.match(result.warnings[0], /OPENAI_API_KEY или локальную модель/);
  assert.equal(await readFile(result.attachments[0].path, 'utf8'), 'audio-original');
});

test('real ffmpeg converts OGG and chunks audio; mocked API receives MP3 without leaking keys', async t => {
  const dir = await directory(t);
  const path = join(dir, 'voice.ogg');
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.2', '-c:a', 'libopus', path]);
  let calls = 0;
  const transcript = await transcribeAudio(path, {
    openaiKey: 'test-key-not-real', segmentSeconds: 1,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options.headers.Authorization, 'Bearer test-key-not-real');
      assert.equal(options.body.get('model'), 'gpt-4o-transcribe');
      assert.ok(options.body.get('file').size < 25_000_000);
      assert.ok(options.body.get('file').name.endsWith('.mp3'));
      if (calls > 1) assert.equal(options.body.get('prompt'), `Часть ${calls - 1}`);
      return Response.json({ text: `Часть ${calls}` });
    },
  });
  assert.ok(calls >= 2);
  assert.match(transcript, /Часть 1\n\nЧасть 2/);
  assert.deepEqual(await readdir(dir), ['voice.ogg']);
  await assert.rejects(transcribeAudio(path, {
    openaiKey: 'never-print-this', fetchImpl: async () => { throw new Error('Authorization: never-print-this'); },
  }), error => !error.message.includes('never-print-this'));
});

test('without an OpenAI key a local model transcribes a 16 kHz WAV (Parakeet or Whisper flags); OpenAI wins when both are set', async t => {
  const dir = await directory(t);
  const path = join(dir, 'voice.ogg');
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libopus', path]);
  // A stand-in for parakeet-cli / whisper-cli: records its flags, checks the WAV and writes <-of>.txt as they do.
  const cli = join(dir, 'fake-cli');
  await writeFile(cli, `#!/bin/sh
echo "$@" > "${join(dir, 'args')}"
while [ $# -gt 0 ]; do case "$1" in -f) wav=$2; shift;; -of) out=$2; shift;; esac; shift; done
head -c 4 "$wav" | grep -q RIFF || exit 3
printf 'Привет,\\nмир\\n' > "$out.txt"
`, { mode: 0o755 });
  const args = async () => (await readFile(join(dir, 'args'), 'utf8')).trim().split(' ');
  const parakeet = join(dir, 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin');
  assert.equal(await transcribeAudio(path, { openaiKey: '', localModel: parakeet, localCli: cli }), 'Привет, мир');
  const used = await args();
  assert.deepEqual([used[0], used[1]], ['-m', parakeet]);
  assert.ok(!used.includes('-l') && !used.includes('-nt') && used.includes('-otxt'));
  await transcribeAudio(path, { openaiKey: '', localModel: join(dir, 'ggml-small.bin'), localCli: cli });
  assert.deepEqual((await args()).slice((await args()).indexOf('-l'), (await args()).indexOf('-l') + 3), ['-l', 'auto', '-nt']);
  assert.deepEqual((await readdir(dir)).sort(), ['args', 'fake-cli', 'voice.ogg']);
  const viaOpenAI = await transcribeAudio(path, { openaiKey: 'test-key-not-real', localModel: parakeet, localCli: cli,
    fetchImpl: async () => Response.json({ text: 'через OpenAI' }) });
  assert.equal(viaOpenAI, 'через OpenAI');
  await assert.rejects(transcribeAudio(path, { openaiKey: '', localModel: parakeet, localCli: join(dir, 'missing-cli') }), /Локальная модель речи не найдена/);
});

test('a download over the cloud limit gets a clear explanation', async t => {
  const filesRoot = await directory(t);
  const api = { local: false, download: async () => { throw Object.assign(new Error('Telegram getFile: Bad Request: file is too big'), { code: 400 }); } };
  await assert.rejects(prepareMedia({ document: { file_id: 'big', file_name: 'big.zip' } }, { api, filesRoot, threadId: 'A' }), /больше 20 МБ/);
});
