'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, payload) => ipcRenderer.invoke('audio:command', action, payload);

contextBridge.exposeInMainWorld('genova', {
  initialize: () => invoke('initialize'),
  shutdown: () => invoke('shutdown'),
  snapshot: () => invoke('snapshot'),
  noteOn: (note, velocity) => invoke('noteOn', { note, velocity }),
  noteOff: (note) => invoke('noteOff', { note }),
  program: (program) => invoke('program', { program }),
  volume: (value) => invoke('volume', { value }),
  sustain: (enabled) => invoke('sustain', { enabled }),
  pitchBend: (value) => invoke('pitchBend', { value }),
  silence: () => invoke('silence'),
  releaseKeyboard: () => invoke('releaseKeyboard'),
  arranger: {
    configure: (options) => invoke('arranger.configure', options),
    start: (intro = false) => invoke('arranger.start', { intro }),
    stop: () => invoke('arranger.stop'),
    section: (section) => invoke('arranger.section', { section }),
    recordStart: () => invoke('arranger.recordStart'),
    recordStop: () => invoke('arranger.recordStop'),
    loop: (enabled) => invoke('arranger.loop', { enabled }),
    save: () => invoke('arranger.save'),
    load: () => invoke('arranger.load'),
    onState: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('Expected an arranger callback.');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('arranger:state', listener);
      return () => ipcRenderer.removeListener('arranger:state', listener);
    }
  },
  onStatus: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Expected a status callback.');
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('audio:status', listener);
    return () => ipcRenderer.removeListener('audio:status', listener);
  }
});
