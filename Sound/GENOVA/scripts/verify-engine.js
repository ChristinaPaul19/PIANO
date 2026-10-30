'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { AudioEngine } = require('../src/audio/engine');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, 'verification', 'engine');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function parseWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= buffer.length, 'WAV chunk is complete');
    if (name === 'fmt ') {
      format = { encoding: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    }
    if (name === 'data') data = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && data, 'WAV contains format and sample data');
  assert.equal(format.encoding, 1);
  assert.equal(format.bits, 16);
  const samples = new Float64Array(data.length / (format.channels * 2));
  for (let frame = 0; frame < samples.length; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      samples[frame] += data.readInt16LE((frame * format.channels + channel) * 2) / format.channels;
    }
  }
  return { ...format, samples, duration: samples.length / format.sampleRate };
}

function windowSamples(wav, start, end) {
  return wav.samples.subarray(Math.floor(start * wav.sampleRate), Math.floor(end * wav.sampleRate));
}
function rms(samples) {
  assert.ok(samples.length > 0, 'analysis window has samples');
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}
function magnitude(samples, frequency, sampleRate) {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index++) {
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    real += samples[index] * Math.cos(angle);
    imaginary += samples[index] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / samples.length;
}

async function render(name, perform) {
  const file = path.join(outputDirectory, `${name}.wav`);
  const engine = new AudioEngine({ configPath: path.join(root, 'config', 'audio.json'),
    config: { audioDriver: 'file', audioFile: file, reverb: false, chorus: false } });
  const marks = {};
  let start;
  try {
    await engine.initialize();
    assert.equal(engine.listInstruments().length, 128, 'installed SoundFont exposes all 128 GM bank 0 instruments');
    start = performance.now();
    const mark = label => { marks[label] = (performance.now() - start) / 1000; };
    await wait(200);
    await perform(engine, mark);
  } finally { await engine.shutdown(); }
  const wav = parseWav(await fs.readFile(file));
  const section = (from, to) => windowSamples(wav, marks[from] + 0.12, marks[to] - 0.08);
  return { file, wav, marks, section };
}

async function verifyEngine() {
  await fs.mkdir(outputDirectory, { recursive: true });
  const results = [];
  for (const [name, program, notes] of [
    ['piano', 0, [60]], ['organ', 16, [60]], ['strings', 48, [60]], ['chord', 0, [60, 64, 67]]
  ]) {
    const result = await render(name, async (engine, mark) => {
      await engine.programChange({ program });
      await engine.setVolume({ value: 110 });
      mark('on');
      for (const note of notes) await engine.noteOn({ note, velocity: 100 });
      await wait(650);
      mark('off');
      for (const note of notes) await engine.noteOff({ note });
      await wait(850);
      mark('released');
      await wait(300);
      mark('end');
    });
    const onRms = rms(result.section('on', 'off'));
    const releasedRms = rms(result.section('released', 'end'));
    assert.ok(onRms > 20, `${name} produces audible-range PCM energy`);
    assert.ok(releasedRms < onRms * 0.12 + 2, `${name} note-off decays`);
    const fundamentals = notes.map(note => magnitude(result.section('on', 'off'), 440 * 2 ** ((note - 69) / 12), result.wav.sampleRate));
    if (name === 'chord') assert.ok(fundamentals.every(value => value > 5), 'chord includes C4, E4 and G4 fundamentals');
    results.push({ name, program, notes, duration: result.wav.duration, onRms, releasedRms, fundamentals });
  }

  const sustained = await render('sustain', async (engine, mark) => {
    await engine.programChange({ program: 16 });
    await engine.sustain({ enabled: true });
    await engine.noteOn({ note: 60, velocity: 100 });
    mark('on'); await wait(450);
    await engine.noteOff({ note: 60 });
    mark('held'); await wait(500);
    await engine.sustain({ enabled: false });
    mark('off'); await wait(850);
    mark('released'); await wait(300); mark('end');
  });
  const heldRms = rms(sustained.section('held', 'off'));
  const releasedRms = rms(sustained.section('released', 'end'));
  assert.ok(heldRms > 20, 'pedal holds released organ note');
  assert.ok(releasedRms < heldRms * 0.05 + 2, 'pedal release stops held note');
  results.push({ name: 'sustain', heldRms, releasedRms, duration: sustained.wav.duration });

  const switches = await render('program-switches', async (engine, mark) => {
    for (const program of [0, 16, 48]) {
      await engine.allNotesOff();
      await engine.programChange({ program });
      await engine.noteOn({ note: 60, velocity: 100 });
      mark(`on${program}`); await wait(500); mark(`off${program}`);
    }
    await engine.allNotesOff();
    mark('panic'); await wait(350); mark('end');
  });
  const programEnergy = [0, 16, 48].map(program => rms(switches.section(`on${program}`, `off${program}`)));
  assert.ok(programEnergy.every(value => value > 20), 'each program switch produces sound');
  const panicRms = rms(switches.section('panic', 'end'));
  assert.ok(panicRms < 2, 'allNotesOff silences active voices');
  const signatures = [0, 16, 48].map(program => {
    const samples = switches.section(`on${program}`, `off${program}`);
    return [1, 2, 3, 4].map(harmonic => magnitude(samples, 261.625565 * harmonic, switches.wav.sampleRate) / rms(samples));
  });
  for (let index = 1; index < signatures.length; index++) {
    assert.ok(signatures[index].some((value, harmonic) => Math.abs(value - signatures[index - 1][harmonic]) > 0.03),
      'program switches change harmonic spectrum');
  }
  results.push({ name: 'program-switches', programEnergy, panicRms, signatures, duration: switches.wav.duration });

  const controls = await render('volume-pitch', async (engine, mark) => {
    await engine.programChange({ program: 16 });
    await engine.setVolume({ value: 100 });
    await engine.noteOn({ note: 69, velocity: 100 });
    mark('normal'); await wait(500);
    await engine.pitchBend({ value: 4096 });
    mark('bent'); await wait(500);
    await engine.setVolume({ value: 0 });
    mark('muted'); await wait(450); mark('end');
  });
  const normal = controls.section('normal', 'bent');
  const bent = controls.section('bent', 'muted');
  const normal440 = magnitude(normal, 440, controls.wav.sampleRate);
  const normal466 = magnitude(normal, 440 * 2 ** (1 / 12), controls.wav.sampleRate);
  const bent440 = magnitude(bent, 440, controls.wav.sampleRate);
  const bent466 = magnitude(bent, 440 * 2 ** (1 / 12), controls.wav.sampleRate);
  assert.ok(normal440 > normal466 * 2, 'normal pitch is A4');
  assert.ok(bent466 > bent440 * 2, 'signed half-positive pitch bend raises pitch one semitone');
  const mutedRms = rms(controls.section('muted', 'end'));
  assert.ok(mutedRms < 2, 'CC7 zero mutes active note');
  results.push({ name: 'volume-pitch', normal440, normal466, bent440, bent466, mutedRms, duration: controls.wav.duration });
  const report = { verifiedAt: new Date().toISOString(), driver: 'file', physicalAudibilityVerified: false, results };
  await fs.writeFile(path.join(outputDirectory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (require.main === module) {
  verifyEngine().then(report => console.log(`Verified ${report.results.length} FluidSynth render scenarios; results: ${path.join(outputDirectory, 'results.json')}`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { verifyEngine, parseWav };
