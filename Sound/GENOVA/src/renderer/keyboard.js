'use strict';

(() => {
  const mapping = Object.freeze([
    ['KeyA', 'A'], ['KeyW', 'W'], ['KeyS', 'S'], ['KeyE', 'E'], ['KeyD', 'D'],
    ['KeyF', 'F'], ['KeyT', 'T'], ['KeyG', 'G'], ['KeyY', 'Y'], ['KeyH', 'H'],
    ['KeyU', 'U'], ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyO', 'O'], ['KeyL', 'L'],
    ['KeyP', 'P'], ['Semicolon', ';']
  ].map(Object.freeze));
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (note) => `${names[note % 12]}${Math.floor(note / 12) - 1}`;

  class HeldNotes {
    constructor({ noteOn, noteOff, changed }) {
      this.sources = new Map();
      this.notes = new Map();
      this.noteOn = noteOn;
      this.noteOff = noteOff;
      this.changed = changed;
    }

    press(source, note, velocity) {
      if (this.sources.has(source)) return;
      if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
        throw new RangeError('Invalid keyboard note or velocity.');
      }
      this.sources.set(source, note);
      const count = this.notes.get(note) || 0;
      this.notes.set(note, count + 1);
      if (count === 0) this.noteOn(note, velocity);
      this.changed(this.notes);
    }

    release(source) {
      if (!this.sources.has(source)) return;
      const note = this.sources.get(source);
      this.sources.delete(source);
      const count = this.notes.get(note) - 1;
      if (count === 0) {
        this.notes.delete(note);
        this.noteOff(note);
      } else {
        this.notes.set(note, count);
      }
      this.changed(this.notes);
    }

    clear(sendNoteOff = true) {
      if (sendNoteOff) for (const note of this.notes.keys()) this.noteOff(note);
      this.sources.clear();
      this.notes.clear();
      this.changed(this.notes);
    }
  }

  const api = { mapping, noteName, HeldNotes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.GenovaKeyboard = Object.freeze(api);
})();
