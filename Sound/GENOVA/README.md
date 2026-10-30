# GENOVA — arranger workstation

Milestone 3 extends the working Electron keyboard with an independent chord-driven arranger. The existing FluidSynth installation, SoundFont, license and [audio configuration](config/audio.json) remain in place. Pop, Rock and Waltz patterns are original; no Yamaha style files, images, firmware or samples were copied or downloaded. Accompaniment is off on launch, preserving the standalone keyboard.

## Run

From PowerShell:

```powershell
Set-Location 'D:\Christina\Sound\GENOVA'
npm start
```

Dependencies are installed and versions are locked. For a fresh dependency restore, use `npm ci`. Node.js 22 or later is required for development. The installed Windows FluidSynth executable and its adjacent DLLs must remain available at the configured location.

The application initializes audio on opening. **Stop audio** releases the synthesizer; **Start audio / Retry audio** initializes it again. Closing the application shuts down its owned FluidSynth process.

## Controls

- **Keyboard:** click and hold a piano key, or use multiple touch contacts. Release to send note-off. Pointer capture handles releases outside a key.
- **Laptop keys:** `A W S E D F T G Y H U J K O L P ;` play consecutive chromatic notes, starting at C4. Hold multiple keys for chords. Repeated keydown events do not retrigger a held note.
- **Octave:** `Z` / `X`, or the − / + buttons; range −3 through +3. Shifting stops held/sustained notes so previous pitches cannot become stuck.
- **Instrument:** 128 General MIDI bank-0 presets read from the loaded SoundFont. Display numbers are 001–128; MIDI program numbers are 0–127. Switching instruments stops current lead voices and resets sustain and pitch bend, without stopping accompaniment.
- **Velocity:** 1–127, applied to new note-ons. A laptop keyboard or mouse does not measure pressure; this slider chooses the MIDI velocity.
- **Volume:** 0–127, MIDI channel volume (CC7), independent of the configured synthesizer master gain.
- **Sustain:** click to latch/unlatch, or hold Space for a momentary pedal (CC64). Released keys stop highlighting even if their sound is sustained.
- **Pitch bend:** signed MIDI range −8192 to +8191. Releasing the slider returns to center. The audible range is the preset/synthesizer's current bend sensitivity (normally ±2 semitones).
- **All sound off / Escape:** stops accompaniment and live voices, releases sustain and centers pitch bend. Window blur and renderer reload do the same to prevent stuck notes. Switching to another application therefore stops the arranger intentionally.
- Laptop shortcuts are suppressed while editing a slider or instrument dropdown. Pointer use of controls returns focus after release. Piano keys can also be focused and played with Enter.

## Arranger controls

1. Turn **Accompaniment on**. The green-tinted keys below C5 (MIDI 72) become a silent chord-input zone. C5 and above remain the lead instrument. Turning accompaniment off restores the entire keyboard.
2. Select **Pop (4/4)**, **Rock (4/4)** or **Waltz (3/4)** while stopped. Set **Tempo** from 40 to 240 BPM; live tempo changes preserve the transport phase.
3. At octave 0, press `A D G` together for C major, or `A E G` for C minor. A recognized chord remains latched after release. Before the first valid chord, accompaniment plays drums only.
4. Click **Start** for the selected main variation, or **Intro** for a two-bar introduction. Main A/B/C/D use distinct drum and bass patterns. Section changes requested during playback take effect on the next bar.
5. **Fill** and **Break** last one bar and return to the selected main; **Ending** lasts two bars and stops. **Stop** immediately stops accompaniment without cutting off a held lead note. Audio shutdown stops everything.

Recognition supports major/minor triads, dominant seventh, major seventh, minor seventh, diminished, augmented, sus2 and sus4, with inversions. It requires a recognized pitch-class set, not a single-finger shortcut. Ambiguous symmetric or suspended voicings have a deterministic interpretation rather than a uniquely inferable root. Applied chord changes occur on whole beats while running; while stopped, recognition updates immediately. Releasing keys does not erase the latched chord. The split remains at absolute MIDI 72 when octave shifting.

Lead velocity, volume, sustain and pitch bend affect channel 0 only. Bass uses channel 1; drums use GM percussion channel 9 (zero-based). Keyboard octave and lead instrument changes leave accompaniment running. Style changes require stopping first to avoid mixing meters mid-bar.

## Chord progression recording and looping

- Start accompaniment, then choose **Record chords**. Recording arms immediately and begins on the next bar; wait for that boundary before changing chords.
- Play changes in the chord zone. The recorder stores applied chord symbols on integer beats, not microphone audio or lead notes. Choose **Finish recording** after at least one recording bar. Length is rounded to whole bars.
- Recording is bounded to **128 bars / 512 events**. Finishing before the first capture bar produces an empty one-bar recording; it is not a usable loop or save from the UI.
- Enable **Loop** to replay recorded harmony instead of live chord recognition. While running, looping starts at the next bar. While stopped, enable Loop and then press Start: playback begins at loop position zero. Stop preserves the Loop selection. Disable Loop to resume live recognition.
- **Save** writes one local slot, replacing the previous saved progression. **Load** restores it while stopped. The file is in Electron's user-data directory, normally `%APPDATA%\genova\arranger-progression.json` on Windows. No renderer-selected filesystem paths are accepted.
- Saves use atomic replacement; loads are size-bounded and schema-validated. Saved harmony survives application restarts. Select a style with the recording's time signature before loading/looping; recordings contain meter, length and chord events, not a complete workstation registration.

## Architecture

```text
Renderer keyboard + arranger controls
          | narrow asynchronous contextBridge API
          v
Sandboxed preload -> validated Electron IPC
          v
AudioController -> ProgressionStore (main-process file I/O)
          | \
          |  -> ArrangerEngine (chords, patterns, transport, recorder)
          |               |
          v               v
AudioEngine (independent FluidSynth child-process service)
          v
FluidSynth + GeneralUser-GS.sf2 -> Windows WASAPI
```

- [Renderer](src/renderer/index.html), [styles](src/renderer/styles.css), and [UI handlers](src/renderer/app.js) contain no Node.js or process access.
- [Keyboard state](src/renderer/keyboard.js) tracks pointer and laptop ownership independently. A shared pitch receives note-off only when its final owner releases it.
- [Preload](src/main/preload.js) exposes only named audio functions and a status subscription, not raw IPC or shell access.
- [Electron main](src/main/index.js) checks the sender window, main frame and local page URL. Node integration is off; context isolation, sandboxing and web security are on. Permissions, external navigation, new windows and webviews are denied. The page uses a local-only CSP.
- [AudioController](src/main/audio-controller.js) serializes compound operations so program changes and shutdown cannot interleave halfway through a note operation.
- [AudioEngine](src/audio/engine.js) owns FluidSynth independently of Electron and the UI. It reads [audio.json](config/audio.json), validates commands, supervises its child and reports lifecycle state. The renderer never performs synchronous audio operations.

- [Arranger core](src/arranger/engine.js) runs in the main process independently of the renderer: original patterns, chord recognition, monotonic-deadline scheduling, section transitions, quantized recording and validated looping. [Core contract](src/arranger/README.md).
- [Arranger panel](src/renderer/arranger-ui.js) displays pushed state and sends narrowly defined commands. It does not schedule MIDI with browser timers.
- [Progression storage](src/main/progression-store.js) performs bounded, atomic local file I/O outside the renderer.

Live notes use MIDI channel 0, bass channel 1 and drums channel 9 (zero-based). Scoped panic prevents arranger cleanup from cutting off melody and vice versa. No sound server, network download, global PATH edit or system-volume change is performed during application startup.

## Verification

Latest complete rerun: [Milestone 3 consolidated test report](MILESTONE-3-TEST-REPORT.md). All eight test commands passed after the recovery fixes: 76 unit tests (one opt-in render test skipped and covered separately), 11 keyboard Electron tests, nine arranger Electron tests, five extended audit tests, seven keyboard renders, 12 arranger renders, Milestone 1 verification and 55 live WASAPI scenarios. The final original-process preservation check failed because the pre-existing PIDs had exited for an unestablished reason; this caveat is documented separately from functional test success. Timing, bounded memory measurements and exact launch instructions are included in the report.

```powershell
npm test
npm run verify:audio
npm run verify:arranger
npm run test:electron
npm run test:arranger-electron
```

- Unit tests cover MIDI validation/lifecycle, keyboard ownership, channel isolation, chord recognition, deterministic timing/transitions, progression validation/limits and storage.
- Audio verification uses the actual FluidSynth and SoundFont, renders test signals and checks PCM output under `verification\engine`.
- Electron integration launches the actual application, uses its real IPC/audio engine, checks controls and polyphony, tests stop/start and a deliberate owned-process crash, and verifies process cleanup on exit. This plays brief notes through WASAPI. Its report and screenshot are saved under `verification\electron`.
- Arranger verification renders actual drum/bass output and checks PCM/spectral evidence under `verification\arranger`. Arranger Electron tests cover the real UI, all styles/sections, recording, saved progressions across application restart and backend-crash cleanup; their data slot is isolated from user recordings.
- [Milestone 1 verification](scripts/Test-SoundFont.ps1) remains available unchanged.

Verified on 2026-10-30:

- `npm test`: **67 tests passed**. The opt-in real-render test is skipped in this quick suite and exercised separately by `verify:audio`.
- `npm run verify:audio`: all seven real FluidSynth render scenarios passed, covering piano, organ, strings, chords, note release, sustain, program switching, velocity, volume, pitch bend and panic.
- `npm run test:electron`: all 11 tests passed (ten scenario subtests plus their enclosing test), including real WASAPI playback, multitouch/mixed input, octave shift, renderer reload, deliberate FluidSynth crash/retry and confirmed child-process exit.
- `npm run verify:arranger`: **12 real render scenarios passed on two consecutive runs**. Tests check drum/bass output, chord-driven pitch changes and stopping. Spectral checks average short-time windowed power to avoid cancellation across retriggered notes; negative regression tests reject silence and swapped roots.
- `npm run test:arranger-electron`: **all nine tests passed**, covering all chord qualities, three styles and four variations, timed sections, recording/looping, saved data after a complete application restart, and audio-crash cleanup.
- No renderer JavaScript errors were captured. Completed integration runs close their test applications and synthesizers rather than leaving background processes running; temporary progression files are removed.

Reports: [audio results](verification/engine/results.json), [arranger audio results](verification/arranger/results.json), [keyboard Electron results](verification/electron/result.json), [arranger Electron results](verification/arranger-ui/result.json), [arranger screenshot](verification/arranger-ui/arranger.png).

Successful WASAPI operation and non-silent rendered samples do not independently prove that physical speakers are unmuted or audible. Existing audio-device routing, output volume and keyboard hardware rollover remain OS/hardware constraints. Scheduling is sixteenth-note based with monotonic deadlines, but Windows timers and FluidSynth command acknowledgments introduce jitter; it is not sample-accurate. Excessive lateness beyond two beats stops transport safely rather than emitting a large late burst. This first arranger supports drums and bass, not full multi-part orchestrations, Yamaha style import, external MIDI clock or distributable installer packaging.

## SoundFont license

The creator's original [license](assets/soundfonts/LICENSE.txt) and [download provenance](assets/soundfonts/source.json) are retained. The license permits music creation and software use but discloses uncertain origins of some inherited samples; review that caveat before commercial redistribution. See the [creator's website](https://www.schristiancollins.com/generaluser).
