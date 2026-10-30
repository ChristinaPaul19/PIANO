'use strict';

const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { STYLES, styleList } = require('./styles');
const { chord, recognize } = require('./chords');
const { validate, MAX_BARS, MAX_EVENTS } = require('./progression');
const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));

class ArrangerEngine extends EventEmitter {
  constructor({ audio, now = () => performance.now(), setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
    super();
    if (!audio || typeof audio.getStatus !== 'function') throw new TypeError('AudioEngine is required');
    this.audio = audio;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.enabled = false;
    this.running = false;
    this.styleId = 'pop';
    this.tempo = STYLES.pop.defaultTempo;
    this.variation = 'A';
    this.section = 'A';
    this.queuedSection = null;
    this.bar = 0;
    this.beat = 0;
    this.chord = null;
    this.pendingChord = null;
    this.held = new Set();
    this.recording = false;
    this.looping = false;
    this.loopOrigin = null;
    this.progression = null;
    this.error = null;
    this.timer = null;
    this.generation = 0;
    this.step = 0;
    this.sectionStart = 0;
    this.offs = [];
    this.cleaning = Promise.resolve();
    this.lastEmit = -Infinity;
    this.starting = false;
    this.audio.on('status', status => {
      if (status.state !== 'ready' && (this.running || this.starting)) {
        this.error = status.message || 'Audio engine is not ready';
        this._halt(false);
      }
    });
  }

  snapshot() {
    return { enabled: this.enabled, running: this.running, styleId: this.styleId, styles: styleList(), tempo: this.tempo,
      variation: this.variation, section: this.section, queuedSection: this.queuedSection, bar: this.bar, beat: this.beat,
      chord: clone(this.chord), recording: this.recording, looping: this.looping, progression: clone(this.progression), error: this.error };
  }
  _emit(force = true) {
    if (force || this.now() - this.lastEmit >= 50) {
      this.lastEmit = this.now();
      this.emit('state', this.snapshot());
    }
  }
  _reject(message) { this.error = message; this._emit(); throw new Error(message); }
  _ready() { return this.audio.getStatus().state === 'ready'; }
  get _style() { return STYLES[this.styleId]; }
  get _stepMs() { return 60000 / this.tempo / 4; }

  configure(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return this._reject('Invalid arranger configuration');
    const { enabled, styleId, tempo } = options;
    if (enabled !== undefined && typeof enabled !== 'boolean') return this._reject('enabled must be boolean');
    if (styleId !== undefined && (typeof styleId !== 'string' || !Object.hasOwn(STYLES, styleId))) return this._reject('Unknown style');
    if (tempo !== undefined && (!Number.isFinite(tempo) || tempo < 40 || tempo > 240)) return this._reject('Tempo must be from 40 to 240');
    if (styleId !== undefined && styleId !== this.styleId && (this.running || this.starting)) return this._reject('Stop transport before changing style');
    if (styleId !== undefined && styleId !== this.styleId) {
      this.styleId = styleId;
      this.tempo = this._style.defaultTempo;
      if (this.progression && this.progression.beatsPerBar !== this._style.beatsPerBar) {
        this.progression = null;
        this.looping = false;
      }
    }
    if (tempo !== undefined && tempo !== this.tempo) {
      const remaining = this.running ? Math.max(0, (this.nextTime - this.now()) / this._stepMs) : 0;
      this.tempo = tempo;
      if (this.running) {
        this.nextTime = this.now() + remaining * this._stepMs;
        if (this.timer !== null) { this.cancel(this.timer); this.timer = null; this._arm(this.generation); }
      }
    }
    this.error = null;
    if (enabled !== undefined) this.enabled = enabled;
    if (!this.enabled) { this.clearInput(); return this.stop(); }
    this._emit();
    return this.snapshot();
  }

  noteOn(note) {
    if (!this.enabled || !Number.isInteger(note) || note < 0 || note >= 72) return;
    this.held.add(note);
    this._recognize();
  }
  noteOff(note) { this.held.delete(note); }
  clearInput() { this.held.clear(); }
  _recognize() {
    if (this.looping) return;
    const found = recognize(this.held, this.pendingChord || this.chord);
    if (!found) return;
    if (this.running) this.pendingChord = found;
    else if (!this.chord || found.root !== this.chord.root || found.quality !== this.chord.quality) {
      this.chord = found;
      this._emit();
    }
  }

  async start({ intro = false } = {}) {
    if (typeof intro !== 'boolean') return this._reject('intro must be boolean');
    if (this.running || this.starting) return this.snapshot();
    if (!this.enabled) return this._reject('Enable arranger before starting');
    if (!this._ready()) return this._reject('Audio engine is not ready');
    const token = ++this.generation;
    this.starting = true;
    try {
      await this.cleaning;
      if (token !== this.generation) return this.snapshot();
      await this.audio.programChange({ channel: 1, program: 33 });
      if (token !== this.generation) return this.snapshot();
      await this.audio.setVolume({ channel: 1, value: 100 });
      if (token !== this.generation) return this.snapshot();
      await this.audio.setVolume({ channel: 9, value: 100 });
      if (token !== this.generation) return this.snapshot();
      this.running = true;
      this.starting = false;
      this.error = null;
      this.step = 0;
      this.bar = 0;
      this.beat = 0;
      this.sectionStart = 0;
      this.section = intro ? 'intro' : this.variation;
      this.queuedSection = null;
      this.loopOrigin = this.looping ? 0 : null;
      this.nextTime = this.now();
      this._emit();
      await this._tick(token);
    } catch (error) { if (token === this.generation) await this._fault(error); }
    return this.snapshot();
  }

  stop() { return this._halt(true); }
  _halt(cleanAudio) {
    ++this.generation;
    this.running = false;
    this.starting = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (this.recording) this._finishRecording();
    this.queuedSection = null;
    this.pendingChord = null;
    this.loopOrigin = null;
    this.offs = [];
    this._emit();
    // Never send a global panic: channel zero belongs to the live keyboard.
    const previous = this.cleaning;
    this.cleaning = previous.then(async () => {
      if (!cleanAudio || !this._ready()) return;
      for (const channel of [1, 9]) {
        if (!this._ready()) break;
        try { await this.audio.allNotesOff({ channel }); }
        catch (error) { this.error = error.message || String(error); this._emit(); }
      }
    });
    return this.cleaning.then(() => this.snapshot());
  }
  async _fault(error) {
    this.error = error.message || String(error);
    await this._halt(true);
  }
  requestSection(section) {
    if (!['A', 'B', 'C', 'D', 'intro', 'fill', 'break', 'ending'].includes(section)) return this._reject('Unknown section');
    if (this.running) this.queuedSection = section;
    else {
      if (!'ABCD'.includes(section)) return this._reject('Start transport before requesting a special section');
      this.variation = section;
      this.section = section;
    }
    this._emit();
    return this.snapshot();
  }

  _arm(token) {
    if (!this.running || token !== this.generation) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      return this._tick(token).catch(error => token === this.generation ? this._fault(error) : undefined);
    }, Math.max(0, this.nextTime - this.now()));
  }
  async _tick(token) {
    if (!this.running || token !== this.generation) return;
    // At most eight sixteenth-note positions may be late; never replay an unbounded backlog.
    if (this.now() - this.nextTime > this._stepMs * 8) throw new Error('Arranger clock overrun; transport stopped');
    if (this.now() < this.nextTime) { this._arm(token); return; }
    const step = this.step;
    const stepsPerBar = this._style.beatsPerBar * 4;
    this.bar = Math.floor(step / stepsPerBar);
    this.beat = Math.floor(step / 4) % this._style.beatsPerBar;
    let changed = false;
    if (step % stepsPerBar === 0) {
      if (this.queuedSection) {
        this.section = this.queuedSection;
        if ('ABCD'.includes(this.section)) this.variation = this.section;
        this.queuedSection = null;
        this.sectionStart = step;
        changed = true;
      } else if (step - this.sectionStart >= this._style.patterns[this.section].bars * stepsPerBar) {
        if (this.section === 'ending') { await this.stop(); return; }
        if (!'ABCD'.includes(this.section)) { this.section = this.variation; changed = true; }
        this.sectionStart = step;
      }
      if (this.looping && this.loopOrigin === null) { this.loopOrigin = step / 4; changed = true; }
      if (this.recording && this.recordOrigin === null) {
        this.recordOrigin = step / 4;
        this.recordEvents = [];
        changed = true;
      }
    }
    if (step % 4 === 0) {
      if (this.looping && this.loopOrigin !== null) {
        const position = (step / 4 - this.loopOrigin) % (this.progression.lengthBars * this._style.beatsPerBar);
        if (position === 0 && this.chord !== null) { this.chord = null; changed = true; }
        const event = this.progression.events.find(value => value.beat === position);
        if (event) { this.chord = chord(event.root, event.quality); changed = true; }
      } else if (this.pendingChord) {
        if (!this.chord || this.pendingChord.root !== this.chord.root || this.pendingChord.quality !== this.chord.quality) {
          this.chord = this.pendingChord;
          changed = true;
        }
        this.pendingChord = null;
      }
      if (this.recording && this.recordOrigin !== null) {
        const position = step / 4 - this.recordOrigin;
        if (position >= MAX_BARS * this._style.beatsPerBar) { this._finishRecording(); changed = true; }
        else if (this.chord) {
          const last = this.recordEvents.at(-1);
          if (!last || last.root !== this.chord.root || last.quality !== this.chord.quality) {
            if (this.recordEvents.length >= MAX_EVENTS) { this._finishRecording(); changed = true; }
            else this.recordEvents.push({ beat: position, root: this.chord.root, quality: this.chord.quality });
          }
        }
      }
    }
    this.nextTime += this._stepMs;
    this.step++;
    const due = this.offs.filter(event => event.off <= step);
    this.offs = this.offs.filter(event => event.off > step);
    for (const event of due) {
      if (token !== this.generation) return;
      await this.audio.noteOff({ channel: event.channel, note: event.note });
    }
    const pattern = this._style.patterns[this.section];
    const position = (step - this.sectionStart) % (pattern.bars * stepsPerBar);
    for (const event of pattern.events.filter(value => value.step === position)) {
      if (token !== this.generation) return;
      if (event.channel === 1 && !this.chord) continue;
      const note = event.channel === 9 ? event.note
        : 36 + this.chord.root + this.chord.intervals[event.degree % this.chord.intervals.length];
      const duplicate = this.offs.find(value => value.channel === event.channel && value.note === note);
      if (duplicate) {
        await this.audio.noteOff({ channel: event.channel, note });
        this.offs = this.offs.filter(value => value !== duplicate);
        if (token !== this.generation) return;
      }
      this.offs.push({ channel: event.channel, note, off: step + event.duration });
      await this.audio.noteOn({ channel: event.channel, note, velocity: event.velocity });
    }
    if (token !== this.generation) return;
    if (step % 4 === 0 || changed) this._emit(changed);
    this._arm(token);
  }

  recordStart() {
    if (!this.running) return this._reject('Start transport before recording');
    if (this.looping) return this._reject('Disable looping before recording');
    if (this.recording) return this.snapshot();
    this.recording = true;
    this.recordOrigin = null;
    this.recordEvents = [];
    this._emit();
    return this.snapshot();
  }
  _finishRecording() {
    const beats = this.recordOrigin === null ? 0 : Math.max(0, this.step / 4 - this.recordOrigin);
    const lengthBars = Math.min(MAX_BARS, Math.max(1, Math.ceil(beats / this._style.beatsPerBar)));
    this.progression = { version: 1, beatsPerBar: this._style.beatsPerBar, lengthBars,
      events: this.recordEvents.filter(event => event.beat < lengthBars * this._style.beatsPerBar) };
    this.recording = false;
    this.recordOrigin = null;
  }
  recordStop() {
    if (this.recording) { this._finishRecording(); this._emit(); }
    return this.snapshot();
  }
  setLoop(enabled) {
    if (typeof enabled !== 'boolean') return this._reject('Loop flag must be boolean');
    if (enabled && (!this.progression || this.recording)) return this._reject('A finished progression is required for looping');
    if (enabled === this.looping) return this.snapshot();
    this.looping = enabled;
    this.loopOrigin = null;
    this.pendingChord = null;
    if (!enabled) this._recognize();
    this._emit();
    return this.snapshot();
  }
  exportProgression() { return clone(this.progression); }
  importProgression(document) {
    if (this.running || this.starting || this.recording) return this._reject('Stop transport before loading a progression');
    try { this.progression = validate(document, this._style.beatsPerBar); }
    catch (error) { return this._reject(error.message); }
    this.looping = false;
    this.error = null;
    this._emit();
    return this.snapshot();
  }
}
module.exports = { ArrangerEngine };
