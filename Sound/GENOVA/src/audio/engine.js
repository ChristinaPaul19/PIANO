'use strict';

const { EventEmitter } = require('node:events');
const { spawn: nodeSpawn } = require('node:child_process');
const { readFile, access } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function integer(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
  ]).finally(() => clearTimeout(timer));
}

/**
 * UI-independent FluidSynth shell client. config overrides values read from configPath.
 * File rendering: config: { audioDriver: 'file', audioFile: absoluteWavPath,
 * reverb: false, chorus: false }. No MIDI input device is opened.
 * Tests may inject a child_process.spawn-compatible spawn function and positive
 * startupTimeoutMs, commandTimeoutMs, shutdownTimeoutMs values.
 */
class AudioEngine extends EventEmitter {
  constructor({ configPath, config = {}, spawn = nodeSpawn, startupTimeoutMs = 15000,
    commandTimeoutMs = 3000, shutdownTimeoutMs = 3000 } = {}) {
    super();
    this.configPath = configPath;
    this.config = { ...config };
    this.spawn = spawn;
    for (const [name, value] of Object.entries({ startupTimeoutMs, commandTimeoutMs, shutdownTimeoutMs })) {
      integer(name, value, 1, 2147483647);
      this[name] = value;
    }
    this.status = { state: 'stopped' };
    this.instruments = [];
    this.context = null;
    this.initializing = null;
    this.stopping = null;
  }

  getStatus() {
    const pid = this.context && !this.context.closed ? this.context.child.pid : null;
    return { ...this.status, pid: Number.isInteger(pid) ? pid : null };
  }
  listInstruments() { return this.instruments.map(instrument => ({ ...instrument })); }

  _status(state, message) {
    this.status = message ? { state, message } : { state };
    this.emit('status', this.getStatus());
  }

  initialize() {
    if (this.stopping) return this.stopping.then(() => this.initialize());
    if (this.initializing) return this.initializing;
    if (this.status.state === 'ready') return Promise.resolve(this.getStatus());
    this.initializing = this._initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async _initialize() {
    this._status('starting');
    this.instruments = [];
    let context;
    try {
      if (this.context) await this._terminate(this.context);
      const fromFile = this.configPath
        ? JSON.parse((await readFile(this.configPath, 'utf8')).replace(/^\uFEFF/, '')) : {};
      const config = { ...fromFile, ...this.config };
      for (const key of ['fluidsynthExecutable', 'soundFont']) {
        if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) {
          throw new TypeError(`${key} must be an absolute path`);
        }
        await access(config[key]);
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(config.audioDriver || '')) throw new TypeError('Invalid audioDriver');
      integer('sampleRate', config.sampleRate, 8000, 192000);
      if (!Number.isFinite(config.gain) || config.gain < 0 || config.gain > 10) {
        throw new RangeError('gain must be between 0 and 10');
      }
      const args = ['-n', '-a', config.audioDriver, '-r', String(config.sampleRate), '-g', String(config.gain),
        '-o', 'synth.cpu-cores=1'];
      if (config.audioDriver === 'file') {
        if (typeof config.audioFile !== 'string' || !path.isAbsolute(config.audioFile)) {
          throw new TypeError('audioFile must be an absolute WAV path for the file driver');
        }
        args.push('-o', `audio.file.name=${config.audioFile}`, '-T', 'wav', '-O', 's16');
      }
      for (const [key, flag] of [['reverb', '-R'], ['chorus', '-C']]) {
        if (config[key] !== undefined) {
          if (typeof config[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
          args.push(flag, config[key] ? '1' : '0');
        }
      }
      args.push(config.soundFont);
      // shutdown can be requested while configuration is being read.
      if (this.status.state !== 'starting') throw new Error('Initialization cancelled');
      context = this._attach(this.spawn(config.fluidsynthExecutable, args, {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      }));
      this.context = context;
      const output = await this._send(context, 'inst 1', this.startupTimeoutMs);
      const presets = new Map();
      for (const line of output.split(/\r?\n/)) {
        const match = line.replace(/^(?:>\s*)+/, '').match(/^000-(\d{3})\s+(.+?)\s*$/);
        if (match && Number(match[1]) < 128) presets.set(Number(match[1]), match[2]);
      }
      if (!presets.size) throw new Error('SoundFont has no GM bank 0 presets');
      this.instruments = [...presets].sort((a, b) => a[0] - b[0]).map(([program, name]) => ({ program, name }));
      if (context.stopping || this.status.state !== 'starting') throw new Error('Initialization cancelled');
      this._status('ready');
      return this.getStatus();
    } catch (error) {
      if (this.status.state !== 'stopping') this._status('error', error.message);
      if (context) await this._terminate(context);
      throw error;
    }
  }

  _attach(child) {
    const context = { child, pending: null, tail: Promise.resolve(), closed: false, stopping: false, stderr: '' };
    context.close = new Promise(resolve => { context.resolveClose = resolve; });
    const fail = error => this._fail(context, error);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      const pending = context.pending;
      if (!pending) return;
      pending.output += data;
      if (pending.output.length > 1024 * 1024) return fail(new Error('FluidSynth response exceeded 1 MiB'));
      const index = pending.output.indexOf(pending.marker);
      if (index !== -1) {
        const output = pending.output.slice(0, index);
        clearTimeout(pending.timer);
        context.pending = null;
        if (/unknown command|invalid argument|failed|error:|cannot|not found/i.test(output)) {
          pending.reject(new Error(`FluidSynth rejected command: ${output.trim()}`));
        } else pending.resolve(output);
      }
    });
    child.stderr.on('data', data => { context.stderr = (context.stderr + data).slice(-4096); });
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      context.closed = true;
      context.resolveClose();
      if (!context.stopping) fail(new Error(`FluidSynth exited (${signal || code})${context.stderr ? `: ${context.stderr.trim()}` : ''}`));
      if (this.context === context) this.context = null;
    });
    return context;
  }

  _fail(context, error) {
    if (context.pending) {
      clearTimeout(context.pending.timer);
      context.pending.reject(error);
      context.pending = null;
    }
    if (context.stopping) return;
    context.stopping = true;
    if (this.context === context) {
      this.instruments = [];
      this._status('error', error.message);
    }
    if (!context.closed) context.child.kill();
  }

  _send(context, command, milliseconds = this.commandTimeoutMs) {
    const operation = context.tail.then(() => {
      if (context.stopping || context.closed || this.context !== context) throw new Error('Audio engine is not ready');
      return new Promise((resolve, reject) => {
        const marker = `GENOVA_${randomUUID().replace(/-/g, '')}`;
        const pending = { marker, output: '', resolve, reject };
        pending.timer = setTimeout(() => this._fail(context, new Error('FluidSynth command acknowledgment timed out')), milliseconds);
        context.pending = pending;
        try {
          context.child.stdin.write(`${command}\necho ${marker}\n`, error => {
            if (error) this._fail(context, error);
          });
        } catch (error) { this._fail(context, error); }
      });
    });
    // A rejected operation must not create an unhandled rejection on the queue tail.
    context.tail = operation.catch(() => {});
    return operation;
  }

  _control(command) {
    if (this.status.state !== 'ready' || !this.context) return Promise.reject(new Error('Audio engine is not ready'));
    return this._send(this.context, command).then(() => undefined);
  }

  async noteOn({ channel = 0, note, velocity } = {}) {
    integer('channel', channel, 0, 15); integer('note', note, 0, 127); integer('velocity', velocity, 0, 127);
    return this._control(`noteon ${channel} ${note} ${velocity}`);
  }
  async noteOff({ channel = 0, note } = {}) {
    integer('channel', channel, 0, 15); integer('note', note, 0, 127);
    return this._control(`noteoff ${channel} ${note}`);
  }
  async programChange({ channel = 0, program } = {}) {
    integer('channel', channel, 0, 15); integer('program', program, 0, 127);
    return this._control(`prog ${channel} ${program}`);
  }
  async sustain({ channel = 0, enabled } = {}) {
    integer('channel', channel, 0, 15);
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    return this._control(`cc ${channel} 64 ${enabled ? 127 : 0}`);
  }
  async setVolume({ channel = 0, value } = {}) {
    integer('channel', channel, 0, 15); integer('value', value, 0, 127);
    return this._control(`cc ${channel} 7 ${value}`);
  }
  async pitchBend({ channel = 0, value } = {}) {
    integer('channel', channel, 0, 15); integer('value', value, -8192, 8191);
    return this._control(`pitch_bend ${channel} ${value + 8192}`);
  }
  async allNotesOff({ channel } = {}) {
    if (channel !== undefined) integer('channel', channel, 0, 15);
    const channels = channel === undefined ? Array.from({ length: 16 }, (_, index) => index) : [channel];
    const commands = [];
    for (const midiChannel of channels) {
      commands.push(`cc ${midiChannel} 64 0`, `cc ${midiChannel} 123 0`, `cc ${midiChannel} 120 0`);
    }
    return this._control(commands.join('\n'));
  }

  shutdown() {
    if (this.stopping) return this.stopping;
    if (this.status.state === 'stopped' && !this.context) return Promise.resolve();
    this.stopping = this._shutdown().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async _shutdown() {
    this._status('stopping');
    try {
      if (this.context) await this._terminate(this.context);
      if (this.initializing) await this.initializing.catch(() => {});
      this.instruments = [];
      this._status('stopped');
    } catch (error) {
      this._status('error', error.message);
      throw error;
    }
  }

  _terminate(context) {
    if (!context.termination) context.termination = this._terminateProcess(context);
    return context.termination;
  }

  async _terminateProcess(context) {
    context.stopping = true;
    if (context.pending) {
      clearTimeout(context.pending.timer);
      context.pending.reject(new Error('Audio engine stopped'));
      context.pending = null;
    }
    if (!context.closed) {
      try { context.child.stdin.end('reset\nquit\n'); } catch { context.child.kill(); }
      try {
        await timeout(context.close, this.shutdownTimeoutMs, 'FluidSynth shutdown timed out');
      } catch {
        context.child.kill();
        await timeout(context.close, this.shutdownTimeoutMs, 'FluidSynth process could not be terminated');
      }
    }
    if (this.context === context) this.context = null;
  }
}

module.exports = { AudioEngine };
