'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { measureSpectrum, rms, parseWav } = require('../src/arranger/waveform');
const sampleRate = 8000;
const frequency = note => 440 * 2 ** ((note - 69) / 12);

function rockBass(root, phases, offset = 0, jitter = 0) {
  const samples = new Float64Array(Math.round(sampleRate * (1.45 + offset)));
  const strikes = [[0.15, root, 0.11], [0.275, root, 0.11], [0.4, root + 7, 0.175],
    [0.65, root, 0.11], [0.775, root, 0.11], [0.9, root + 7, 0.175]];
  strikes.forEach(([start, note, duration], index) => {
    start += offset + (index % 2 ? jitter : 0);
    const first = Math.round(start * sampleRate);
    const length = Math.round(duration * sampleRate);
    for (let i = 0; i < length; i++) {
      const phase = 2 * Math.PI * frequency(note) * (first + i) / sampleRate + phases[index];
      const envelope = Math.sin(Math.PI * i / length);
      samples[first + i] += 900 * envelope * Math.sin(phase);
    }
  });
  return samples;
}
function coherentMagnitude(samples, note) {
  let real = 0; let imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const angle = 2 * Math.PI * frequency(note) * i / sampleRate;
    real += samples[i] * Math.cos(angle);
    imaginary += samples[i] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / samples.length;
}

test('opposite-phase bass retriggers cancel a full-take DFT but not averaged short-time power', () => {
  const samples = rockBass(38, [0, Math.PI, 0, 0, Math.PI, 0]);
  const spectrum = measureSpectrum(samples, [36, 38], sampleRate);
  assert.ok(coherentMagnitude(samples, 38) < 5, 'old coherent measurement loses the actual D fundamental');
  assert.ok(spectrum.magnitudes[1] > 100, 'phase-independent measurement retains the actual fundamental');
  assert.ok(spectrum.magnitudes[1] > spectrum.magnitudes[0] * 1.15, 'unchanged pitch discrimination threshold');
  assert.equal(spectrum.frameMs, 128);
  assert.equal(spectrum.hopMs, 32);
  assert.ok(spectrum.frames > 30);
});

test('C/D discrimination survives attack phases, leading silence, transients and timing jitter', () => {
  const phases = [
    [0, 0, 0, 0, 0, 0],
    [0, Math.PI, 0, Math.PI, 0, Math.PI],
    [0.8, 2.1, 4.2, 5.8, 1.6, 3.3],
    [5.9, 2.8, 0.4, 4.4, 2.3, 0.9]
  ];
  for (const root of [36, 38]) {
    for (const phase of phases) {
      for (const offset of [0, 0.007, 0.023, 0.1]) {
        const samples = rockBass(root, phase, offset, 0.006);
        samples[Math.round((0.15 + offset) * sampleRate)] += 10000;
        const measured = measureSpectrum(samples, [36, 38], sampleRate).magnitudes;
        const own = root === 36 ? 0 : 1;
        assert.ok(measured[own] > measured[1 - own] * 1.15,
          `root ${root}, phases ${phase}, offset ${offset}: ${measured}`);
      }
    }
  }
});

test('analysis cannot pass swapped roots or silence and is insensitive to amplitude scaling', () => {
  const samples = rockBass(36, [0, 1, 2, 3, 4, 5]);
  const correct = measureSpectrum(samples, [36, 38], sampleRate).magnitudes;
  assert.ok(!(correct[1] > correct[0] * 1.15), 'incorrect D-root claim is rejected');
  const scaled = measureSpectrum(samples.map(value => value * 0.2), [36, 38], sampleRate).magnitudes;
  assert.ok(Math.abs(scaled[0] / scaled[1] - correct[0] / correct[1]) < 1e-10);
  const silent = new Float64Array(sampleRate);
  assert.equal(rms(silent), 0);
  assert.deepEqual(measureSpectrum(silent, [36, 38], sampleRate).magnitudes, [0, 0]);
  assert.throws(() => measureSpectrum(new Float64Array(10), [36], sampleRate), /128 ms/);
});

test('PCM16 parsing preserves sample-domain duration and catches incomplete chunks', () => {
  const data = Buffer.alloc(44 + 8);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22); data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(8, 40);
  [100, 300, -200, -400].forEach((value, index) => data.writeInt16LE(value, 44 + index * 2));
  const wav = parseWav(data);
  assert.equal(wav.sampleRate, sampleRate);
  assert.deepEqual([...wav.samples], [200, -300]);
  assert.throws(() => parseWav(data.subarray(0, data.length - 1)), /complete WAV chunks/);
});
