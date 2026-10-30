'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ArrangerEngine } = require('../src/arranger/engine');
const { QUALITIES, chord, recognize } = require('../src/arranger/chords');
const { STYLES } = require('../src/arranger/styles');

class Clock {
  time = 0;
  id = 0;
  jobs = new Map();
  now = () => this.time;
  setTimeout = (fn, delay) => { const id = ++this.id; this.jobs.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = id => this.jobs.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    let count = 0;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end + 1e-7) break;
      assert.ok(++count < 20000, 'bounded deterministic timer work');
      this.time = Math.max(this.time, next[1].at);
      this.jobs.delete(next[0]);
      await next[1].fn();
    }
    this.time = Math.max(end, this.time);
  }
}
class Audio extends EventEmitter {
  state = 'ready';
  calls = [];
  fail = null;
  getStatus() { return { state: this.state }; }
  async command(type, args) {
    this.calls.push({ type, ...args });
    if (this.fail === type) throw new Error('Backend failed');
  }
  noteOn(args) { return this.command('on', args); }
  noteOff(args) { return this.command('off', args); }
  programChange(args) { return this.command('program', args); }
  setVolume(args) { return this.command('volume', args); }
  allNotesOff(args) { return this.command('panic', args); }
}
function setup(styleId = 'pop') {
  const clock = new Clock();
  const audio = new Audio();
  const engine = new ArrangerEngine({ audio, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  engine.configure({ enabled: true, styleId, tempo: 120 });
  return { engine, clock, audio };
}
function play(engine, notes = [48, 52, 55]) { engine.clearInput(); notes.forEach(note => engine.noteOn(note)); }
const progression = (beatsPerBar = 4) => ({ version: 1, beatsPerBar, lengthBars: 1,
  events: [{ beat: 0, root: 0, quality: 'major' }, { beat: 2, root: 2, quality: 'minor' }] });

test('every chord quality in every root and inversion, including doubled notes', () => {
  for (const [quality, intervals] of Object.entries(QUALITIES)) {
    for (let root = 0; root < 12; root++) {
      for (let inversion = 0; inversion < intervals.length; inversion++) {
        const notes = intervals.map((interval, index) => 24 + root + interval + (index < inversion ? 12 : 0));
        notes.push(notes[0] + 12);
        const recognized = recognize(notes, chord(root, quality));
        assert.deepEqual(recognized, chord(root, quality));
      }
    }
  }
  assert.equal(recognize([48]), null);
  assert.equal(recognize([48, 55]), null);
  assert.equal(recognize([48, 49, 50]), null);
  assert.equal(recognize([48, 50, 55]).quality, 'sus2');
  assert.equal(recognize([43, 48, 50]).quality, 'sus4');
  assert.equal(recognize([52, 56, 60]).root, 4);
});

test('recognition gating, C5 split, release latch and detached snapshots', () => {
  const { engine } = setup();
  play(engine);
  assert.equal(engine.snapshot().chord.name, 'C');
  [48, 52, 55].forEach(note => engine.noteOff(note));
  engine.noteOn(50);
  engine.noteOn(72); engine.noteOn(76); engine.noteOn(79);
  assert.equal(engine.snapshot().chord.name, 'C');
  engine.clearInput();
  assert.equal(engine.held.size, 0);
  const state = engine.snapshot(); state.chord.intervals[0] = 99;
  assert.equal(engine.snapshot().chord.intervals[0], 0);
  engine.configure({ enabled: false });
  play(engine, [50, 53, 57]);
  assert.equal(engine.snapshot().chord.name, 'C');
});

test('all original styles have distinct mains, whole-bar specials and bounded valid events', () => {
  const signatures = new Set();
  for (const style of Object.values(STYLES)) {
    assert.equal(Object.keys(style.patterns).length, 8);
    for (const [section, pattern] of Object.entries(style.patterns)) {
      assert.equal(pattern.bars, ['intro', 'ending'].includes(section) ? 2 : 1);
      assert.ok(pattern.events.some(event => event.channel === 1));
      assert.ok(pattern.events.some(event => event.channel === 9));
      assert.ok(pattern.events.length < 100);
      for (const event of pattern.events) {
        assert.ok(Number.isInteger(event.step) && event.step >= 0 && event.step < style.beatsPerBar * 4 * pattern.bars);
        assert.ok(event.duration > 0 && event.duration <= style.beatsPerBar * 4);
      }
      const signature = JSON.stringify(pattern);
      assert.ok(!signatures.has(signature), `${style.id} ${section} is genuinely distinct`);
      signatures.add(signature);
    }
  }
});

test('drums start without a chord; chords enter only on whole beats; stop isolates channels', async () => {
  const { engine, clock, audio } = setup();
  await engine.start();
  assert.ok(audio.calls.some(call => call.type === 'on' && call.channel === 9));
  assert.ok(!audio.calls.some(call => call.type === 'on' && call.channel === 1));
  await clock.advance(150);
  play(engine);
  assert.equal(engine.snapshot().chord, null);
  await clock.advance(349);
  assert.equal(engine.snapshot().chord, null);
  await clock.advance(1);
  assert.equal(engine.snapshot().chord.name, 'C');
  await clock.advance(500);
  assert.ok(audio.calls.some(call => call.type === 'on' && call.channel === 1));
  await engine.stop();
  assert.equal(clock.jobs.size, 0);
  assert.equal(engine.offs.length, 0);
  assert.deepEqual(audio.calls.filter(call => call.type === 'panic').map(call => call.channel), [1, 9]);
  assert.ok(audio.calls.every(call => [1, 9].includes(call.channel)));
  const count = audio.calls.length;
  await clock.advance(10000);
  assert.equal(audio.calls.length, count);
});

test('intro two bars, section requests next bar, fill/break return, ending stops after two bars', async () => {
  const { engine, clock } = setup('waltz');
  play(engine);
  await engine.start({ intro: true });
  await clock.advance(2999); assert.equal(engine.section, 'intro');
  await clock.advance(1); assert.equal(engine.section, 'A');
  engine.requestSection('C');
  await clock.advance(1499); assert.equal(engine.section, 'A');
  await clock.advance(1); assert.equal(engine.section, 'C');
  engine.requestSection('fill');
  await clock.advance(1500); assert.equal(engine.section, 'fill');
  await clock.advance(1500); assert.equal(engine.section, 'C');
  engine.requestSection('break');
  await clock.advance(1500); assert.equal(engine.section, 'break');
  await clock.advance(1500); assert.equal(engine.section, 'C');
  engine.requestSection('ending');
  await clock.advance(1500); assert.equal(engine.section, 'ending');
  await clock.advance(2999); assert.equal(engine.running, true);
  await clock.advance(1); assert.equal(engine.running, false);
  assert.equal(clock.jobs.size, 0);
});

test('style changes require stop, tempo bounds and phase-preserving live tempo changes', async () => {
  const { engine, clock } = setup();
  await engine.start();
  assert.throws(() => engine.configure({ styleId: 'rock' }), /Stop transport/);
  assert.equal(engine.styleId, 'pop');
  for (const tempo of [39, 241, NaN, Infinity, '120']) assert.throws(() => engine.configure({ tempo }), /Tempo/);
  await clock.advance(62.5);
  engine.configure({ tempo: 240 });
  await clock.advance(31.24); assert.equal(engine.step, 1);
  await clock.advance(0.01); assert.equal(engine.step, 2);
  await clock.advance(187.5); assert.equal(engine.beat, 1);
  await engine.stop();
  engine.configure({ styleId: 'rock' }); assert.equal(engine.tempo, 126);
  engine.configure({ tempo: 40 }); assert.equal(engine.tempo, 40);
});

test('absolute deadlines do not accumulate command latency and excessive lateness stops safely', async () => {
  const { engine, clock, audio } = setup();
  const original = audio.command.bind(audio);
  audio.command = async (...args) => { clock.time += 3; return original(...args); };
  await engine.start();
  const anchor = engine.nextTime - 125;
  await clock.advance(3000 - (clock.time - anchor));
  assert.equal(engine.step, 25);
  assert.equal(engine.nextTime, anchor + 3125);
  clock.time += 2000;
  await clock.advance(0);
  assert.equal(engine.running, false);
  assert.match(engine.error, /overrun/);
  assert.equal(clock.jobs.size, 0);
});

test('recording arms next bar, changes are beat quantized and export is isolated', async () => {
  const { engine, clock } = setup();
  play(engine);
  await engine.start();
  engine.recordStart();
  await clock.advance(1999);
  assert.equal(engine.recordOrigin, null);
  await clock.advance(1);
  assert.equal(engine.recordOrigin, 4);
  await clock.advance(130);
  play(engine, [50, 53, 57]);
  await clock.advance(370);
  engine.recordStop();
  const result = engine.exportProgression();
  assert.deepEqual(result, { version: 1, beatsPerBar: 4, lengthBars: 1,
    events: [{ beat: 0, root: 0, quality: 'major' }, { beat: 1, root: 2, quality: 'minor' }] });
  result.events[0].root = 9;
  assert.equal(engine.exportProgression().events[0].root, 0);
  engine.recordStart();
  await engine.stop();
  assert.equal(engine.recording, false);
  assert.equal(engine.exportProgression().lengthBars, 1);
});

test('recording is bounded at 128 whole bars and at most 512 events', async () => {
  const { engine, clock } = setup();
  engine.configure({ tempo: 240 });
  play(engine);
  await engine.start(); engine.recordStart();
  await clock.advance(129000);
  assert.equal(engine.recording, false);
  assert.equal(engine.exportProgression().lengthBars, 128);
  assert.ok(engine.exportProgression().events.length <= 512);
  await engine.stop();
});

test('strict persisted schema validation rejects hostile, over-limit and malformed documents atomically', () => {
  const { engine } = setup();
  engine.importProgression(progression());
  const base = engine.exportProgression();
  const bad = [null, [], {}, { ...base, version: 2 }, { ...base, beatsPerBar: 3 },
    { ...base, lengthBars: 129 }, { ...base, lengthBars: 0 }, { ...base, command: 'quit' },
    { ...base, events: Array(513).fill(base.events[0]) },
    ...[-1, 4, 0.5, NaN].map(beat => ({ ...base, events: [{ beat, root: 0, quality: 'major' }] })),
    ...[-1, 12, 0.2].map(root => ({ ...base, events: [{ beat: 0, root, quality: 'major' }] })),
    ...['__proto__', 'constructor', 'major\nnoteon 0 60 127'].map(quality => ({ ...base, events: [{ beat: 0, root: 0, quality }] })),
    { ...base, events: [base.events[1], base.events[0]] }, { ...base, events: [base.events[0], base.events[0]] },
    JSON.parse('{"version":1,"beatsPerBar":4,"lengthBars":1,"events":[],"__proto__":{}}'),
    Object.assign(Object.create({ unsafe: true }), base),
    { ...base, get events() { throw new Error('getter executed'); } },
    { ...base, events: new Array(2) }];
  for (const document of bad) {
    assert.throws(() => engine.importProgression(document));
    assert.deepEqual(engine.exportProgression(), base);
  }
  engine.configure({ styleId: 'waltz' });
  assert.equal(engine.exportProgression(), null);
});

test('loops restart position zero, ignore live input, and resume held recognition when disabled', async () => {
  const { engine, clock } = setup();
  engine.importProgression(progression());
  engine.setLoop(true);
  play(engine, [53, 57, 60]);
  await engine.start();
  assert.equal(engine.chord.name, 'C');
  await clock.advance(1000); assert.equal(engine.chord.name, 'Dm');
  play(engine, [55, 59, 62]);
  await clock.advance(1000); assert.equal(engine.chord.name, 'C');
  engine.setLoop(false);
  await clock.advance(500); assert.equal(engine.chord.name, 'G');
  engine.setLoop(true);
  await clock.advance(1499); assert.equal(engine.chord.name, 'G');
  await clock.advance(1); assert.equal(engine.chord.name, 'C');
  assert.throws(() => engine.recordStart(), /Disable looping/);
  await engine.stop(); await engine.start();
  assert.equal(engine.chord.name, 'C');
  await engine.stop();
});

test('loop with delayed first event has no stale bass before it; empty loops remain drums only', async () => {
  const { engine, clock } = setup();
  play(engine);
  engine.importProgression({ version: 1, beatsPerBar: 4, lengthBars: 1, events: [{ beat: 2, root: 4, quality: 'minor' }] });
  engine.setLoop(true); await engine.start(); assert.equal(engine.chord, null);
  await clock.advance(1000); assert.equal(engine.chord.name, 'Em');
  await clock.advance(1000); assert.equal(engine.chord, null);
  await engine.stop();
});

test('audio loss cancels scheduling without calling unavailable backend; never auto-restarts', async () => {
  const { engine, clock, audio } = setup();
  play(engine); await engine.start(); engine.recordStart();
  const count = audio.calls.length;
  audio.state = 'error'; audio.emit('status', { state: 'error', message: 'Device lost' });
  await clock.advance(5000);
  assert.equal(audio.calls.length, count);
  assert.equal(engine.running, false); assert.equal(engine.recording, false);
  assert.equal(clock.jobs.size, 0); assert.equal(engine.offs.length, 0);
  assert.equal(engine.error, 'Device lost');
  audio.state = 'ready'; audio.emit('status', { state: 'ready' });
  assert.equal(engine.running, false);
});

test('backend rejections and startup failure are handled without unhandled promises', async () => {
  for (const fail of ['program', 'volume', 'on', 'off', 'panic']) {
    const { engine, clock, audio } = setup();
    if (['program', 'volume', 'on'].includes(fail)) audio.fail = fail;
    await engine.start();
    audio.fail = fail;
    if (fail === 'off') await clock.advance(125);
    if (fail === 'panic') await engine.stop();
    assert.equal(engine.running, false, fail);
    assert.match(engine.error, /Backend failed/);
    assert.equal(clock.jobs.size, 0);
  }
});

test('start requirements, cancellation during startup and disable while running', async () => {
  const { engine, audio, clock } = setup();
  await engine.configure({ enabled: false });
  await assert.rejects(engine.start(), /Enable/);
  engine.configure({ enabled: true }); audio.state = 'stopped';
  await assert.rejects(engine.start(), /not ready/);
  audio.state = 'ready';
  let resolve;
  audio.programChange = () => new Promise(done => { resolve = done; });
  const starting = engine.start();
  await Promise.resolve();
  await engine.stop(); resolve(); await starting;
  assert.equal(engine.running, false); assert.equal(clock.jobs.size, 0);
  audio.programChange = args => audio.command('program', args);
  await engine.start();
  await engine.configure({ enabled: false });
  assert.equal(engine.running, false); assert.equal(clock.jobs.size, 0);
});

test('all unambiguous inverted chords are recognized through the public note API', () => {
  for (const [quality, intervals] of Object.entries(QUALITIES)) {
    if (['aug', 'sus2', 'sus4'].includes(quality)) continue;
    for (let inversion = 0; inversion < intervals.length; inversion++) {
      const { engine } = setup();
      const notes = intervals.map((interval, index) => 36 + interval + (index < inversion ? 12 : 0)).sort((a, b) => a - b);
      play(engine, notes);
      assert.equal(engine.chord.quality, quality);
      assert.equal(engine.chord.root, 0);
      notes.forEach(note => engine.noteOff(note));
      assert.equal(engine.chord.quality, quality, 'releasing an inversion preserves its full quality');
    }
  }
});

test('scheduled notes release within their duration and same-pitch retriggers never overlap', async () => {
  for (const styleId of ['pop', 'rock', 'waltz']) {
    const { engine, audio, clock } = setup(styleId);
    const active = new Set();
    const command = audio.command.bind(audio);
    audio.command = async (type, args) => {
      const key = `${args.channel}:${args.note}`;
      if (type === 'on') { assert.ok(!active.has(key), `overlapping ${key}`); active.add(key); }
      if (type === 'off') { assert.ok(active.has(key), `unpaired off ${key}`); active.delete(key); }
      if (type === 'panic') for (const note of active) if (note.startsWith(`${args.channel}:`)) active.delete(note);
      return command(type, args);
    };
    play(engine); engine.requestSection('D'); await engine.start();
    await clock.advance(8000); await engine.stop();
    assert.equal(active.size, 0);
    assert.ok(audio.calls.some(call => call.type === 'off' && call.channel === 1));
    assert.ok(audio.calls.some(call => call.type === 'off' && call.channel === 9));
  }
});

test('moderate timer lateness catches up to the original phase without losing note-offs', async () => {
  const { engine, clock, audio } = setup();
  play(engine); await engine.start();
  clock.time = 600;
  await clock.advance(0);
  assert.equal(engine.running, true);
  assert.equal(engine.step, 5);
  assert.equal(engine.nextTime, 625);
  assert.equal(clock.jobs.size, 1);
  assert.ok(audio.calls.some(call => call.type === 'off'));
  await engine.stop();
});

test('stopping during an in-flight tick cancels the remainder and prevents rescheduling', async () => {
  const { engine, clock, audio } = setup();
  play(engine); await engine.start();
  let release;
  const noteOn = audio.noteOn.bind(audio);
  audio.noteOn = async args => {
    await noteOn(args);
    await new Promise(resolve => { release = resolve; });
  };
  const advancing = clock.advance(250);
  for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, 'function');
  const stopping = engine.stop();
  await release();
  await advancing; await stopping;
  assert.equal(engine.running, false);
  assert.equal(engine.offs.length, 0);
  assert.equal(clock.jobs.size, 0);
});

test('import and recording preconditions cannot alter running transport or existing progression', async () => {
  const { engine } = setup();
  assert.throws(() => engine.recordStart(), /Start transport/);
  assert.throws(() => engine.setLoop(true), /progression/);
  assert.throws(() => engine.setLoop('true'), /boolean/);
  engine.importProgression(progression());
  await engine.start();
  assert.throws(() => engine.importProgression(progression()), /Stop transport/);
  assert.equal(engine.running, true);
  assert.deepEqual(engine.exportProgression(), progression());
  engine.recordStart();
  assert.throws(() => engine.setLoop(true), /finished progression/);
  await engine.stop();
});

test('steady state events are beat-rate, not emitted for every MIDI command', async () => {
  const { engine, clock } = setup();
  engine.configure({ tempo: 240 });
  let events = 0;
  engine.on('state', () => events++);
  await engine.start();
  const start = events;
  for (let i = 0; i < 100; i++) { engine.noteOn(84); engine.noteOff(84); }
  await clock.advance(1000);
  assert.ok(events - start <= 5);
  assert.doesNotThrow(() => JSON.stringify(engine.snapshot()));
  await engine.stop();
});
