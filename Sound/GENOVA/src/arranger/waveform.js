'use strict';

const assert = require('node:assert/strict');

function parseWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= buffer.length, 'complete WAV chunks');
    const kind = buffer.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') format = { encoding: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10),
      sampleRate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    if (kind === 'data') data = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && data);
  assert.equal(format.encoding, 1);
  assert.equal(format.bits, 16);
  assert.ok(format.channels > 0 && format.sampleRate > 0);
  assert.equal(data.length % (format.channels * 2), 0);
  const samples = new Float64Array(data.length / (format.channels * 2));
  for (let i = 0; i < samples.length; i++) {
    for (let c = 0; c < format.channels; c++) samples[i] += data.readInt16LE((i * format.channels + c) * 2) / format.channels;
  }
  return { ...format, samples };
}
function rms(samples) {
  assert.ok(samples.length > 0, 'analysis window contains samples');
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}

function measureSpectrum(samples, notes, sampleRate) {
  const size = Math.round(sampleRate * 0.128);
  const hop = Math.round(sampleRate * 0.032);
  assert.ok(size >= 2 && hop >= 1 && samples.length >= size, 'at least 128 ms of PCM is required');
  const weights = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const powers = notes.map(() => 0);
  const kernels = notes.map(note => {
    const frequency = 440 * 2 ** ((note - 69) / 12);
    return {
      real: Float64Array.from(weights, (weight, i) => weight * Math.cos(2 * Math.PI * frequency * i / sampleRate)),
      imaginary: Float64Array.from(weights, (weight, i) => weight * Math.sin(2 * Math.PI * frequency * i / sampleRate))
    };
  });
  let frames = 0;
  for (let offset = 0; offset + size <= samples.length; offset += hop) {
    kernels.forEach((kernel, index) => {
      let real = 0;
      let imaginary = 0;
      for (let i = 0; i < size; i++) {
        real += samples[offset + i] * kernel.real[i];
        imaginary += samples[offset + i] * kernel.imaginary[i];
      }
      // Retriggered notes reset phase. Average frame powers, never complex coefficients
      // across separate attacks: otherwise valid fundamentals can cancel each other.
      powers[index] += 4 * (real * real + imaginary * imaginary) / (weightSum * weightSum);
    });
    frames++;
  }
  return { magnitudes: powers.map(power => Math.sqrt(power / frames)), frames, frameMs: 128, hopMs: 32 };
}

module.exports = { parseWav, rms, measureSpectrum };
