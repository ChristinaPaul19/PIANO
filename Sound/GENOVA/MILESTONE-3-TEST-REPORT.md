# GENOVA — consolidated Milestone 3 verification

Date: 2026-10-30. Final combined run: **19:17:49–19:23:10 IST** (13:47:49–13:53:10 UTC).

## Overall result

**All eight regression commands passed after the latest bug fixes.** No additional production changes were required during this final run. Milestone 4 was not started, and the UI was not redesigned.

**Important preservation warning:** the original Electron PID **1440** and FluidSynth PID **14132** were present before testing, but both were absent at the final preservation check. Therefore the combined wrapper exited **1**, despite all eight test commands exiting **0**. The cause of the original application's exit was not established. No direct command was issued to terminate either original PID; neither was restarted. The test code closes its own launched application objects and kills only FluidSynth PIDs obtained from those test instances. This is not enough evidence to claim that preservation of the original running instance succeeded. UI tests also exercise focus changes; GENOVA intentionally silences/stops accompaniment on blur. No other GENOVA processes remained when inspected after the run.

Machine-readable command history and this warning: [combined-regression.json](verification/integration-audit/combined-regression.json).

## Final command results

All commands ran sequentially from the existing GENOVA project with installed dependencies; no installation, configuration change or SoundFont replacement was performed.

| Command | Result | Coverage / measured duration |
|---|---|---|
| `npm.cmd test` | 76 passed, 0 failed, 1 skipped | 77 discovered unit/regression tests; 2.54 s |
| `& '.\scripts\Test-SoundFont.ps1'` | Passed | Milestone 1 load, non-silent PCM, real WASAPI note playback; 6.73 s |
| `npm.cmd run verify:audio` | 7 scenarios passed | Actual FluidSynth keyboard/instrument/controller WAV analysis; 17.93 s |
| `npm.cmd run verify:arranger` | 12 scenarios passed | Actual drum/bass PCM, root spectra and stopped tails; 20.81 s |
| `npm.cmd run test:electron` | 11 tests passed | Actual Electron keyboard and audio integration; 6.86 s |
| `npm.cmd run test:arranger-electron` | 9 tests passed | Actual arranger UI, all sections and saved-loop restart; 32.43 s |
| `node --test test\integration-audit.js` | 5 tests passed | Crash recovery, validation recovery and repeated-cycle memory; 38.92 s |
| `node scripts\verify-live-arranger.js` | 55 live scenarios passed | PID-specific Windows audio-session metering, timing and cleanup; 193.85 s |

The single skipped test is the opt-in real-render unit test; its real-audio coverage was explicitly exercised by `verify:audio`, rather than silently treated as passed. Node test counts include enclosing test cases as well as subtests. Unit tests include the six live-audio analysis regressions and three held-chord recovery regressions.

Complete command logs: [verification/integration-audit](verification/integration-audit/), named `*-final.log`.

## Milestone 1 and 2 preservation

Verified with the actual installed FluidSynth 2.6.1 executable and GeneralUser-GS.sf2:

- Successful initialization, SoundFont loading, non-silent stereo WAV rendering and WASAPI playback.
- Piano, organ and strings; program switching; velocity differences; channel volume; sustain; pitch bend; panic and note release.
- Laptop keyboard chords, independent releases, pointer capture outside a key, shared mouse/laptop ownership of one pitch, and simultaneous touch contacts.
- Octave shifting and bounds; lead instrument controls remain independent of backing.
- Sandboxed renderer, context isolation, Node integration disabled, narrow IPC, validated MIDI arguments.
- Stop/start, renderer reload, deliberate crash of a test-owned FluidSynth process, retry recovery and owned-process cleanup.

The original audio configuration is unchanged: WASAPI, 48,000 Hz and master gain 0.2, using:

- `D:\Christina\Sound\fluidsynth-v2.6.1-win10-x64-cpp11\bin\fluidsynth.exe`
- `D:\Christina\Sound\GENOVA\assets\soundfonts\GeneralUser-GS.sf2`

SoundFont SHA-256 remains `9575028C7A1F589F5770FCCC8CFF2734566AF40CD26ED836944E9A5152688CFE`.

## Milestone 3 functional coverage

| Feature | Evidence |
|---|---|
| Pop, Rock and Waltz | All three styles exercised through actual Electron and live WASAPI output. |
| Main A/B/C/D | All four variations in every style; exact performed drum/bass event pitches, velocities and subdivision coverage checked. |
| Chord changes | C major, C minor and D major in live output; all nine supported qualities, inversions, split and latch behavior covered by unit/Electron tests. |
| Intro and ending | Two-bar durations and transitions checked; live output measured; ending automatically stops. |
| Fill and break | One-bar duration and return to selected main checked. Break intentionally includes an opening stab and late pickup; it is not an entirely silent bar. |
| Tempo and synchronization | Bar-aligned section changes, beat-aligned chords, phase-preserving tempo changes, absolute deadlines and excessive-lateness shutdown covered. |
| Recording | Next-bar arming, integer-beat events, whole-bar length, event/bar limits and validation covered. |
| Looping | Automatic chord replay, wrap, stop/restart at position zero and live-input isolation checked for all three styles. |
| Save/load | Atomic local storage, malformed/oversized input rejection and progression restoration after a full application restart verified with an isolated test slot. |
| Lifecycle and isolation | Arranger stop affects bass/drums, not lead channel; panic/reload/audio failure stop safely; retry does not restart backing automatically. |

No proprietary Yamaha style files were used. These checks do not imply Yamaha-compatible behavior or a complete multi-part commercial arranger.

## Actual audio evidence

The live verifier uses **the spawned FluidSynth process's Windows CoreAudio session peak meter**, not a placeholder animation, unrelated endpoint peak, microphone recording or file-driver substitute.

- **55 live scenarios passed.**
- **4,581** process-specific meter samples collected over approximately **186.75 seconds**.
- FluidSynth session unmuted, session volume 1.0; endpoint unmuted with reported volume 0.52. Device settings were observed, not changed.
- Every required live scene had measurable signal and enough observations.
- **10 post-stop checks passed:** after a 2.4-second effects-tail allowance, maximum measured peak was **0.0000305185**, below the verifier's **0.0001 (-80 dBFS)** limit.
- No tracked accompaniment notes remained active, and no delayed note submissions occurred after Stop.
- Owned live-verifier FluidSynth and meter-helper processes were cleaned up.

Metering proves digital signal reached the process's live Windows output session. It **does not independently prove physical speaker audibility**, correct acoustic routing, or spectral identity. Chord pitch identity is checked at MIDI submission; separate rendered-WAV tests provide frequency-domain evidence.

## Timing measurements

Measured from **2,278 actual note submissions** across 1,070 active subdivisions:

| Measurement | Final result |
|---|---:|
| Submission lateness, median | 7.90 ms |
| Submission lateness, p95 | 15.98 ms |
| Submission lateness, maximum | 25.21 ms |
| Lateness standard deviation | 4.76 ms |
| FluidSynth acknowledgment, median / p95 / max | 0.62 / 1.45 / 7.05 ms |
| 45.33-second bounded soak phase difference | +10.18 ms |

Section runs showed first-to-last phase differences of approximately -0.53 ms (Pop), +4.54 ms (Rock), and +3.53 ms (Waltz), rather than an ever-growing completion-relative timing offset. No clock-overrun stop or missing expected bar/beat occurred in this live run.

These are host API submission/acknowledgment measurements, **not DAC latency, acoustic onset or sample-accurate synchronization**. Timer jitter remains real; results do not guarantee tight timing under arbitrary system load. Per-process meter sampling averaged about 40.8 ms and is unsuitable for claiming sample-level onset accuracy.

## Memory, crashes and stuck notes

### FluidSynth live run

- Warm-up private bytes: **55,513,088 bytes**.
- Final private bytes: **55,349,248 bytes** (change **-163,840 bytes**).
- Peak private bytes: **55,574,528 bytes**.
- Peak working set: **61,272,064 bytes**.
- No short-run retained-memory growth was observed in the owned FluidSynth process.

### Electron repeated-cycle audit

30 measured playback cycles, six renderer reloads and approximately 35.01 seconds after warm-up:

- Main RSS: **113,680,384 → 114,864,128 bytes**, growth **1,183,744 bytes** (about 1.13 MiB).
- Renderer retained heap: **2,432,684 → 1,793,340 bytes**, change **-639,344 bytes**.
- Both remained below the explicit audit growth bounds (64 MiB main RSS; 8 MiB retained renderer heap).
- One renderer was present at each measured checkpoint; no renderer JavaScript errors were captured.
- Garbage collection was requested at heap measurement points; this is not an unassisted long-term workload measurement.

No unexpected crash occurred in the test-owned applications. Deliberate crash/retry cases passed. Stuck-note checks passed after releases, panic, section endings, stop, focus/reload handling and recovery. The original instance's unexplained exit is separately recorded above, not counted as a successful preservation check.

**Resource limitation:** these are bounded, short-run tests, not proof of zero leaks over hours or days. The verifier intentionally retains diagnostic evidence in its own Node process; that harness's retained data is not an application leak measurement.

## Bugs fixed before this final run

1. **Stale chord input after audio loss:** the controller previously cleared routing while leaving held recognition notes behind. Fresh chords could fail after retry. Non-ready audio states now clear recognition input too. Three unit regressions and the actual held-chord crash/retry Electron case pass.
2. **Stale validation error banner:** correcting invalid tempo succeeded but left its old error visible. Successful arranger operations now clear only arranger-origin errors, without hiding unrelated audio failures. The actual invalid-tempo/correction Electron case passes.

Production files changed by those prior fixes: [audio-controller.js](src/main/audio-controller.js), [app.js](src/renderer/app.js), [arranger-ui.js](src/renderer/arranger-ui.js). No further production edits were made in the final combined verification.

## Evidence index

- [Combined command outcomes and preservation warning](verification/integration-audit/combined-regression.json)
- [Milestone 1 result](verification/result.json)
- [Keyboard audio renders](verification/engine/results.json)
- [Arranger audio renders](verification/arranger/results.json)
- [Keyboard Electron integration](verification/electron/result.json)
- [Arranger Electron integration](verification/arranger-ui/result.json)
- [Extended Electron recovery/memory audit](verification/integration-audit/electron-audit.json)
- [Live WASAPI scenarios, timing, memory and stop checks](verification/live-arranger/results.json)
- Raw meter, memory, note-submission and transport evidence: [verification/live-arranger](verification/live-arranger/).

## Exact Windows / VS Code launch instructions

1. In VS Code, choose **File → Open Folder** and open `D:\Christina\Sound\GENOVA`.
2. Choose **Terminal → New Terminal**, using PowerShell.
3. Run:

```powershell
Set-Location 'D:\Christina\Sound\GENOVA'
node --version
npm.cmd --version
npm.cmd start
```

Dependencies and the Electron runtime are already installed; no reinstall is required. `npm.cmd` avoids PowerShell's common `npm.ps1` execution-policy problem. Keep the launch terminal open. Wait for **Audio ready**.

4. For standalone piano, leave accompaniment off and hold/release `A`, `D`, `G`. Select 017 for organ or 049 for strings, then repeat. Click the Keyboard heading if a dropdown retains focus.
5. For arranger playback, turn **Accompaniment on**, choose a style, hold `A+D+G` for C major, then click **Intro** or **Start**. Use `A+E+G` for C minor. Lower keys are chord input; `K` and above start the melody zone at octave 0.
6. Select Main A/B/C/D, Fill, Break or Ending. Running requests apply on the next bar. Escape stops all sound. Switching focus away intentionally stops accompaniment.
7. To record: Start, choose **Record chords**, wait for the next bar, play changes, then **Finish recording**. Enable Loop; if stopped, press Start. Save/Load uses the local single slot.
8. In a second terminal, confirm the current FluidSynth process (do not reuse historical PIDs):

```powershell
Get-Process -Name fluidsynth -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, Path
```

9. Confirm actual audibility by hearing notes through the intended speakers. Check **Windows Settings → System → Sound**, selected output and Volume mixer if silent. A running process or successful digital meter is not a substitute for listening.
10. Close GENOVA normally when finished; it shuts down its owned FluidSynth child.

The old protected instance was not restarted automatically. Launching now creates a fresh instance containing the saved fixes.

**Stop point:** Milestone 3 verification only. No Milestone 4 work or new product features were started.
