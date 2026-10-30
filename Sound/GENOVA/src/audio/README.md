# FluidSynth engine

`require('./src/audio/engine')` exports `{ AudioEngine }`. This module uses only Node built-ins and has no Electron or UI dependency.

```javascript
const { AudioEngine } = require('./src/audio/engine');
const engine = new AudioEngine({ configPath: absoluteConfigPath });
engine.on('status', status => console.log(status));
await engine.initialize();
const instruments = engine.listInstruments();
await engine.programChange({ program: 0 });
await engine.noteOn({ note: 60, velocity: 100 });
await engine.noteOff({ note: 60 });
await engine.shutdown();
```

## API

- `initialize(): Promise<status>`: loads the configured SoundFont, acknowledges its actual instrument listing, and becomes ready. Concurrent calls share initialization. Calling again when ready is harmless. Calling after a crash or shutdown starts a fresh process. Initialization while shutdown is in progress waits for shutdown.
- `shutdown(): Promise<void>`: cancels pending operations, sends reset/quit, waits for exit, and force-kills if necessary. Repeated/concurrent calls are safe.
- `getStatus(): { state, pid, message? }`: defensive snapshot. `pid` is the current child process ID, or `null` when no child exists or it has closed. Status events and `initialize()` results include the same field. A restart supplies the new process ID. States: `stopped`, `starting`, `ready`, `stopping`, `error`.
- `listInstruments(): Array<{ program, name }>`: defensive snapshots parsed from the loaded SoundFont's `inst 1` output, bank 0 only, sorted by program 0–127. Other banks and drums are excluded. Empty before initialization, after shutdown, or on process failure. A partial GM SoundFont returns only its actual bank-0 presets; absence of all GM presets fails initialization.
- `noteOn({ channel = 0, note, velocity })`: note/velocity integers 0–127; velocity zero has MIDI note-off semantics.
- `noteOff({ channel = 0, note })`: note integer 0–127.
- `programChange({ channel = 0, program })`: program integer 0–127 (zero-based, not display numbers 1–128).
- `sustain({ channel = 0, enabled })`: strict boolean; sends CC64.
- `setVolume({ channel = 0, value })`: integer 0–127; sends channel CC7, not master gain.
- `pitchBend({ channel = 0, value })`: signed integer −8192–8191, translated to FluidSynth's 0–16383 shell representation. Zero centers pitch.
- `allNotesOff()`: releases sustain and sends all-notes-off plus all-sounds-off on all 16 channels; suitable for panic/focus-loss cleanup without resetting programs.

All MIDI methods return promises resolving to `undefined` only after FluidSynth acknowledges the command. All channels are integer 0–15; channel 9 retains FluidSynth's normal percussion semantics. Invalid arguments reject before any write. Commands before readiness or after shutdown reject. Listen to `status`, not `error`: failures are reported via rejected promises and `status` events, never unhandled EventEmitter `error` events. Callers should catch rejected control promises, especially during shutdown.

## Configuration and test injection

Constructor options:

- `configPath`: optional JSON file path. UTF-8 BOM is supported.
- `config`: optional shallow overrides of file values; can also supply all configuration without a file.
- `startupTimeoutMs = 15000`, `commandTimeoutMs = 3000`, `shutdownTimeoutMs = 3000`: positive integer timeouts. Acknowledgment timeout invalidates the connection and kills the child to prevent out-of-sync writes. Shutdown allows one graceful timeout and one additional forced-exit timeout; failure to terminate rejects rather than claiming success.
- `spawn`: optional function with the `child_process.spawn` signature, solely for testing.

Required config fields: absolute `fluidsynthExecutable` and `soundFont` paths, `audioDriver`, integer `sampleRate` (8000–192000), numeric `gain` (0–10). Optional `reverb` and `chorus` are booleans. For file-driver verification, override `audioDriver: 'file'` and set `audioFile` to an absolute WAV path in an existing directory. Output is stereo 16-bit PCM, rendered in real time. This does not alter `config/audio.json`.

The child is started without a shell, with hidden Windows console, piped stdin/stdout/stderr, and MIDI device input disabled. Commands are serialized and paired with unique echo acknowledgments, including across split stdout chunks. Stdout replies and stderr diagnostics are bounded. Exiting unexpectedly invalidates pending and queued operations; call `initialize()` to restart.

## Verification

From the project root:

```powershell
node --test test\audio-engine.test.js test\audio-render.test.js
node scripts\verify-engine.js
```

The unit tests use injected subprocesses. The render test is opt-in so ordinary unit tests do not require a local FluidSynth installation:

```powershell
$env:GENOVA_AUDIO_RENDER_TEST = '1'
node --test test\audio-render.test.js
```

The standalone verifier always runs the actual executable configured by the project, writes only under `verification\engine`, and validates piano, organ, strings, a three-note chord, note releases, sustain, program-switch spectral changes, panic silence, volume, and signed pitch bend using WAV sample analysis. It writes seven WAVs and `results.json`. These are digital-output checks; they do not establish physical speaker audibility. Reverb/chorus are disabled for quantitative checks. No accompaniment is implemented.
