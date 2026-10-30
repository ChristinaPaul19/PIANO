'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyEngine, parseWav } = require('../scripts/verify-engine');

test('WAV analysis rejects malformed input', () => {
  assert.throws(() => parseWav(Buffer.from('not a wave file')), /RIFF/);
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.write('WAVE', 8);
  wav.write('data', 12);
  wav.writeUInt32LE(100, 16);
  assert.throws(() => parseWav(wav), /complete/);
});

test('actual FluidSynth renders piano, organ, strings, chords and MIDI controls', {
  skip: process.env.GENOVA_AUDIO_RENDER_TEST !== '1', timeout: 60000
}, async () => {
  const report = await verifyEngine();
  assert.equal(report.results.length, 7);
  assert.equal(report.physicalAudibilityVerified, false);
});
