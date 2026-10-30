'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioController } = require('../src/main/audio-controller');
const { ArrangerEngine } = require('../src/arranger/engine');

function fixture() {
  const audio = new EventEmitter();
  audio.state = 'ready';
  audio.getStatus = () => ({ state: audio.state });
  audio.listInstruments = () => [];
  audio.initialize = async () => { audio.state = 'ready'; audio.emit('status', audio.getStatus()); };
  for (const method of ['programChange', 'setVolume', 'sustain', 'pitchBend', 'noteOn', 'noteOff', 'allNotesOff']) audio[method] = async () => {};
  const arranger = new ArrangerEngine({ audio });
  return { audio, arranger, controller: new AudioController(audio, { arranger }) };
}

for (const unavailable of ['error', 'stopping', 'stopped']) {
  test(`held chord input is cleared when audio becomes ${unavailable}, allowing a fresh chord after recovery`, async () => {
    const { audio, arranger, controller } = fixture();
    await controller.dispatch('arranger.configure', { enabled: true });
    for (const note of [60, 64, 67]) await controller.dispatch('noteOn', { note, velocity: 96 });
    assert.equal(arranger.snapshot().chord.name, 'C');
    audio.state = unavailable;
    audio.emit('status', audio.getStatus());
    await controller.dispatch('initialize');
    for (const note of [62, 65, 69]) await controller.dispatch('noteOn', { note, velocity: 96 });
    assert.equal(arranger.snapshot().chord.root, 2);
    assert.equal(arranger.snapshot().chord.quality, 'minor');
    for (const note of [62, 65, 69]) await controller.dispatch('noteOff', { note });
    assert.equal(arranger.held.size, 0);
  });
}
