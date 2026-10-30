'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizePeaks, assertAudibleWindow, assertSilentWindow, assertChordSubmissions, timingSummary } = require('../scripts/verify-live-arranger');
const { STYLES } = require('../src/arranger/styles');

function samples(peak, overrides = {}) {
  return Array.from({ length: 20 }, (_, index) => ({ at: index * 25, peak,
    sessionVolume: 1, endpointVolume: 0.5, sessionMute: false, endpointMute: false, ...overrides }));
}
test('live evidence cannot pass with missing or silent session samples', () => {
  assert.throws(() => assertAudibleWindow(summarizePeaks([], 0, 500), 'missing'), /observations/);
  assert.throws(() => assertAudibleWindow(summarizePeaks(samples(0), 0, 500), 'silent'), /measurable/);
  assert.throws(() => assertAudibleWindow(summarizePeaks(samples(0.01), 0, 100), 'sparse'), /observations/);
  const noiseAndSpike = samples(1 / 32768); noiseAndSpike[0].peak = 0.05;
  assert.throws(() => assertAudibleWindow(summarizePeaks(noiseAndSpike, 0, 500), 'dither'), /measurable/);
  assert.doesNotThrow(() => assertAudibleWindow(summarizePeaks(samples(0.01), 0, 500), 'signal'));
});
test('nonzero session peak does not bypass mute or volume checks', () => {
  for (const override of [{ sessionMute: true }, { endpointMute: true }, { sessionVolume: 0 }, { endpointVolume: 0 }]) {
    assert.throws(() => assertAudibleWindow(summarizePeaks(samples(0.3, override), 0, 500), 'muted'), /unmuted/);
  }
});
test('post-stop silence requires samples and rejects lingering signal', () => {
  assert.throws(() => assertSilentWindow(summarizePeaks([], 0, 500), 'missing'), /observations/);
  assert.throws(() => assertSilentWindow(summarizePeaks(samples(0.002), 0, 500), 'stuck'), /residual/);
  assert.doesNotThrow(() => assertSilentWindow(summarizePeaks(samples(0.00001), 0, 500), 'released'));
});
test('meter windows exclude other scenes and expose bounds', () => {
  const value = summarizePeaks([{ ...samples(0.5)[0], at: -1 }, ...samples(0.01), { ...samples(0.5)[0], at: 500 }], 0, 500);
  assert.equal(value.count, 20); assert.equal(value.max, 0.01); assert.equal(value.nonzero, 20);
});
test('actual chord submissions reject dropped notes and wrong MIDI pitches', () => {
  const entry = { label: 'synthetic', style: 'pop', section: 'A', root: 0, quality: 'minor', begin: 0, end: 1000 };
  const trace = [];
  for (let step = 0; step < 16; step++) {
    for (const event of STYLES.pop.patterns.A.events.filter(event => event.step === step)) {
      trace.push({ ...event, step, root: 0, quality: 'minor', tempo: 240, expectedAt: step * 62.5,
        note: event.channel === 9 ? event.note : 36 + [0, 3, 7][event.degree % 3] });
    }
  }
  assert.doesNotThrow(() => assertChordSubmissions(entry, trace));
  assert.throws(() => assertChordSubmissions(entry, trace.slice(1)), /subdivision coverage/);
  const incorrect = trace.map(event => ({ ...event }));
  incorrect.find(event => event.channel === 1).note++;
  assert.throws(() => assertChordSubmissions(entry, incorrect), /performed/);
});
test('timing uses absolute deadlines rather than fitting away cumulative drift', () => {
  const events = Array.from({ length: 11 }, (_, step) => ({ run: 0, step,
    expectedAt: 1000 + 100 * step, at: 1002 + 102 * step, ackAt: 1005 + 102 * step }));
  const report = timingSummary(events);
  assert.equal(report.phaseDriftMs, 20); assert.equal(report.driftSpanMs, 1000);
  assert.equal(report.latencyMs.min, 2); assert.equal(report.latencyMs.max, 22);
  assert.equal(report.commandAcknowledgmentMs.max, 3);
  assert.throws(() => timingSummary([]), /actual note submissions/);
});
