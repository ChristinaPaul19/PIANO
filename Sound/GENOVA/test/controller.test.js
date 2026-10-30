'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioController } = require('../src/main/audio-controller');

class EngineStub extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.calls = []; }
  getStatus() { return { state: this.state }; }
  listInstruments() { return [{ program: 0, name: 'Piano' }]; }
  async initialize() { this.calls.push('initialize'); this.state = 'ready'; this.emit('status', this.getStatus()); }
  async shutdown() { this.calls.push('shutdown'); this.state = 'stopped'; }
  async programChange(data) { this.calls.push(['program', data]); }
  async setVolume(data) { this.calls.push(['volume', data]); }
  async sustain(data) { this.calls.push(['sustain', data]); }
  async pitchBend(data) { this.calls.push(['pitchBend', data]); }
  async allNotesOff() { this.calls.push('allNotesOff'); }
  async noteOn(data) { this.calls.push(['noteOn', data]); }
  async noteOff(data) { this.calls.push(['noteOff', data]); }
}

test('initialize sets known controls and repeated initialization is idempotent', async () => {
  const engine = new EngineStub();
  const controller = new AudioController(engine);
  const events = [];
  controller.on('status', (status) => events.push(status.state));
  const [first, second] = await Promise.all([controller.dispatch('initialize'), controller.dispatch('initialize')]);
  assert.equal(engine.calls.filter((entry) => entry === 'initialize').length, 1);
  assert.equal(first.status.state, 'ready');
  assert.deepEqual(second.controls, { program: 0, volume: 100, sustain: false, pitchBend: 0 });
  assert.deepEqual(events, ['ready']);
});

test('program switching releases pedal, stops voices and resets pitch first', async () => {
  const engine = new EngineStub();
  const controller = new AudioController(engine);
  await controller.dispatch('initialize');
  engine.calls.length = 0;
  const snapshot = await controller.dispatch('program', { program: 48 });
  assert.deepEqual(engine.calls, [
    ['sustain', { channel: 0, enabled: false }], 'allNotesOff',
    ['pitchBend', { channel: 0, value: 0 }], ['program', { channel: 0, program: 48 }]
  ]);
  assert.equal(snapshot.controls.program, 48);
});

test('serialized operations prevent interleaving program reset and note-on', async () => {
  const engine = new EngineStub();
  const controller = new AudioController(engine);
  await controller.dispatch('initialize');
  engine.calls.length = 0;
  await Promise.all([
    controller.dispatch('program', { program: 16 }),
    controller.dispatch('noteOn', { note: 60, velocity: 90 }),
    controller.dispatch('noteOff', { note: 60 })
  ]);
  assert.deepEqual(engine.calls.slice(-3), [
    ['program', { channel: 0, program: 16 }],
    ['noteOn', { channel: 0, note: 60, velocity: 90 }],
    ['noteOff', { channel: 0, note: 60 }]
  ]);
});

test('invalid requests do not poison subsequent commands', async () => {
  const engine = new EngineStub();
  const controller = new AudioController(engine);
  await assert.rejects(controller.dispatch('arbitrary-shell'), /Unsupported/);
  await assert.rejects(controller.dispatch('program', { program: '0\nquit' }), RangeError);
  await controller.dispatch('initialize');
  assert.equal(controller.snapshot().status.state, 'ready');
});

test('shutdown is awaited and controls follow successful commands', async () => {
  const engine = new EngineStub();
  const controller = new AudioController(engine);
  await controller.dispatch('initialize');
  await controller.dispatch('volume', { value: 40 });
  await controller.dispatch('sustain', { enabled: true });
  await controller.dispatch('pitchBend', { value: 2048 });
  assert.deepEqual(controller.snapshot().controls, { program: 0, volume: 40, sustain: true, pitchBend: 2048 });
  await controller.dispatch('silence');
  assert.equal(controller.snapshot().controls.sustain, false);
  assert.equal(controller.snapshot().controls.pitchBend, 0);
  const stopped = await controller.dispatch('shutdown');
  assert.equal(stopped.status.state, 'stopped');
  assert.deepEqual(stopped.instruments, []);
});
