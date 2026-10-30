'use strict';

const { EventEmitter } = require('node:events');

class AudioController extends EventEmitter {
  constructor(engine, { arranger = null, progressionStore = null } = {}) {
    super();
    this.engine = engine;
    this.arranger = arranger;
    this.progressionStore = progressionStore;
    this.noteRoutes = new Map();
    if (arranger) arranger.on('state', (state) => this.emit('arranger', state));
    this.initializing = null;
    this.queue = Promise.resolve();
    this.controls = { program: 0, volume: 100, sustain: false, pitchBend: 0 };
    engine.on('status', (status) => {
      if (status.state !== 'ready') {
        this.noteRoutes.clear();
        if (this.arranger) this.arranger.clearInput();
      }
      this.emit('status', status);
    });
  }

  snapshot() {
    return {
      status: this.engine.getStatus(),
      instruments: this.engine.getStatus().state === 'ready' ? this.engine.listInstruments() : [],
      controls: { ...this.controls },
      arranger: this.arranger ? this.arranger.snapshot() : null
    };
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    if (this.engine.getStatus().state === 'ready') return this.snapshot();
    this.initializing = (async () => {
      await this.engine.initialize();
      this.controls = { program: 0, volume: 100, sustain: false, pitchBend: 0 };
      await this.engine.programChange({ channel: 0, program: 0 });
      await this.engine.setVolume({ channel: 0, value: 100 });
      await this.engine.sustain({ channel: 0, enabled: false });
      await this.engine.pitchBend({ channel: 0, value: 0 });
      return this.snapshot();
    })();
    try {
      return await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async silenceKeyboard() {
    this.noteRoutes.clear();
    if (this.arranger) this.arranger.clearInput();
    this.controls.sustain = false;
    this.controls.pitchBend = 0;
    if (this.engine.getStatus().state !== 'ready') return;
    await this.engine.sustain({ channel: 0, enabled: false });
    await this.engine.allNotesOff({ channel: 0 });
    await this.engine.pitchBend({ channel: 0, value: 0 });
  }

  async silence() {
    try {
      if (this.arranger) await this.arranger.stop();
    } finally {
      await this.silenceKeyboard();
    }
  }

  async noteOn({ note, velocity }) {
    if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isInteger(velocity) || velocity < 0 || velocity > 127) {
      throw new RangeError('MIDI note and velocity must be integers from 0 to 127.');
    }
    if (this.engine.getStatus().state !== 'ready') throw new Error('Audio engine is not ready.');
    if (velocity === 0) return this.noteOff({ note });
    const route = this.arranger && this.arranger.snapshot().enabled && note < 72 ? 'chord' : 'keyboard';
    if (route === 'chord') await this.arranger.noteOn(note);
    else await this.engine.noteOn({ channel: 0, note, velocity });
    this.noteRoutes.set(note, route);
  }

  async noteOff({ note }) {
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new RangeError('MIDI note must be an integer from 0 to 127.');
    const route = this.noteRoutes.get(note);
    this.noteRoutes.delete(note);
    if (route === 'chord') return this.arranger.noteOff(note);
    return this.engine.noteOff({ channel: 0, note });
  }

  async arrangerCommand(action, payload) {
    if (!this.arranger) throw new Error('Arranger is unavailable.');
    switch (action) {
      case 'arranger.configure':
        if (Object.hasOwn(payload, 'enabled') && typeof payload.enabled !== 'boolean') throw new TypeError('enabled must be boolean.');
        if (Object.hasOwn(payload, 'enabled') && payload.enabled !== this.arranger.snapshot().enabled) await this.silenceKeyboard();
        await this.arranger.configure(payload);
        break;
      case 'arranger.start':
        if (Object.hasOwn(payload, 'intro') && typeof payload.intro !== 'boolean') throw new TypeError('intro must be boolean.');
        await this.arranger.start(payload);
        break;
      case 'arranger.stop': await this.arranger.stop(); break;
      case 'arranger.section': await this.arranger.requestSection(payload.section); break;
      case 'arranger.recordStart': await this.arranger.recordStart(); break;
      case 'arranger.recordStop': await this.arranger.recordStop(); break;
      case 'arranger.loop': await this.arranger.setLoop(payload.enabled); break;
      case 'arranger.save': {
        if (!this.progressionStore) throw new Error('Progression storage is unavailable.');
        const document = this.arranger.exportProgression();
        if (!document) throw new Error('Record a progression before saving.');
        await this.progressionStore.save(document);
        break;
      }
      case 'arranger.load':
        if (!this.progressionStore) throw new Error('Progression storage is unavailable.');
        await this.arranger.importProgression(await this.progressionStore.load());
        break;
      default: throw new Error('Unsupported arranger operation.');
    }
    return this.arranger.snapshot();
  }

  dispatch(action, payload = {}) {
    const operation = this.queue.then(() => this.perform(action, payload));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async perform(action, payload) {
    if (typeof action === 'string' && action.startsWith('arranger.')) return this.arrangerCommand(action, payload);
    switch (action) {
      case 'snapshot': return this.snapshot();
      case 'initialize': return this.initialize();
      case 'shutdown':
        if (this.initializing) await this.initializing.catch(() => {});
        try {
          if (this.arranger) await this.arranger.stop();
        } finally {
          this.noteRoutes.clear();
          await this.engine.shutdown();
        }
        return this.snapshot();
      case 'noteOn': return this.noteOn(payload);
      case 'noteOff': return this.noteOff(payload);
      case 'program':
        if (!Number.isInteger(payload.program) || payload.program < 0 || payload.program > 127) {
          throw new RangeError('Program must be an integer from 0 to 127.');
        }
        await this.silenceKeyboard();
        await this.engine.programChange({ channel: 0, program: payload.program });
        this.controls.program = payload.program;
        return this.snapshot();
      case 'volume':
        await this.engine.setVolume({ channel: 0, value: payload.value });
        this.controls.volume = payload.value;
        return;
      case 'sustain':
        await this.engine.sustain({ channel: 0, enabled: payload.enabled });
        this.controls.sustain = payload.enabled;
        return;
      case 'pitchBend':
        await this.engine.pitchBend({ channel: 0, value: payload.value });
        this.controls.pitchBend = payload.value;
        return;
      case 'silence': await this.silence(); return this.snapshot();
      case 'releaseKeyboard': await this.silenceKeyboard(); return this.snapshot();
      default: throw new Error('Unsupported audio operation.');
    }
  }
}

module.exports = { AudioController };
