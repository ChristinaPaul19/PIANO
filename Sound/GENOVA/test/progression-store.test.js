'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProgressionStore } = require('../src/main/progression-store');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genova-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'progression.json');
  return { directory, file, store: new ProgressionStore(file) };
}

test('progressions persist across store instances and replace the single slot atomically', async (t) => {
  const { directory, file, store } = await fixture(t);
  const progression = { version: 1, beatsPerBar: 4, lengthBars: 2, events: [{ beat: 0, root: 0, quality: 'major' }] };
  await store.save(progression);
  assert.deepEqual(await new ProgressionStore(file).load(), progression);
  progression.events.push({ beat: 4, root: 9, quality: 'minor' });
  await store.save(progression);
  assert.deepEqual(await store.load(), progression);
  assert.deepEqual(await fs.readdir(directory), ['progression.json']);
});

test('missing and malformed saved progressions produce actionable errors', async (t) => {
  const { store, file } = await fixture(t);
  await assert.rejects(store.load(), /No saved progression/);
  await fs.writeFile(file, '{invalid');
  await assert.rejects(store.load(), /not valid JSON/);
});

test('oversized reads and writes are bounded without destroying existing saves', async (t) => {
  const { store, file } = await fixture(t);
  await store.save({ version: 1 });
  await assert.rejects(store.save({ data: 'x'.repeat(1024 * 1024) }), /limit/);
  assert.deepEqual(await store.load(), { version: 1 });
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(store.load(), /limit/);
});

test('storage rejects relative paths and reads Windows UTF-8 BOM files', async (t) => {
  assert.throws(() => new ProgressionStore('relative.json'), /absolute/);
  const { store, file } = await fixture(t);
  await fs.writeFile(file, '\uFEFF{"version":1}');
  assert.deepEqual(await store.load(), { version: 1 });
});
