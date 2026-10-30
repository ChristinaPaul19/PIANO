'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { AudioEngine } = require('../src/audio/engine');
const { ArrangerEngine } = require('../src/arranger/engine');
const { styleList } = require('../src/arranger/styles');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'verification', 'arranger');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const { parseWav, rms, measureSpectrum } = require('../src/arranger/waveform');

// Filtering only isolates stems for measurement. Every retained command uses the real engine.
class Stem extends EventEmitter {
  constructor(audio, mode) { super(); this.audio = audio; this.mode = mode; this.trace = [];
    audio.on('status', state => this.emit('status', state)); }
  getStatus() { return this.audio.getStatus(); }
  programChange(args) { return this.audio.programChange(args); }
  setVolume(args) { return this.audio.setVolume(args); }
  allNotesOff(args) { return this.audio.allNotesOff(args); }
  noteOff(args) { return this.audio.noteOff(args); }
  noteOn(args) {
    if ((this.mode === 'drums' && args.channel !== 9) || (this.mode.startsWith('bass') && args.channel !== 1)) return Promise.resolve();
    this.trace.push({ ...args, at: performance.now() });
    return this.audio.noteOn(args);
  }
}
async function render(style, mode) {
  const file = path.join(output, `${style.id}-${mode}.wav`);
  const audio = new AudioEngine({ configPath: path.join(root, 'config', 'audio.json'),
    config: { audioDriver: 'file', audioFile: file, reverb: false, chorus: false } });
  const stem = new Stem(audio, mode);
  const arranger = new ArrangerEngine({ audio: stem });
  let origin; let on; let off; let end;
  try {
    await audio.initialize();
    origin = performance.now();
    arranger.configure({ enabled: true, styleId: style.id, tempo: 240 });
    if (mode !== 'drums') {
      for (const note of mode === 'bass-d' ? [50, 54, 57] : [48, 52, 55]) arranger.noteOn(note);
    }
    await wait(150);
    on = performance.now();
    await arranger.start();
    assert.equal(arranger.running, true, arranger.error);
    await wait(style.beatsPerBar * 250 - 25);
    assert.equal(arranger.running, true, arranger.error);
    await arranger.stop();
    off = performance.now();
    await wait(300);
    end = performance.now();
  } finally { await arranger.stop(); await audio.shutdown(); }
  const wav = parseWav(await fs.readFile(file));
  // WAV sample zero need not coincide with initialize() resolving. Analyze in the
  // sample domain rather than converting host command timestamps into PCM offsets.
  assert.ok(wav.samples.length >= wav.sampleRate * 0.3, 'render includes a measurable signal and stop tail');
  const energy = rms(wav.samples);
  const silence = rms(wav.samples.subarray(wav.samples.length - Math.round(wav.sampleRate * 0.12),
    wav.samples.length - Math.round(wav.sampleRate * 0.02)));
  assert.ok(energy > 15, `${style.id}/${mode}: audible waveform energy`);
  assert.ok(silence < 3, `${style.id}/${mode}: channel-scoped stop silences tails (${silence})`);
  const bassNotes = stem.trace.filter(event => event.channel === 1).map(event => event.note);
  const drumNotes = stem.trace.filter(event => event.channel === 9).map(event => event.note);
  if (mode === 'drums') assert.ok(drumNotes.includes(36) && bassNotes.length === 0);
  else if (mode === 'ensemble') assert.ok(drumNotes.length > 0 && bassNotes.length > 0);
  else assert.ok(bassNotes.length > 0 && drumNotes.length === 0);
  const spectral = measureSpectrum(wav.samples, [36, 38, 40, 42, 43, 45], wav.sampleRate);
  return { style: style.id, mode, file: path.relative(output, file), duration: wav.samples.length / wav.sampleRate,
    energy, silence, bassNotes, drumNotes, spectrum: spectral.magnitudes,
    analysis: { method: 'RMS of Hann-windowed short-time magnitudes', frameMs: spectral.frameMs,
      hopMs: spectral.hopMs, frames: spectral.frames, spectrumMidiNotes: [36, 38, 40, 42, 43, 45],
      energyWindow: 'entire WAV', silenceWindow: 'last 120 to 20 ms of WAV' },
    wallTiming: { startMs: on - origin, stopMs: off - origin, endMs: end - origin } };
}
async function main() {
  await fs.mkdir(output, { recursive: true });
  const results = [];
  for (const style of styleList()) {
    const takes = {};
    for (const mode of ['drums', 'bass-c', 'bass-d', 'ensemble']) {
      takes[mode] = await render(style, mode);
      results.push(takes[mode]);
    }
    assert.ok(takes['bass-c'].spectrum[0] > takes['bass-c'].spectrum[1] * 1.15, `${style.id}: C-root spectrum exceeds D-root`);
    assert.ok(takes['bass-d'].spectrum[1] > takes['bass-d'].spectrum[0] * 1.15, `${style.id}: D-root spectrum exceeds C-root`);
    assert.notDeepEqual(takes['bass-c'].bassNotes, takes['bass-d'].bassNotes, `${style.id}: chord-driven transposition`);
  }
  assert.equal(new Set(results.filter(result => result.mode === 'drums').map(result => JSON.stringify(result.drumNotes))).size, 3,
    'three styles have distinct performed drum patterns');
  const report = { verifiedAt: new Date().toISOString(), driver: 'FluidSynth file / PCM16',
    assertions: ['All three original styles rendered as drums, C bass, D bass and ensemble',
      'Isolated drums and bass produce non-silent PCM', 'C/D changes shift measured bass fundamentals',
      'Arranger stop silences both channels', 'Distinct performed drum patterns'], results };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Arranger verification passed: ${results.length} real FluidSynth WAV renders; ${path.join(output, 'results.json')}`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
