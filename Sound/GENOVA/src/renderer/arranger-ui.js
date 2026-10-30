'use strict';

(() => {
  const el = (id) => document.getElementById(id);
  const sections = ['intro', 'A', 'B', 'C', 'D', 'fill', 'break', 'ending'];

  class ArrangerPanel {
    constructor({ api, onError, onRoutingChange, onSuccess = () => {} }) {
      this.api = api;
      this.onError = onError;
      this.onRoutingChange = onRoutingChange;
      this.onSuccess = onSuccess;
      this.ready = false;
      this.state = null;
      this.busy = false;
      this.savedMessage = '';
      this.recordArmBar = null;
      api.onState((state) => this.update(state));
      el('acmp').addEventListener('click', () => this.run(() => api.configure({ enabled: !this.state.enabled })));
      el('arranger-style').addEventListener('change', (event) => {
        const styleId = event.target.value;
        event.target.blur();
        this.run(() => api.configure({ styleId }));
      });
      el('tempo').addEventListener('change', (event) => {
        const tempo = Number(event.target.value);
        event.target.blur();
        this.run(() => api.configure({ tempo }));
      });
      el('arranger-start').addEventListener('click', () => this.run(() => api.start(false)));
      el('arranger-stop').addEventListener('click', () => this.run(() => api.stop()));
      for (const section of sections) {
        el(`section-${section}`).addEventListener('click', () => this.run(() => {
          if (section === 'intro' && !this.state.running) return api.start(true);
          return api.section(section);
        }));
      }
      el('progression-record').addEventListener('click', () => {
        this.savedMessage = '';
        this.run(() => this.state.recording ? api.recordStop() : api.recordStart());
      });
      el('progression-loop').addEventListener('click', () => this.run(() => api.loop(!this.state.looping)));
      el('progression-save').addEventListener('click', () => this.run(async () => {
        const state = await api.save();
        this.savedMessage = 'Saved locally (one slot)';
        return state;
      }));
      el('progression-load').addEventListener('click', () => this.run(async () => {
        const state = await api.load();
        this.savedMessage = 'Loaded saved progression';
        return state;
      }));
    }

    async run(operation) {
      if (this.busy) return;
      this.busy = true;
      this.render();
      try {
        const result = await operation();
        this.update(result);
        if (!result?.error) this.onSuccess();
      } catch (error) {
        this.onError(error);
      } finally {
        this.busy = false;
        this.render();
      }
    }

    setAudioReady(ready) {
      this.ready = ready;
      this.render();
    }

    update(state) {
      if (!state) return;
      const previous = this.state;
      this.state = state;
      if (state.recording && !previous?.recording) this.recordArmBar = state.bar + 1;
      if (!state.recording) this.recordArmBar = null;
      if (!previous || previous.enabled !== state.enabled) this.onRoutingChange(state.enabled);
      if (state.error && state.error !== previous?.error) this.onError(new Error(state.error));
      this.render();
    }

    render() {
      const state = this.state;
      const unavailable = !this.ready || !state || this.busy;
      for (const element of document.querySelectorAll('.arranger-panel button, .arranger-panel select, .arranger-panel input')) element.disabled = unavailable;
      if (!state) return;
      el('acmp').setAttribute('aria-pressed', String(state.enabled));
      el('acmp').textContent = state.enabled ? 'Accompaniment on' : 'Accompaniment off';
      const styleSelect = el('arranger-style');
      const catalog = state.styles.map(({ id }) => id).join(',');
      if (styleSelect.dataset.catalog !== catalog) {
        styleSelect.replaceChildren(...state.styles.map((style) => {
          const option = document.createElement('option');
          option.value = style.id;
          option.textContent = `${style.name} · ${style.beatsPerBar}/4`;
          return option;
        }));
        styleSelect.dataset.catalog = catalog;
      }
      styleSelect.value = state.styleId;
      styleSelect.disabled = unavailable || state.running;
      if (document.activeElement !== el('tempo')) el('tempo').value = String(state.tempo);
      el('recognized-chord').textContent = state.chord ? state.chord.name : '—';
      el('arranger-position').textContent = state.running
        ? `Bar ${state.bar + 1} · Beat ${Math.floor(state.beat) + 1}` : 'Stopped';
      el('arranger-position').dataset.running = String(state.running);
      el('arranger-start').disabled = unavailable || !state.enabled || state.running;
      el('arranger-stop').disabled = unavailable || !state.running;
      for (const section of sections) {
        const button = el(`section-${section}`);
        button.disabled = unavailable || !state.enabled || (!state.running && ['fill', 'break', 'ending'].includes(section));
        button.classList.toggle('is-current', state.running && state.section === section);
        button.classList.toggle('is-queued', state.queuedSection === section);
        if (['A', 'B', 'C', 'D'].includes(section)) button.setAttribute('aria-pressed', String(state.variation === section));
      }
      const sectionName = (value) => ['A', 'B', 'C', 'D'].includes(value) ? `Main ${value}` : value;
      el('section-pending').textContent = `${sectionName(state.section)}${state.queuedSection ? ` → ${sectionName(state.queuedSection)}` : ''}`;
      el('progression-record').disabled = unavailable || !state.enabled || !state.running || state.looping;
      el('progression-record').textContent = state.recording ? 'Finish recording' : 'Record chords';
      el('progression-record').setAttribute('aria-pressed', String(state.recording));
      const progression = state.progression;
      const hasProgression = Boolean(progression && progression.events.length);
      el('progression-loop').disabled = unavailable || !state.enabled || !hasProgression || state.recording;
      el('progression-loop').setAttribute('aria-pressed', String(state.looping));
      el('progression-save').disabled = unavailable || !hasProgression || state.recording;
      el('progression-load').disabled = unavailable || state.running || state.recording;
      const recordingLabel = state.bar < this.recordArmBar ? 'Armed · recording starts next bar' : 'Recording · beat-quantized';
      let summary = state.recording ? recordingLabel : hasProgression
        ? `${progression.lengthBars} bar${progression.lengthBars === 1 ? '' : 's'} · ${progression.events.length} chord changes${state.looping ? ' · looping' : ''}`
        : 'No progression recorded';
      if (this.savedMessage && !state.recording) summary += ` · ${this.savedMessage}`;
      el('progression-summary').textContent = summary;
    }
  }

  window.GenovaArrangerPanel = ArrangerPanel;
})();
