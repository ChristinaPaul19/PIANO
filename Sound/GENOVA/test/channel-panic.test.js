'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioEngine } = require('../src/audio/engine');

test('channel-scoped panic preserves unrelated channels and legacy global panic', async () => {
  const engine = new AudioEngine();
  const commands = [];
  engine._control = async (command) => commands.push(command);
  await engine.allNotesOff({ channel: 1 });
  assert.equal(commands[0], 'cc 1 64 0\ncc 1 123 0\ncc 1 120 0');
  await engine.allNotesOff();
  assert.equal(commands[1].split('\n').length, 48);
  assert.ok(commands[1].includes('cc 0 120 0'));
  assert.ok(commands[1].includes('cc 15 120 0'));
  for (const channel of [-1, 16, 1.5, '1\nquit']) await assert.rejects(engine.allNotesOff({ channel }), RangeError);
  assert.equal(commands.length, 2);
});
