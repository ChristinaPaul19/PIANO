'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('extended Electron recovery, controls and memory audit', { timeout: 150000 }, async (t) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [root], env, timeout: 45000 });
  const report = { testedAt: new Date().toISOString(), success: false, checks: [], memory: [], rendererErrors: [] };
  const directory = path.join(root, 'verification', 'integration-audit');
  await fs.mkdir(directory, { recursive: true });
  try {
    const page = await application.firstWindow();
    page.on('pageerror', (error) => report.rendererErrors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready' && !document.querySelector('#acmp').disabled);
    await page.bringToFront();
    const snapshot = () => page.evaluate(() => window.genova.snapshot());
    const ready = () => page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready' && !document.querySelector('#power').disabled);
    const check = (name) => report.checks.push({ name, passed: true });

    await t.test('crash while holding a chord does not contaminate the next chord after recovery', async () => {
      await page.click('#acmp');
      for (const key of ['a', 'd', 'g']) await page.keyboard.down(key);
      assert.equal((await snapshot()).arranger.chord.name, 'C');
      await page.click('#arranger-start');
      const pid = (await snapshot()).status.pid;
      process.kill(pid);
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'error');
      await page.click('#power');
      await ready();
      for (const key of ['a', 'd', 'g']) await page.keyboard.up(key);
      for (const key of ['s', 'f', 'h']) await page.keyboard.down(key);
      const state = (await snapshot()).arranger;
      assert.equal(state.chord.root, 2);
      assert.equal(state.chord.quality, 'minor');
      assert.equal(state.running, false);
      for (const key of ['s', 'f', 'h']) await page.keyboard.up(key);
      check('Held-chord crash/retry recognizes new D minor without stale input');
    });

    await t.test('invalid tempo error clears once a corrected tempo succeeds', async () => {
      await page.fill('#tempo', '1');
      await page.locator('#tempo').press('Tab');
      await page.waitForFunction(() => !document.querySelector('#error').hidden);
      assert.match(await page.locator('#error').textContent(), /Tempo/);
      await page.fill('#tempo', '150');
      await page.locator('#tempo').press('Tab');
      assert.equal((await snapshot()).arranger.tempo, 150);
      assert.equal(await page.locator('#error').isVisible(), false);
      check('Invalid tempo validation and successful correction clear the error banner');
    });

    await t.test('pedal, bend, lead-note ownership and reload reset do not leave held notes', async () => {
      await page.click('#sustain');
      await page.locator('#bend').focus();
      await page.keyboard.down('ArrowRight');
      await page.keyboard.up('ArrowRight');
      assert.equal((await snapshot()).controls.pitchBend, 0);
      await page.locator('#bend').blur();
      await page.keyboard.down('k');
      await page.keyboard.down('l');
      await page.waitForFunction(() => document.querySelectorAll('.key.is-held').length === 2);
      await page.click('#arranger-start');
      assert.equal((await snapshot()).arranger.running, true);
      await page.reload();
      await ready();
      await page.keyboard.up('k');
      await page.keyboard.up('l');
      const state = await snapshot();
      assert.equal(state.controls.sustain, false);
      assert.equal(state.controls.pitchBend, 0);
      assert.equal(state.arranger.running, false);
      assert.equal(await page.locator('.key.is-held').count(), 0);
      check('Actual keyboard pedal/bend controls and reload release all held input');
    });

    await t.test('30 repeated playback cycles and six renderer reloads have bounded retained memory', async () => {
      await page.evaluate(async () => {
        await window.genova.arranger.configure({ enabled: true, tempo: 240 });
        for (const note of [60, 64, 67]) await window.genova.noteOn(note, 96);
        for (const note of [60, 64, 67]) await window.genova.noteOff(note);
      });
      const cdp = await page.context().newCDPSession(page);
      const sample = async (cycle) => {
        await cdp.send('HeapProfiler.collectGarbage');
        const heap = await cdp.send('Runtime.getHeapUsage');
        const processes = await application.evaluate(({ app, BrowserWindow }) => ({
          mainMemoryBytes: process.memoryUsage(),
          rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
          metrics: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory }))
        }));
        report.memory.push({ cycle, elapsedMs: Date.now() - started, rendererHeapBytes: heap.usedSize, ...processes });
      };
      const cycle = async (duration) => {
        await page.evaluate(async () => {
          await window.genova.arranger.start();
          for (const note of [72, 76, 79]) await window.genova.noteOn(note, 75);
          await window.genova.sustain(true);
          await window.genova.pitchBend(2048);
        });
        await sleep(duration);
        await page.evaluate(async () => {
          for (const note of [72, 76, 79]) await window.genova.noteOff(note);
          await window.genova.silence();
        });
        const state = await snapshot();
        assert.equal(state.arranger.running, false);
        assert.equal(state.controls.sustain, false);
        assert.equal(state.controls.pitchBend, 0);
      };
      const started = Date.now();
      try {
        for (let i = 0; i < 3; i++) await cycle(200);
        await sample(0);
        for (let i = 1; i <= 30; i++) {
          await cycle(1000);
          if (i % 5 === 0) {
            await page.reload();
            await ready();
            await sample(i);
          }
        }
        const first = report.memory[0];
        const last = report.memory.at(-1);
        report.memorySummary = {
          cycles: 30, reloads: 6, elapsedMs: Date.now() - started,
          rendererHeapGrowthBytes: last.rendererHeapBytes - first.rendererHeapBytes,
          mainRssGrowthBytes: last.mainMemoryBytes.rss - first.mainMemoryBytes.rss,
          rendererHeapBoundBytes: 8 * 1024 * 1024,
          mainRssBoundBytes: 64 * 1024 * 1024,
          limitation: 'Short bounded churn test with renderer GC at sample points; not proof of zero long-term leaks.'
        };
        assert.ok(report.memorySummary.rendererHeapGrowthBytes < report.memorySummary.rendererHeapBoundBytes, 'retained renderer heap must remain bounded');
        assert.ok(report.memorySummary.mainRssGrowthBytes < report.memorySummary.mainRssBoundBytes, 'main process RSS must remain bounded');
        assert.ok(report.memory.every((entry) => entry.metrics.filter((item) => item.type === 'Tab').length === 1), 'exactly one renderer process');
      } finally { await cdp.detach(); }
      check('30 playback cycles, six reloads and measured bounded main/renderer memory');
    });

    assert.deepEqual(report.rendererErrors, []);
    const pid = (await snapshot()).status.pid;
    await application.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    report.success = report.checks.length === 4;
  } finally {
    await application.close().catch(() => {});
    await fs.writeFile(path.join(directory, 'electron-audit.json'), JSON.stringify(report, null, 2));
  }
});
