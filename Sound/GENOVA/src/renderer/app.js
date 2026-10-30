'use strict';

(() => {
  const api = window.genova;
  const { mapping, noteName, HeldNotes } = window.GenovaKeyboard;
  const el = (id) => document.getElementById(id);
  const keyboard = el('keyboard');
  const keyElements = new Map();
  const mappedCodes = new Map(mapping.map(([code], index) => [code, index]));
  let state = 'stopped';
  let octave = 0;
  let velocity = 96;
  let latchedSustain = false;
  let spaceSustain = false;
  let changingPower = false;
  let arrangerPanel = null;
  let accompanimentEnabled = false;

  function showError(error, source = 'audio') {
    el('error').textContent = error.message || String(error);
    el('error').dataset.source = source;
    el('error').hidden = false;
  }

  function clearError() {
    el('error').textContent = '';
    delete el('error').dataset.source;
    el('error').hidden = true;
  }

  function execute(promise) {
    return promise.catch(showError);
  }

  const held = new HeldNotes({
    noteOn: (note, value) => {
      void api.noteOn(note, value).catch((error) => {
        held.clear(false);
        void api.silence().catch(() => {});
        showError(error);
      });
    },
    noteOff: (note) => { void execute(api.noteOff(note)); },
    changed: (notes) => {
      for (const [note, key] of keyElements) {
        const pressed = notes.has(note);
        key.classList.toggle('is-held', pressed);
        key.setAttribute('aria-pressed', String(pressed));
      }
      el('active-notes').textContent = `${notes.size} held note${notes.size === 1 ? '' : 's'}`;
    }
  });

  function updateSustain() {
    const enabled = latchedSustain || spaceSustain;
    el('sustain').setAttribute('aria-pressed', String(enabled));
    if (state === 'ready') void execute(api.sustain(enabled));
  }

  function resetBend() {
    el('bend').value = '0';
    el('bend-value').textContent = '0';
    if (state === 'ready') void execute(api.pitchBend(0));
  }

  function clearLocalNotes() {
    held.clear(false);
    latchedSustain = false;
    spaceSustain = false;
    el('sustain').setAttribute('aria-pressed', 'false');
    el('bend').value = '0';
    el('bend-value').textContent = '0';
  }

  function silence() {
    clearLocalNotes();
    if (state === 'ready') void execute(api.silence());
  }

  function renderKeyboard() {
    keyboard.replaceChildren();
    keyElements.clear();
    const base = 60 + octave * 12;
    let whiteCount = 0;
    for (let offset = 0; offset <= 24; offset++) {
      const note = base + offset;
      const isBlack = [1, 3, 6, 8, 10].includes(note % 12);
      const key = document.createElement('button');
      key.type = 'button';
      key.className = `key ${isBlack ? 'black' : 'white'}${accompanimentEnabled && note < 72 ? ' chord-zone' : ''}`;
      key.dataset.note = String(note);
      key.setAttribute('aria-label', `${noteName(note)}, MIDI ${note}`);
      key.setAttribute('aria-pressed', 'false');
      key.disabled = state !== 'ready';
      if (isBlack) key.style.left = `${whiteCount / 15 * 100 - 2.1}%`;
      else whiteCount++;
      const name = document.createElement('span');
      name.textContent = noteName(note);
      const shortcut = document.createElement('kbd');
      shortcut.textContent = mapping[offset]?.[1] || '';
      key.append(name, shortcut);
      key.addEventListener('pointerdown', (event) => {
        if (state !== 'ready' || event.button !== 0) return;
        event.preventDefault();
        key.setPointerCapture(event.pointerId);
        held.press(`pointer:${event.pointerId}`, note, velocity);
      });
      const release = (event) => held.release(`pointer:${event.pointerId}`);
      key.addEventListener('pointerup', release);
      key.addEventListener('pointercancel', release);
      key.addEventListener('lostpointercapture', release);
      key.addEventListener('contextmenu', (event) => event.preventDefault());
      keyboard.append(key);
      keyElements.set(note, key);
    }
    el('note-range').textContent = `${noteName(base)} – ${noteName(base + 24)}`;
    el('octave-value').textContent = octave > 0 ? `+${octave}` : String(octave);
    updateEnabled();
  }

  function updateEnabled() {
    const ready = state === 'ready';
    for (const id of ['instrument', 'volume', 'velocity', 'sustain', 'bend', 'panic']) el(id).disabled = !ready;
    el('octave-down').disabled = !ready || octave <= -3;
    el('octave-up').disabled = !ready || octave >= 3;
    for (const key of keyElements.values()) key.disabled = !ready;
    el('power').disabled = changingPower || state === 'starting' || state === 'stopping';
    el('power').textContent = ready ? 'Stop audio' : state === 'error' ? 'Retry audio' : 'Start audio';
    if (arrangerPanel) arrangerPanel.setAudioReady(ready);
  }

  function setStatus(status) {
    state = status.state;
    el('status').dataset.state = state;
    el('status').textContent = ({ ready: 'Audio ready', starting: 'Starting audio…', stopping: 'Stopping audio…', stopped: 'Audio stopped', error: 'Audio unavailable' })[state] || state;
    if (state !== 'ready') clearLocalNotes();
    if (state === 'error') showError(new Error(status.message || status.error || 'FluidSynth stopped unexpectedly. Retry audio to reconnect.'));
    updateEnabled();
  }

  function applySnapshot(snapshot) {
    setStatus(snapshot.status);
    if (snapshot.instruments.length) {
      const options = snapshot.instruments.map(({ program, name }) => {
        const option = document.createElement('option');
        option.value = String(program);
        option.textContent = `${String(program + 1).padStart(3, '0')} · ${name}`;
        return option;
      });
      el('instrument').replaceChildren(...options);
      el('instrument').value = String(snapshot.controls.program);
    }
    el('volume').value = String(snapshot.controls.volume);
    el('volume-value').textContent = String(snapshot.controls.volume);
    latchedSustain = snapshot.controls.sustain;
    el('sustain').setAttribute('aria-pressed', String(latchedSustain || spaceSustain));
    el('bend').value = String(snapshot.controls.pitchBend);
    el('bend-value').textContent = String(snapshot.controls.pitchBend);
    if (arrangerPanel) arrangerPanel.update(snapshot.arranger);
  }

  async function power() {
    if (changingPower) return;
    changingPower = true;
    updateEnabled();
    clearError();
    try {
      if (state === 'ready') {
        clearLocalNotes();
        applySnapshot(await api.shutdown());
      } else {
        applySnapshot(await api.initialize());
      }
    } catch (error) {
      showError(error);
      const snapshot = await api.snapshot().catch(() => null);
      if (snapshot) applySnapshot(snapshot);
    } finally {
      changingPower = false;
      updateEnabled();
    }
  }

  function shiftOctave(direction) {
    if (state !== 'ready') return;
    const next = Math.max(-3, Math.min(3, octave + direction));
    if (next === octave) return;
    clearLocalNotes();
    void execute(api.releaseKeyboard());
    octave = next;
    renderKeyboard();
  }

  function editable(target) {
    return target instanceof HTMLElement && (target.matches('input, select, textarea') || target.isContentEditable);
  }

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') { event.preventDefault(); silence(); return; }
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || editable(event.target) || state !== 'ready') return;
    if (event.code === 'Enter' && event.target.matches('.key')) {
      event.preventDefault();
      held.press('accessible:Enter', Number(event.target.dataset.note), velocity);
    } else if (mappedCodes.has(event.code)) {
      event.preventDefault();
      held.press(`keyboard:${event.code}`, 60 + octave * 12 + mappedCodes.get(event.code), velocity);
    } else if (event.code === 'Space') {
      event.preventDefault();
      spaceSustain = true;
      updateSustain();
    } else if (event.code === 'KeyZ' || event.code === 'KeyX') {
      event.preventDefault();
      shiftOctave(event.code === 'KeyZ' ? -1 : 1);
    }
  });
  document.addEventListener('keyup', (event) => {
    held.release(`keyboard:${event.code}`);
    if (event.code === 'Enter') held.release('accessible:Enter');
    if (event.code === 'Space' && spaceSustain) {
      event.preventDefault();
      spaceSustain = false;
      updateSustain();
    }
    if (event.target === el('bend') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.code)) resetBend();
  });
  window.addEventListener('blur', silence);
  document.addEventListener('visibilitychange', () => { if (document.hidden) silence(); });
  el('power').addEventListener('click', () => { void power(); });
  el('panic').addEventListener('click', silence);
  el('octave-down').addEventListener('click', () => shiftOctave(-1));
  el('octave-up').addEventListener('click', () => shiftOctave(1));
  el('sustain').addEventListener('click', () => { latchedSustain = !latchedSustain; updateSustain(); });
  el('instrument').addEventListener('change', async (event) => {
    clearLocalNotes();
    try { applySnapshot(await api.program(Number(event.target.value))); } catch (error) { showError(error); }
    event.target.blur();
  });
  el('volume').addEventListener('input', (event) => {
    el('volume-value').textContent = event.target.value;
    void execute(api.volume(Number(event.target.value)));
  });
  el('velocity').addEventListener('input', (event) => {
    velocity = Number(event.target.value);
    el('velocity-value').textContent = String(velocity);
  });
  el('bend').addEventListener('input', (event) => {
    el('bend-value').textContent = event.target.value;
    void execute(api.pitchBend(Number(event.target.value)));
  });
  el('bend').addEventListener('pointerup', resetBend);
  el('bend').addEventListener('pointercancel', resetBend);
  for (const id of ['volume', 'velocity', 'bend']) el(id).addEventListener('pointerup', (event) => event.target.blur());

  renderKeyboard();
  if (!api) {
    setStatus({ state: 'error', message: 'Open GENOVA using Electron. Audio is not available in a regular browser.' });
    el('power').disabled = true;
    return;
  }
  arrangerPanel = new window.GenovaArrangerPanel({
    api: api.arranger,
    onError: (error) => showError(error, 'arranger'),
    onSuccess: () => {
      if (state === 'ready' && el('error').dataset.source === 'arranger') clearError();
    },
    onRoutingChange: (enabled) => {
      accompanimentEnabled = enabled;
      clearLocalNotes();
      for (const [note, key] of keyElements) key.classList.toggle('chord-zone', enabled && note < 72);
    }
  });
  api.onStatus(setStatus);
  void power();
})();
