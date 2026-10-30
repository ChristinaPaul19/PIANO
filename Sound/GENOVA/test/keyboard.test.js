'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HeldNotes, mapping, noteName } = require('../src/renderer/keyboard');

function setup() {
  const events = [];
  const notes = new HeldNotes({
    noteOn: (note, velocity) => events.push(['on', note, velocity]),
    noteOff: (note) => events.push(['off', note]),
    changed: () => {}
  });
  return { notes, events };
}

test('simultaneous keys retain independent notes and velocities', () => {
  const { notes, events } = setup();
  notes.press('a', 60, 80);
  notes.press('d', 64, 101);
  notes.press('g', 67, 96);
  assert.equal(notes.notes.size, 3);
  notes.release('d');
  assert.deepEqual(events, [['on', 60, 80], ['on', 64, 101], ['on', 67, 96], ['off', 64]]);
  assert.equal(notes.notes.size, 2);
});

test('pointer and laptop ownership do not cut off the same held note', () => {
  const { notes, events } = setup();
  notes.press('pointer:1', 60, 80);
  notes.press('keyboard:KeyA', 60, 100);
  notes.release('pointer:1');
  assert.equal(notes.notes.size, 1);
  assert.deepEqual(events, [['on', 60, 80]]);
  notes.release('keyboard:KeyA');
  assert.deepEqual(events, [['on', 60, 80], ['off', 60]]);
});

test('key repeats, lost captures and duplicate releases are idempotent', () => {
  const { notes, events } = setup();
  notes.press('a', 60, 80);
  notes.press('a', 72, 100);
  notes.release('a');
  notes.release('a');
  assert.deepEqual(events, [['on', 60, 80], ['off', 60]]);
});

test('release uses the original note even if octave changes externally', () => {
  const { notes, events } = setup();
  notes.press('a', 60, 80);
  notes.release('a');
  notes.press('a', 72, 80);
  notes.clear();
  assert.deepEqual(events, [['on', 60, 80], ['off', 60], ['on', 72, 80], ['off', 72]]);
  assert.equal(notes.sources.size, 0);
});

test('panic clears local state without sending stale release commands', () => {
  const { notes, events } = setup();
  notes.press('a', 60, 80);
  notes.clear(false);
  notes.release('a');
  assert.deepEqual(events, [['on', 60, 80]]);
  assert.equal(notes.notes.size, 0);
});

test('invalid keyboard MIDI values are rejected before playback', () => {
  const { notes, events } = setup();
  for (const [note, velocity] of [[128, 96], [-1, 96], [60.5, 96], [60, 0], [60, 128]]) {
    assert.throws(() => notes.press('invalid', note, velocity), RangeError);
  }
  assert.deepEqual(events, []);
});

test('laptop mapping covers chromatic notes and MIDI octave labels', () => {
  assert.equal(mapping.length, 17);
  assert.equal(new Set(mapping.map(([code]) => code)).size, 17);
  assert.equal(mapping[0][0], 'KeyA');
  assert.equal(mapping[12][0], 'KeyK');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(0), 'C-1');
});
