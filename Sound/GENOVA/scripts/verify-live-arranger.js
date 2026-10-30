'use strict';

// Run explicitly: node scripts\verify-live-arranger.js. This produces real WASAPI output.
// No recording, endpoint peak capture, device setting changes, or file-driver fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { AudioEngine } = require('../src/audio/engine');
const { ArrangerEngine } = require('../src/arranger/engine');
const { STYLES } = require('../src/arranger/styles');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'verification', 'live-arranger');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHORDS = [
  { name: 'C major', root: 0, quality: 'major', notes: [48, 52, 55] },
  { name: 'C minor', root: 0, quality: 'minor', notes: [48, 51, 55] },
  { name: 'D major', root: 2, quality: 'major', notes: [50, 54, 57] }
];
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const max = values => Math.max(...values);
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
function summarizePeaks(samples, begin, end) {
  const selected = samples.filter(sample => sample.at >= begin && sample.at < end);
  const values = selected.map(sample => sample.peak);
  return { begin, end, count: values.length, max: values.length ? max(values) : null,
    mean: values.length ? mean(values) : null,
    signalThreshold: 0.0001, nonzero: values.filter(value => value > 0.0001).length,
    mutedSamples: selected.filter(sample => sample.sessionMute || sample.endpointMute ||
      sample.sessionVolume <= 0 || sample.endpointVolume <= 0).length };
}
function assertAudibleWindow(summary, label) {
  assert.ok(summary.count >= 8, `${label}: enough live meter observations (${summary.count})`);
  assert.equal(summary.mutedSamples, 0, `${label}: session and endpoint must be unmuted with nonzero volume`);
  assert.ok(summary.max > 0.0001 && summary.nonzero >= 4, `${label}: measurable owned WASAPI signal (${summary.max})`);
}
function assertSilentWindow(summary, label) {
  assert.ok(summary.count >= 8, `${label}: enough live silence observations`);
  assert.ok(summary.max <= 0.0001, `${label}: residual peak ${summary.max} exceeds -80 dBFS threshold`);
}
function assertChordSubmissions(entry, trace) {
  const bass = trace.filter(event => event.channel === 1);
  assert.ok(bass.length > 0, `${entry.label}: chord-driven bass submissions`);
  assert.ok(bass.every(event => event.root === entry.root && event.quality === entry.quality), `${entry.label}: correct applied harmony`);
  const intervals = entry.quality === 'minor' ? [0, 3, 7] : [0, 4, 7];
  const style = STYLES[entry.style];
  const stepMs = 60000 / trace[0].tempo / 4;
  const origin = trace[0].expectedAt - trace[0].step * stepMs;
  const expected = [];
  for (let step = Math.max(0, Math.ceil((entry.begin - origin) / stepMs - 0.0001)); origin + step * stepMs < entry.end - 1; step++) {
    for (const event of style.patterns[entry.section].events.filter(event => event.step === step % (style.beatsPerBar * 4))) {
      expected.push({ step, channel: event.channel, velocity: event.velocity,
        note: event.channel === 9 ? event.note : 36 + entry.root + intervals[event.degree % intervals.length] });
    }
  }
  assert.deepEqual(trace.map(({ step, channel, velocity, note }) => ({ step, channel, velocity, note })), expected,
    `${entry.label}: exact performed drum/bass pitches, velocities and subdivision coverage`);
  return bass.map(event => event.note);
}
function timingSummary(events) {
  assert.ok(events.length > 0, 'timing requires actual note submissions');
  const lateness = events.map(event => event.at - event.expectedAt);
  const acknowledgments = events.map(event => event.ackAt - event.at);
  const steps = [...new Map(events.map(event => [`${event.run}:${event.step}`, event])).values()];
  const firstRun = events[0].run;
  const singleRun = steps.filter(event => event.run === firstRun);
  const first = singleRun[0]; const last = singleRun.at(-1);
  return { noteSubmissions: events.length, activeSubdivisions: steps.length,
    latencyMs: { min: Math.min(...lateness), median: percentile(lateness, 0.5), p95: percentile(lateness, 0.95), max: max(lateness) },
    commandAcknowledgmentMs: { median: percentile(acknowledgments, 0.5), p95: percentile(acknowledgments, 0.95), max: max(acknowledgments) },
    jitterMs: Math.sqrt(mean(lateness.map(value => (value - mean(lateness)) ** 2))),
    phaseDriftMs: (last.at - last.expectedAt) - (first.at - first.expectedAt),
    driftSpanMs: last.expectedAt - first.expectedAt,
    driftRun: firstRun,
    definition: 'Host API submission lateness against absolute transport deadlines; acknowledgment is FluidSynth shell roundtrip, not DAC latency. Drift compares first/last active subdivisions within the specified run.' };
}
class ObservedAudio extends EventEmitter {
  constructor(audio) {
    super(); this.audio = audio; this.trace = []; this.runs = []; this.active = new Set();
    audio.on('status', state => this.emit('status', state));
  }
  getStatus() { return this.audio.getStatus(); }
  programChange(args) { return this.audio.programChange(args); }
  setVolume(args) { return this.audio.setVolume(args); }
  async allNotesOff(args) {
    await this.audio.allNotesOff(args);
    for (const key of this.active) if (key.startsWith(`${args.channel}:`)) this.active.delete(key);
  }
  async noteOff(args) { await this.audio.noteOff(args); this.active.delete(`${args.channel}:${args.note}`); }
  async noteOn(args) {
    const engine = this.arranger;
    const step = engine.step - 1;
    const expectedAt = engine.nextTime - 60000 / engine.tempo / 4;
    if (this.run.origin === undefined) this.run.origin = expectedAt - step * 60000 / engine.tempo / 4;
    const event = { ...args, run: this.run.id, style: engine.styleId, section: engine.section,
      bar: engine.bar, beat: engine.beat, step, tempo: engine.tempo, expectedAt, at: performance.now(),
      root: engine.chord?.root ?? null, quality: engine.chord?.quality ?? null };
    this.trace.push(event);
    await this.audio.noteOn(args);
    event.ackAt = performance.now();
    this.active.add(`${args.channel}:${args.note}`);
  }
  beginRun(label) {
    this.run = { id: this.runs.length, label }; this.runs.push(this.run);
  }
}
async function waitFor(predicate, label, timeout = 12000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await wait(8);
  }
}
function playChord(arranger, harmony) {
  arranger.clearInput();
  for (const note of harmony.notes) arranger.noteOn(note);
  for (const note of harmony.notes) arranger.noteOff(note);
}
async function openMeter(pid, report) {
  const stopFile = path.join(OUTPUT, `meter-${process.pid}.stop`);
  await fs.rm(stopFile, { force: true });
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'audio-meter.ps1'), '-TargetPid', String(pid), '-StopFile', stopFile,
    '-MaximumSeconds', '360', '-IntervalMs', '25'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = []; let buffer = ''; let ready = false; let error = ''; let closed = false;
  const offset = performance.now() - Date.now();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        if (sample.kind === 'ready') ready = true;
        else if (sample.kind === 'sample') samples.push({ ...sample, at: sample.unixMs + offset, receivedAt: performance.now() });
      } catch { error += `Invalid meter output: ${line}\n`; }
    }
  });
  child.stderr.on('data', text => { error += text; });
  child.on('error', exception => { error += exception.message; closed = true; });
  const exit = new Promise(resolve => child.on('close', (code, signal) => {
    closed = true; report.meterExit = { code, signal }; resolve();
  }));
  const result = { samples, pid: child.pid,
    async stop() {
      await fs.writeFile(stopFile, 'stop\n');
      await Promise.race([exit, wait(4000)]);
      if (!closed) { child.kill(); await exit; }
      await fs.rm(stopFile, { force: true });
      report.meterDiagnostics = error;
    },
    ensureHealthy() { assert.ok(!closed && !error, `Meter stopped or failed: ${error}`); }
  };
  try {
    await waitFor(() => ready || closed || error, 'owned WASAPI session meter readiness', 20000);
    assert.ok(ready && !closed && !error, `Per-process metering unavailable: ${error}`);
    await waitFor(() => samples.length >= 4, 'initial live meter samples', 2000);
    return result;
  } catch (exception) { await result.stop(); throw exception; }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Live validation requires Windows WASAPI');
  await fs.mkdir(OUTPUT, { recursive: true });
  const configPath = path.join(ROOT, 'config', 'audio.json');
  const configText = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(configText.replace(/^\uFEFF/, ''));
  assert.equal(config.audioDriver, 'wasapi', 'Do not replace the configured live driver');
  const report = { startedAt: new Date().toISOString(), passed: false, driver: 'wasapi',
    backendDefaults: config, overrides: {}, scenarios: [], stops: [], progressions: [],
    limitations: ['Per-process peak metering observes only the spawned FluidSynth render session; no audio samples are recorded.',
      'Signal + unmuted session/endpoint does not independently prove physical speaker audibility or identify chord spectra.',
      'Chord identity is verified at real MIDI submission; frequency-domain proof is outside peak metering.',
      'Timing is Node/main-process submission and shell acknowledgment, not renderer, DAC or sample-accurate timing.',
      'Meter timestamps use helper monotonic time anchored to UTC; timestamp alignment has clock/IPC uncertainty.',
      'Short bounded memory sampling is not proof of absence of leaks; Node memory includes intentionally retained meter, transport and note evidence.'],
    measurementBounds: { meterRequestedPeriodMs: 25, meterClockAlignmentAllowanceMs: 20,
      sceneStartGuardMs: 80, sceneEndGuardMs: 50, silenceThresholdPeak: 0.0001,
      signalThresholdPeak: 0.0001, minimumSignalSamples: 4,
      stopTailAllowanceMs: 2400,
      noteTiming: 'API entry immediately before the real AudioEngine call, plus shell acknowledgment; pipe buffering and audio-device latency remain unmeasured.' },
    references: ['https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nn-audiopolicy-iaudiosessioncontrol2',
      'https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudiometerinformation',
      'https://learn.microsoft.com/en-us/windows/win32/coreaudio/peak-meters'] };
  const audio = new AudioEngine({ configPath });
  const observed = new ObservedAudio(audio);
  const arranger = new ArrangerEngine({ audio: observed }); observed.arranger = arranger;
  const states = []; const memory = []; let meter; let memoryTimer; let failure;
  arranger.on('state', state => states.push({ at: performance.now(), run: observed.run?.id, ...state }));
  const beatMs = 60000 / 180;
  function boundary(bar, beat = 0) { return observed.run.origin + (bar * STYLES[arranger.styleId].beatsPerBar + beat) * beatMs; }
  async function position(bar, beat = 0) {
    await waitFor(() => !arranger.running || arranger.bar > bar || (arranger.bar === bar && arranger.beat >= beat), `${arranger.styleId} bar ${bar} beat ${beat}`);
    assert.ok(arranger.running, arranger.error || 'Transport stopped early');
    assert.equal(arranger.bar, bar, 'No skipped bar in scenario');
    assert.equal(arranger.beat, beat, 'No skipped beat in scenario');
    meter.ensureHealthy();
  }
  function scene(label, begin, end, extra = {}) {
    report.scenarios.push({ label, style: arranger.styleId, run: observed.run.id, begin, end, ...extra });
  }
  async function begin(label, intro = false) {
    observed.beginRun(label); await arranger.start({ intro });
    assert.ok(arranger.running, arranger.error || 'Start failed');
  }
  async function stopAndMeasure(label) {
    await arranger.stop(); const stopAt = performance.now();
    assert.equal(observed.active.size, 0, `${label}: no tracked held accompaniment notes after panic`);
    await wait(3000);
    const summary = summarizePeaks(meter.samples, stopAt + 2400, stopAt + 2950);
    report.stops.push({ label, stopAt, tailAllowanceMs: 2400, ...summary });
    assertSilentWindow(summary, label);
    assert.equal(observed.trace.filter(event => event.at > stopAt).length, 0, 'No delayed notes after Stop');
  }
  try {
    await audio.initialize(); report.fluidSynthPid = audio.getStatus().pid;
    meter = await openMeter(report.fluidSynthPid, report); report.meterPid = meter.pid;
    console.log(`LIVE AUDIO START: FluidSynth PID ${report.fluidSynthPid}, owned-session meter PID ${meter.pid}; default WASAPI/gain/effects.`);
    memoryTimer = setInterval(() => memory.push({ at: performance.now(), ...process.memoryUsage() }), 1000);
    const baselineBegin = performance.now(); await wait(500);
    report.baseline = summarizePeaks(meter.samples, baselineBegin, performance.now());
    assertSilentWindow(report.baseline, 'Initialized idle session');

    for (const style of Object.values(STYLES)) {
      arranger.configure({ enabled: true, styleId: style.id, tempo: 180 });
      arranger.requestSection('A'); playChord(arranger, CHORDS[0]);
      await begin(`${style.id}-sections`, true);
      const introStart = boundary(0); await position(2);
      assert.equal(arranger.section, 'A');
      scene(`${style.id}/intro`, introStart, boundary(2), { section: 'intro', bars: 2 });
      let bar = 2;
      for (const variation of ['A', 'B', 'C', 'D']) {
        if (arranger.section !== variation) {
          arranger.requestSection(variation); await position(++bar);
          assert.equal(arranger.section, variation);
        }
        for (const harmony of CHORDS) {
          playChord(arranger, harmony);
          const requestedAt = performance.now();
          await position(bar, 1);
          assert.equal(arranger.chord.root, harmony.root);
          assert.equal(arranger.chord.quality, harmony.quality);
          const start = boundary(bar, 1);
          await position(++bar);
          scene(`${style.id}/${variation}/${harmony.name}`, start, boundary(bar),
            { section: variation, root: harmony.root, quality: harmony.quality, requestedAt });
        }
      }
      arranger.requestSection('fill'); await position(++bar);
      assert.equal(arranger.section, 'fill'); const fillStart = boundary(bar);
      await position(++bar); assert.equal(arranger.section, 'D');
      scene(`${style.id}/fill`, fillStart, boundary(bar), { section: 'fill', bars: 1 });
      arranger.requestSection('break'); await position(++bar);
      assert.equal(arranger.section, 'break'); const breakStart = boundary(bar);
      await position(++bar); assert.equal(arranger.section, 'D');
      scene(`${style.id}/break`, breakStart, boundary(bar), { section: 'break', bars: 1, sparse: true });
      arranger.requestSection('ending'); await position(++bar);
      assert.equal(arranger.section, 'ending'); const endingStart = boundary(bar);
      const endingBar = bar;
      await waitFor(() => !arranger.running, `${style.id} ending auto-stop`, 6000);
      assert.equal(arranger.bar, endingBar + 2);
      scene(`${style.id}/ending`, endingStart, boundary(endingBar + 2), { section: 'ending', bars: 2 });
      await stopAndMeasure(`${style.id}/ending-stop`);

      arranger.requestSection('A'); playChord(arranger, CHORDS[0]);
      await begin(`${style.id}-record-loop`);
      arranger.recordStart(); await position(1);
      playChord(arranger, CHORDS[1]); await position(1, 1);
      playChord(arranger, CHORDS[2]); await position(1, 2);
      arranger.recordStop();
      const progression = arranger.exportProgression();
      assert.deepEqual(progression, { version: 1, beatsPerBar: style.beatsPerBar, lengthBars: 1,
        events: CHORDS.map((harmony, beat) => ({ beat, root: harmony.root, quality: harmony.quality })) });
      arranger.setLoop(true);
      const loopObservations = [];
      for (let loopBar = 2; loopBar <= 4; loopBar++) {
        for (let beat = 0; beat < style.beatsPerBar; beat++) {
          await position(loopBar, beat);
          const expected = CHORDS[Math.min(beat, 2)];
          assert.equal(arranger.chord.root, expected.root); assert.equal(arranger.chord.quality, expected.quality);
          loopObservations.push({ bar: loopBar, beat, root: arranger.chord.root, quality: arranger.chord.quality });
          if (beat === 0) playChord(arranger, CHORDS[2]); // Live input cannot replace the loop's harmony.
        }
      }
      await position(5);
      scene(`${style.id}/loop-wraps`, boundary(2), boundary(5), { loop: true });
      await stopAndMeasure(`${style.id}/loop-stop`);
      assert.equal(arranger.looping, true);
      await begin(`${style.id}-loop-restart`);
      assert.equal(arranger.chord.root, 0); assert.equal(arranger.chord.quality, 'major');
      await position(1);
      assert.equal(arranger.chord.root, 0); assert.equal(arranger.chord.quality, 'major');
      scene(`${style.id}/loop-restart`, boundary(0), boundary(1), { loop: true });
      await stopAndMeasure(`${style.id}/restart-stop`);
      arranger.setLoop(false);
      report.progressions.push({ style: style.id, progression, loopObservations, restartAtZero: true });
      console.log(`CHECKPOINT ${style.id}: A/B/C/D x C major/C minor/D; intro/fill/break/ending; record/wrap/restart; live stop-tail verified.`);
    }

    arranger.configure({ styleId: 'pop', tempo: 180 });
    arranger.requestSection('A'); playChord(arranger, CHORDS[0]);
    await begin('bounded-repeated-cycle-memory');
    const soakBegin = performance.now(); let cycles = 0;
    while (performance.now() - soakBegin < 45000) {
      const bar = arranger.bar + 1;
      arranger.requestSection('ABCD'[cycles % 4]); playChord(arranger, CHORDS[cycles % 3]);
      await position(bar); cycles++;
    }
    report.memorySoak = { begin: soakBegin, end: performance.now(), cycles,
      scope: 'Repeated live variation/chord cycles in one long-lived FluidSynth process; no per-cycle backend restart.' };
    scene('memory-repeated-cycles', soakBegin, performance.now());
    await stopAndMeasure('memory-cycle-stop');
    console.log(`CHECKPOINT memory: ${cycles} live variation/chord cycles over ${((report.memorySoak.end - soakBegin) / 1000).toFixed(1)} s.`);

    for (const entry of report.scenarios) {
      entry.meter = summarizePeaks(meter.samples, entry.begin + 80, entry.end - 50);
      assertAudibleWindow(entry.meter, entry.label);
      const trace = observed.trace.filter(event => event.run === entry.run && event.expectedAt >= entry.begin - 1 && event.expectedAt < entry.end - 1);
      entry.noteCount = trace.length;
      assert.ok(trace.length > 0, `${entry.label}: actual synth notes`);
      if (entry.section) assert.ok(trace.every(event => event.section === entry.section), `${entry.label}: section duration`);
      if (entry.quality) entry.bassNotes = assertChordSubmissions(entry, trace);
      if (entry.sparse) {
        const stepMs = beatMs / 4;
        const middle = trace.filter(event => event.expectedAt > entry.begin + stepMs && event.expectedAt < entry.end - 2 * stepMs - 1);
        assert.equal(middle.length, 0, `${entry.label}: no new notes in sparse middle`);
        entry.opening = summarizePeaks(meter.samples, entry.begin + 70, entry.begin + 280);
        entry.middleTail = summarizePeaks(meter.samples, entry.end - 450, entry.end - 220);
        assert.ok(entry.opening.count >= 4 && entry.middleTail.count >= 4, `${entry.label}: tail sample coverage`);
        assert.ok(entry.middleTail.mean < entry.opening.mean, `${entry.label}: existing opening hit decays in sparse middle`);
      }
    }
    report.timing = timingSummary(observed.trace);
    report.timingByRun = observed.runs.map(run => ({ ...run, ...timingSummary(observed.trace.filter(event => event.run === run.id)) }));
    assert.ok(report.timing.latencyMs.min >= -2, 'No materially early MIDI subdivisions');
    assert.ok(report.timing.latencyMs.p95 < 40, 'p95 actual note-submission lateness below 40 ms');
    assert.ok(report.timing.latencyMs.max < beatMs / 2, 'No note-submission delay exceeding half a beat');
    for (const timing of report.timingByRun) assert.ok(Math.abs(timing.phaseDriftMs) < 40, 'Bounded cumulative host phase drift');
    report.passed = true;
  } catch (error) { failure = error; report.error = error.stack || String(error); }
  finally {
    clearInterval(memoryTimer);
    try { await arranger.stop(); } catch (error) { report.cleanupArrangerError = String(error); }
    if (meter) { try { await meter.stop(); } catch (error) { report.cleanupMeterError = String(error); } }
    try { await audio.shutdown(); } catch (error) { report.cleanupAudioError = String(error); }
    report.finishedAt = new Date().toISOString();
    report.audioFinalStatus = audio.getStatus();
    report.configUnchanged = (await fs.readFile(configPath, 'utf8')) === configText;
    report.ownedProcessesStopped = audio.getStatus().pid === null && (!meter || report.meterExit !== undefined);
    const samples = meter?.samples || [];
    const memorySamples = samples.filter((sample, index) => index === 0 || sample.workingSet !== samples[index - 1].workingSet ||
      sample.privateBytes !== samples[index - 1].privateBytes || Math.floor(sample.elapsedMs / 1000) !== Math.floor(samples[index - 1].elapsedMs / 1000));
    if (samples.length) {
      const warm = samples.find(sample => sample.at >= samples[0].at + 10000) || samples[0];
      const final = samples.at(-1);
      const select = sample => ({ at: sample.at, workingSet: sample.workingSet, privateBytes: sample.privateBytes });
      report.memory = { sampledDurationMs: final.at - samples[0].at, startup: select(samples[0]), warmup10s: select(warm),
        final: select(final), peakWorkingSet: max(samples.map(sample => sample.workingSet)),
        peakPrivateBytes: max(samples.map(sample => sample.privateBytes)),
        warmupToFinalWorkingSetDelta: final.workingSet - warm.workingSet,
        warmupToFinalPrivateBytesDelta: final.privateBytes - warm.privateBytes };
      report.meter = { sampleCount: samples.length, approximatePeriodMs: (final.at - samples[0].at) / (samples.length - 1),
        p95DeliveryDelayMs: percentile(samples.map(sample => sample.receivedAt - sample.at), 0.95),
        maxDeliveryDelayMs: max(samples.map(sample => sample.receivedAt - sample.at)),
        first: samples[0], last: final };
    }
    const acknowledged = observed.trace.filter(event => Number.isFinite(event.ackAt));
    if (acknowledged.length && !report.timing) report.timing = timingSummary(acknowledged);
    if (!report.configUnchanged || !report.ownedProcessesStopped || report.cleanupArrangerError || report.cleanupMeterError || report.cleanupAudioError) report.passed = false;
    await fs.writeFile(path.join(OUTPUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(OUTPUT, 'note-submissions.json'), JSON.stringify(observed.trace, null, 2) + '\n');
    await fs.writeFile(path.join(OUTPUT, 'transport-states.json'), JSON.stringify(states, null, 2) + '\n');
    await fs.writeFile(path.join(OUTPUT, 'meter-samples.json'), JSON.stringify(samples, null, 2) + '\n');
    await fs.writeFile(path.join(OUTPUT, 'memory-samples.json'), JSON.stringify({ fluidSynth: memorySamples, node: memory }, null, 2) + '\n');
    console.log(`LIVE AUDIO END: owned processes stopped=${report.ownedProcessesStopped}; passed=${report.passed}; ${path.join(OUTPUT, 'results.json')}`);
  }
  if (failure) throw failure;
  assert.ok(report.passed, 'Verification cleanup/invariants failed');
}
async function recheckSavedEvidence() {
  const report = JSON.parse(await fs.readFile(path.join(OUTPUT, 'results.json'), 'utf8'));
  const samples = JSON.parse(await fs.readFile(path.join(OUTPUT, 'meter-samples.json'), 'utf8'));
  const events = JSON.parse(await fs.readFile(path.join(OUTPUT, 'note-submissions.json'), 'utf8'));
  assert.equal(report.passed, true, 'Reanalysis cannot replace an incomplete/failed live run');
  assert.equal(report.driver, 'wasapi');
  assert.ok(samples.length > 0 && samples.every(sample => sample.pid === report.fluidSynthPid), 'All meter samples belong to the spawned synth');
  for (const style of Object.keys(STYLES)) {
    for (const variation of ['A', 'B', 'C', 'D']) {
      for (const harmony of CHORDS) assert.ok(report.scenarios.some(entry => entry.label === `${style}/${variation}/${harmony.name}`));
    }
    for (const section of ['intro', 'fill', 'break', 'ending', 'loop-wraps', 'loop-restart']) {
      assert.ok(report.scenarios.some(entry => entry.label === `${style}/${section}`));
    }
  }
  for (const entry of report.scenarios) {
    entry.meter = summarizePeaks(samples, entry.begin + 80, entry.end - 50);
    assertAudibleWindow(entry.meter, entry.label);
    if (entry.quality) {
      const trace = events.filter(event => event.run === entry.run && event.expectedAt >= entry.begin - 1 && event.expectedAt < entry.end - 1);
      entry.bassNotes = assertChordSubmissions(entry, trace);
    }
  }
  assert.equal(report.stops.length, 10);
  for (const entry of report.stops) {
    Object.assign(entry, summarizePeaks(samples, entry.begin, entry.end));
    assertSilentWindow(entry, entry.label);
  }
  report.reanalysis = { verifiedAt: new Date().toISOString(), passed: true,
    command: 'node scripts\\verify-live-arranger.js --analyze',
    description: 'Rechecked saved real-session evidence with dither-rejecting signal count and exact MIDI pattern/pitch/subdivision assertions. No new playback or inferred audio was generated.' };
  await fs.writeFile(path.join(OUTPUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved real WASAPI evidence rechecked: ${report.scenarios.length} scenes; 36 exact chord/variation traces; ${report.stops.length} stops.`);
}
if (require.main === module) (process.argv.includes('--analyze') ? recheckSavedEvidence() : main())
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { summarizePeaks, assertAudibleWindow, assertSilentWindow, assertChordSubmissions, timingSummary };
