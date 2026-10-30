'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { AudioEngine } = require('../src/audio/engine');

function fixture(options = {}) {
  const children = [];
  const calls = [];
  const spawn = (executable, args, spawnOptions) => {
    calls.push({ executable, args, spawnOptions });
    const child = new EventEmitter();
    child.pid = 10000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.commands = [];
    child.closed = false;
    child.close = code => {
      if (child.closed) return;
      child.closed = true;
      child.emit('close', code, null);
    };
    child.kill = () => { child.killed = true; if (!options.unkillable) setImmediate(() => child.close(1)); return true; };
    child.stdin = new Writable({
      write(buffer, encoding, callback) {
        const text = buffer.toString();
        child.commands.push(text);
        callback();
        if (text.includes('quit')) {
          if (!options.ignoreQuit) setImmediate(() => child.close(0));
          return;
        }
        if (options.noAck || child.noAck) return;
        const marker = text.match(/echo (GENOVA_\w+)/)[1];
        let output = '> ';
        if (text.startsWith('inst 1')) output += options.noPresets ? '128-000 Drums\n' :
          '000-000 Piano\n000-016 Organ\n000-048 Strings\n001-000 Other bank\n128-000 Drums\n';
        if (child.rejectCommand) output += 'unknown command\n';
        output += `> ${marker}\n> `;
        // Exercise both split acknowledgment tokens and multiple prompts per chunk.
        const split = output.length - 12;
        setImmediate(() => {
          child.stdout.write(output.slice(0, split));
          setImmediate(() => child.stdout.write(output.slice(split)));
        });
      }
    });
    children.push(child);
    if (options.spawnError) setImmediate(() => { child.emit('error', new Error('spawn failure')); child.close(-1); });
    return child;
  };
  const engine = new AudioEngine({
    config: { fluidsynthExecutable: process.execPath, soundFont: __filename, audioDriver: 'wasapi', sampleRate: 48000, gain: 0.2 },
    spawn, startupTimeoutMs: 100, commandTimeoutMs: 50, shutdownTimeoutMs: 30
  });
  return { engine, children, calls };
}

test('initializes once, filters actual GM presets, isolates snapshots and restarts', async () => {
  const { engine, children, calls } = fixture();
  const states = [];
  engine.on('status', status => { states.push(status.state); status.state = 'mutated'; });
  assert.equal(engine.initialize(), engine.initialize());
  assert.deepEqual(await engine.initialize(), { state: 'ready', pid: 10000 });
  assert.equal(children.length, 1);
  assert.equal(calls[0].spawnOptions.shell, false);
  assert.ok(calls[0].args.includes('-n'));
  assert.deepEqual(engine.listInstruments(), [{ program: 0, name: 'Piano' }, { program: 16, name: 'Organ' }, { program: 48, name: 'Strings' }]);
  engine.listInstruments()[0].name = 'mutated';
  assert.equal(engine.listInstruments()[0].name, 'Piano');
  engine.getStatus().state = 'mutated';
  assert.equal(engine.getStatus().state, 'ready');
  await engine.shutdown();
  await engine.shutdown();
  assert.equal(engine.getStatus().state, 'stopped');
  assert.deepEqual(engine.listInstruments(), []);
  await engine.initialize();
  assert.equal(children.length, 2);
  await engine.shutdown();
  assert.deepEqual(states, ['starting', 'ready', 'stopping', 'stopped', 'starting', 'ready', 'stopping', 'stopped']);
});

test('status exposes the current PID and clears it after crash or shutdown', async () => {
  const { engine, children } = fixture();
  const events = [];
  engine.on('status', status => events.push(status));
  assert.equal(engine.getStatus().pid, null);
  const first = await engine.initialize();
  assert.equal(first.pid, children[0].pid);
  assert.equal(events.at(-1).pid, first.pid);
  children[0].close(42);
  assert.equal(engine.getStatus().pid, null);
  assert.equal(events.at(-1).state, 'error');
  assert.equal(events.at(-1).pid, null);
  const restarted = await engine.initialize();
  assert.equal(restarted.pid, children[1].pid);
  assert.notEqual(restarted.pid, first.pid);
  assert.ok(Array.isArray(engine.listInstruments()));
  await engine.shutdown();
  assert.equal(engine.getStatus().pid, null);
  assert.equal(events.at(-1).pid, null);
});

test('serializes MIDI commands and translates signed bend, sustain, volume and panic', async () => {
  const { engine, children } = fixture();
  await engine.initialize();
  try {
    await Promise.all([
      engine.noteOn({ note: 60, velocity: 100 }), engine.noteOff({ note: 60 }),
      engine.programChange({ channel: 2, program: 48 }), engine.sustain({ enabled: true }),
      engine.sustain({ enabled: false }), engine.setVolume({ value: 127 }),
      engine.pitchBend({ value: -8192 }), engine.pitchBend({ value: 0 }), engine.pitchBend({ value: 8191 })
    ]);
    const commands = children[0].commands.slice(1).map(text => text.split('\n')[0]);
    assert.deepEqual(commands, ['noteon 0 60 100', 'noteoff 0 60', 'prog 2 48', 'cc 0 64 127', 'cc 0 64 0', 'cc 0 7 127',
      'pitch_bend 0 0', 'pitch_bend 0 8192', 'pitch_bend 0 16383']);
    await engine.allNotesOff();
    const panic = children[0].commands.at(-1);
    for (let channel = 0; channel < 16; channel++) {
      for (const controller of [64, 123, 120]) assert.ok(panic.includes(`cc ${channel} ${controller} 0\n`));
    }
  } finally { await engine.shutdown(); }
});

test('validates MIDI parameters and refuses writes before initialization', async () => {
  const { engine, children } = fixture();
  await assert.rejects(engine.noteOn({ note: 60, velocity: 100 }), /not ready/);
  const invalid = [
    () => engine.noteOn({ note: -1, velocity: 100 }), () => engine.noteOn({ note: 128, velocity: 100 }),
    () => engine.noteOn({ note: 60, velocity: 128 }), () => engine.noteOn({ note: 60 }),
    () => engine.noteOn({ channel: 16, note: 60, velocity: 1 }), () => engine.noteOff({ note: 1.5 }),
    () => engine.noteOff({ channel: -1, note: 60 }), () => engine.programChange({ program: '0' }),
    () => engine.programChange({ program: 128 }), () => engine.sustain({ enabled: 1 }),
    () => engine.setVolume({ value: NaN }), () => engine.setVolume({ value: -1 }),
    () => engine.pitchBend({ value: -8193 }), () => engine.pitchBend({ value: 8192 }),
    () => engine.noteOn(), () => engine.noteOff(), () => engine.programChange(),
    () => engine.sustain(), () => engine.setVolume(), () => engine.pitchBend()
  ];
  for (const action of invalid) await assert.rejects(action(), /must be/);
  assert.equal(children.length, 0);
});

test('invalid configuration fails without spawning and can be corrected', async () => {
  const { engine, children } = fixture();
  engine.config.sampleRate = 1;
  await assert.rejects(engine.initialize(), /sampleRate/);
  assert.equal(engine.getStatus().state, 'error');
  assert.equal(children.length, 0);
  engine.config.sampleRate = 48000;
  await engine.initialize();
  await engine.shutdown();
});

test('startup acknowledgment timeout kills process and rejects initialization', async () => {
  const { engine, children } = fixture({ noAck: true });
  await assert.rejects(engine.initialize(), /timed out/);
  assert.equal(children[0].killed, true);
  assert.equal(engine.getStatus().state, 'error');
  await engine.shutdown();
});

test('command timeout rejects pending and queued writes then supports restart', async () => {
  const { engine, children } = fixture();
  await engine.initialize();
  children[0].noAck = true;
  const results = await Promise.allSettled([engine.noteOn({ note: 60, velocity: 100 }), engine.noteOff({ note: 60 })]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.match(results[0].reason.message, /timed out/);
  assert.equal(engine.getStatus().state, 'error');
  await engine.initialize();
  assert.equal(children.length, 2);
  await engine.shutdown();
});

test('process crash rejects pending operations, clears instruments, and supports restart', async () => {
  const { engine, children } = fixture();
  await engine.initialize();
  children[0].noAck = true;
  const pending = engine.noteOn({ note: 60, velocity: 100 });
  const rejected = assert.rejects(pending, /exited/);
  await new Promise(resolve => setImmediate(resolve));
  children[0].close(42);
  await rejected;
  assert.equal(engine.getStatus().state, 'error');
  assert.deepEqual(engine.listInstruments(), []);
  await engine.initialize();
  await engine.shutdown();
});

test('spawn error is reported through status, not an unhandled error event', async () => {
  const { engine } = fixture({ spawnError: true });
  await assert.rejects(engine.initialize(), /spawn failure/);
  assert.equal(engine.getStatus().state, 'error');
  await engine.shutdown();
});

test('shutdown force kills an unresponsive process', async () => {
  const { engine, children } = fixture({ ignoreQuit: true });
  await engine.initialize();
  const first = engine.shutdown();
  assert.equal(first, engine.shutdown());
  await first;
  assert.equal(children[0].killed, true);
  assert.equal(engine.getStatus().state, 'stopped');
});

test('shutdown during initialization cancels it without spawning afterwards', async () => {
  const { engine, children } = fixture();
  const initializing = assert.rejects(engine.initialize(), /cancelled/);
  await engine.shutdown();
  await initializing;
  assert.equal(children.length, 0);
  assert.equal(engine.getStatus().state, 'stopped');
});

test('shutdown during acknowledgment cancels startup and restart waits for exit', async () => {
  const { engine, children } = fixture({ noAck: true });
  const rejected = assert.rejects(engine.initialize(), /stopped/);
  while (children.length === 0) await new Promise(resolve => setImmediate(resolve));
  const shuttingDown = engine.shutdown();
  await rejected;
  await shuttingDown;
  assert.equal(children[0].closed, true);
  assert.equal(engine.getStatus().state, 'stopped');
});

test('initialize waits for an ongoing shutdown before starting another child', async () => {
  const { engine, children } = fixture({ ignoreQuit: true });
  await engine.initialize();
  const shuttingDown = engine.shutdown();
  const restarting = engine.initialize();
  await shuttingDown;
  assert.equal((await restarting).state, 'ready');
  assert.equal(children.length, 2);
  assert.equal(children[0].closed, true);
  await engine.shutdown();
});

test('failed forced termination rejects instead of reporting a stopped process', async () => {
  const { engine, children } = fixture({ ignoreQuit: true, unkillable: true });
  await engine.initialize();
  await assert.rejects(engine.shutdown(), /could not be terminated/);
  assert.equal(engine.getStatus().state, 'error');
  children[0].close(1);
  await engine.shutdown();
});

test('stdin errors reject pending work and clear ready status', async () => {
  const { engine, children } = fixture();
  await engine.initialize();
  children[0].noAck = true;
  const pending = assert.rejects(engine.noteOn({ note: 60, velocity: 100 }), /broken pipe/);
  await new Promise(resolve => setImmediate(resolve));
  children[0].stdin.emit('error', new Error('broken pipe'));
  await pending;
  assert.equal(engine.getStatus().state, 'error');
  assert.deepEqual(engine.listInstruments(), []);
  await engine.shutdown();
});

test('unexpected excessive output terminates the process', async () => {
  const { engine, children } = fixture();
  await engine.initialize();
  children[0].noAck = true;
  const pending = assert.rejects(engine.noteOn({ note: 60, velocity: 100 }), /exceeded 1 MiB/);
  await new Promise(resolve => setImmediate(resolve));
  children[0].stdout.write('x'.repeat(1024 * 1024 + 1));
  await pending;
  assert.equal(children[0].killed, true);
  await engine.shutdown();
});

test('missing GM presets rejects initialization and closes the process', async () => {
  const { engine, children } = fixture({ noPresets: true });
  await assert.rejects(engine.initialize(), /no GM/);
  assert.equal(children[0].closed, true);
  await engine.shutdown();
});

test('shell command rejection rejects only that operation and queue recovers', async () => {
  const { engine, children } = fixture();
  await engine.initialize();
  children[0].rejectCommand = true;
  await assert.rejects(engine.noteOn({ note: 60, velocity: 100 }), /rejected command/);
  children[0].rejectCommand = false;
  await engine.noteOff({ note: 60 });
  assert.equal(engine.getStatus().state, 'ready');
  await engine.shutdown();
});
