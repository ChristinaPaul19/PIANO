'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioController } = require('../src/main/audio-controller');

function fixture() {
  const calls = [];
  const audio = new EventEmitter();
  audio.state = 'ready';
  audio.getStatus = () => ({ state: audio.state });
  audio.listInstruments = () => [];
  for (const name of ['noteOn', 'noteOff', 'sustain', 'allNotesOff', 'pitchBend', 'programChange', 'setVolume']) {
    audio[name] = async (payload) => calls.push([name, payload]);
  }
  audio.shutdown = async () => { calls.push(['shutdown']); audio.state = 'stopped'; };
  const arranger = new EventEmitter();
  arranger.state = { enabled: false, running: false };
  arranger.snapshot = () => ({ ...arranger.state });
  arranger.configure = async (options) => { Object.assign(arranger.state, options); arranger.emit('state', arranger.snapshot()); };
  arranger.stop = async () => { calls.push(['arranger.stop']); arranger.state.running = false; };
  arranger.clearInput = () => calls.push(['arranger.clearInput']);
  arranger.noteOn = (note) => calls.push(['chordOn', note]);
  arranger.noteOff = (note) => calls.push(['chordOff', note]);
  const controller = new AudioController(audio, { arranger });
  return { audio, arranger, controller, calls };
}

test('accompaniment off preserves the full keyboard; on splits below C5 only', async () => {
  const { controller, calls } = fixture();
  await controller.dispatch('noteOn', { note: 60, velocity: 96 });
  await controller.dispatch('noteOff', { note: 60 });
  assert.deepEqual(calls, [['noteOn', { channel: 0, note: 60, velocity: 96 }], ['noteOff', { channel: 0, note: 60 }]]);
  await controller.dispatch('arranger.configure', { enabled: true });
  calls.length = 0;
  await controller.dispatch('noteOn', { note: 60, velocity: 96 });
  await controller.dispatch('noteOn', { note: 72, velocity: 100 });
  await controller.dispatch('noteOff', { note: 60 });
  await controller.dispatch('noteOff', { note: 72 });
  assert.deepEqual(calls, [['chordOn', 60], ['noteOn', { channel: 0, note: 72, velocity: 100 }], ['chordOff', 60], ['noteOff', { channel: 0, note: 72 }]]);
});

test('invalid MIDI is rejected even in the chord recognition zone', async () => {
  const { controller } = fixture();
  await controller.dispatch('arranger.configure', { enabled: true });
  for (const note of [-1, 128, 60.5, '60']) await assert.rejects(controller.dispatch('noteOn', { note, velocity: 96 }), /integer/);
  await assert.rejects(controller.dispatch('noteOn', { note: 60, velocity: 128 }), /integer/);
  await assert.rejects(controller.dispatch('arranger.configure', { enabled: 'true' }), /boolean/);
});

test('lead instrument changes release only channel zero without stopping accompaniment', async () => {
  const { controller, arranger, calls } = fixture();
  arranger.state.running = true;
  await controller.dispatch('program', { program: 16 });
  assert.equal(arranger.state.running, true);
  assert.ok(!calls.some(([operation]) => operation === 'arranger.stop'));
  assert.deepEqual(calls.find(([operation]) => operation === 'allNotesOff'), ['allNotesOff', { channel: 0 }]);
});

test('panic stops arranger, while octave cleanup releases only the keyboard', async () => {
  const { controller, arranger, calls } = fixture();
  arranger.state.running = true;
  await controller.dispatch('releaseKeyboard');
  assert.equal(arranger.state.running, true);
  calls.length = 0;
  await controller.dispatch('silence');
  assert.equal(arranger.state.running, false);
  assert.equal(calls[0][0], 'arranger.stop');
});

test('audio shutdown still executes if arranger cleanup fails', async () => {
  const { controller, audio, arranger } = fixture();
  arranger.stop = async () => { throw new Error('cleanup failure'); };
  await assert.rejects(controller.dispatch('shutdown'), /cleanup failure/);
  assert.equal(audio.state, 'stopped');
});

test('note-on zero releases the original chord route and state events are forwarded', async () => {
  const { controller, calls } = fixture();
  let event;
  controller.on('arranger', (state) => { event = state; });
  await controller.dispatch('arranger.configure', { enabled: true });
  await controller.dispatch('noteOn', { note: 60, velocity: 96 });
  await controller.dispatch('noteOn', { note: 60, velocity: 0 });
  assert.equal(event.enabled, true);
  assert.deepEqual(calls.slice(-2), [['chordOn', 60], ['chordOff', 60]]);
});
