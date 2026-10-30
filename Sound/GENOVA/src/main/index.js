'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { AudioEngine } = require('../audio/engine');
const { AudioController } = require('./audio-controller');
const { ArrangerEngine } = require('../arranger/engine');
const { ProgressionStore } = require('./progression-store');

const root = path.resolve(__dirname, '..', '..');
const entryFile = path.join(root, 'src', 'renderer', 'index.html');
const entryURL = pathToFileURL(entryFile).href;
const engine = new AudioEngine({ configPath: path.join(root, 'config', 'audio.json') });
const arranger = new ArrangerEngine({ audio: engine });
const progressionStore = () => new ProgressionStore(path.join(app.getPath('userData'), 'arranger-progression.json'));
const audio = new AudioController(engine, {
  arranger,
  progressionStore: {
    save: (document) => progressionStore().save(document),
    load: () => progressionStore().load()
  }
});
let window = null;
let exiting = false;
let shutdownPromise = null;

function sendStatus(status, channel = 'audio:status') {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    try {
      window.webContents.send(channel, status);
    } catch (error) {
      console.warn('Renderer could not receive audio status:', error.message);
    }
  }
}
audio.on('status', sendStatus);
audio.on('arranger', (state) => sendStatus(state, 'arranger:state'));

function shutdownAndQuit() {
  if (shutdownPromise) return shutdownPromise;
  exiting = true;
  shutdownPromise = audio.dispatch('shutdown').catch((error) => {
    console.error('Audio shutdown failed:', error.message);
  }).finally(() => app.quit());
  return shutdownPromise;
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 940,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#101522',
    title: 'GENOVA',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-start-loading', () => {
    void audio.dispatch('silence').catch(() => {});
  });
  window.webContents.on('render-process-gone', () => {
    void audio.dispatch('shutdown').catch((error) => console.error(error.message));
  });
  window.on('blur', () => { void audio.dispatch('silence').catch(() => {}); });
  window.on('close', (event) => {
    if (!exiting) {
      event.preventDefault();
      void shutdownAndQuit();
    }
  });
  void window.loadFile(entryFile);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle('audio:command', async (event, action, payload) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== entryURL) {
      throw new Error('Untrusted audio request.');
    }
    if (exiting) throw new Error('Application is shutting down.');
    if (typeof action !== 'string' || (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload)))) {
      throw new TypeError('Invalid audio request.');
    }
    return audio.dispatch(action, payload);
  });
  createWindow();
}).catch((error) => {
  console.error('GENOVA startup failed:', error);
  void shutdownAndQuit();
});

app.on('before-quit', (event) => {
  if (!exiting) {
    event.preventDefault();
    void shutdownAndQuit();
  }
});
app.on('window-all-closed', () => { void shutdownAndQuit(); });
