'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertExited(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Engine did not expose its owned child PID.');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await sleep(50);
  }
  assert.fail(`FluidSynth process ${pid} was left running.`);
}

test('real Electron UI drives FluidSynth and recovers from process failure', { timeout: 180000 }, async (t) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [root], env, timeout: 60000 });
  let closed = false;
  const results = [];
  const rendererErrors = [];
  const output = path.join(root, 'verification', 'electron');
  await fs.mkdir(output, { recursive: true });
  try {
    const page = await application.firstWindow();
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', null, { timeout: 45000 });
    await page.waitForFunction(() => document.querySelector('#instrument').options.length === 128);
    await page.bringToFront();
    const ready = () => page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready');
    const heldCount = async (expected) => {
      await page.waitForFunction((count) => document.querySelectorAll('.key.is-held').length === count, expected);
    };
    const snapshot = () => page.evaluate(() => window.genova.snapshot());
    const checkpoint = (name) => results.push({ name, passed: true });

    await t.test('renderer is sandboxed and has only the narrow audio bridge', async () => {
      const preferences = await application.evaluate(({ BrowserWindow }) => {
        const settings = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return { nodeIntegration: settings.nodeIntegration, contextIsolation: settings.contextIsolation, sandbox: settings.sandbox, webSecurity: settings.webSecurity };
      });
      assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.equal(await page.evaluate(() => typeof window.genova.noteOn), 'function');
      assert.equal((await snapshot()).instruments.length, 128);
      await assert.rejects(page.evaluate(() => window.genova.noteOn(128, 96)), /note|127|range/i);
      checkpoint('Secure Electron renderer and validated MIDI bridge');
    });

    await t.test('piano, organ and strings selection with real note playback', async () => {
      for (const program of [0, 16, 48]) {
        await page.selectOption('#instrument', String(program));
        assert.equal(await page.evaluate(async () => (await window.genova.snapshot()).controls.program), program);
        await page.keyboard.down('a');
        await heldCount(1);
        await sleep(220);
        await page.keyboard.up('a');
        await heldCount(0);
      }
      checkpoint('Piano, organ, strings and instrument switching');
    });

    await t.test('polyphonic laptop notes and release', async () => {
      await page.keyboard.down('a');
      await page.keyboard.down('d');
      await page.keyboard.down('g');
      await heldCount(3);
      await sleep(250);
      await page.keyboard.up('d');
      await heldCount(2);
      await page.keyboard.up('a');
      await page.keyboard.up('g');
      await heldCount(0);
      checkpoint('Three-note polyphony and independent release');
    });

    await t.test('mouse and laptop can share a note without premature note-off', async () => {
      await page.locator('#keyboard').scrollIntoViewIfNeeded();
      const bounds = await page.locator('.key[data-note="60"]').boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 30);
      await page.mouse.down();
      await heldCount(1);
      await page.keyboard.down('a');
      await page.keyboard.down('d');
      await heldCount(2);
      await page.mouse.move(30, 30);
      await page.mouse.up();
      await heldCount(2);
      await page.keyboard.up('a');
      await page.keyboard.up('d');
      await heldCount(0);
      checkpoint('Pointer capture, mixed input and same-note ownership');
    });

    await t.test('multiple touch contacts play simultaneous notes', async () => {
      await page.locator('#keyboard').scrollIntoViewIfNeeded();
      const c = await page.locator('.key[data-note="60"]').boundingBox();
      const e = await page.locator('.key[data-note="64"]').boundingBox();
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart', touchPoints: [
            { id: 1, x: c.x + c.width / 2, y: c.y + c.height - 35 },
            { id: 2, x: e.x + e.width / 2, y: e.y + e.height - 35 }
          ]
        });
        await heldCount(2);
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await heldCount(0);
      } finally { await session.detach(); }
      checkpoint('Multitouch polyphony');
    });

    await t.test('sustain pedal, volume, velocity, pitch bend and panic', async () => {
      await page.click('#sustain');
      assert.equal((await snapshot()).controls.sustain, true);
      await page.keyboard.down('a');
      await page.keyboard.up('a');
      await heldCount(0);
      assert.equal((await snapshot()).controls.sustain, true);
      await page.click('#sustain');
      assert.equal((await snapshot()).controls.sustain, false);
      await page.keyboard.down('Space');
      assert.equal((await snapshot()).controls.sustain, true);
      await page.keyboard.up('Space');
      assert.equal((await snapshot()).controls.sustain, false);
      for (const [id, value] of [['volume', '65'], ['velocity', '40'], ['bend', '4096']]) {
        await page.locator(`#${id}`).evaluate((element, next) => {
          element.value = next;
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
      }
      assert.equal((await snapshot()).controls.volume, 65);
      assert.equal((await snapshot()).controls.pitchBend, 4096);
      assert.equal(await page.locator('#velocity-value').textContent(), '40');
      await page.keyboard.down('a');
      await heldCount(1);
      await page.keyboard.press('Escape');
      await heldCount(0);
      await page.keyboard.up('a');
      assert.equal((await snapshot()).controls.pitchBend, 0);
      assert.equal((await snapshot()).controls.sustain, false);
      checkpoint('Sustain, velocity, volume, pitch bend and panic controls');
    });

    await t.test('octave shifting, bounded range and blur release', async () => {
      await page.keyboard.press('x');
      assert.equal(await page.locator('#octave-value').textContent(), '+1');
      await page.keyboard.down('a');
      await page.waitForFunction(() => document.querySelector('.key[data-note="72"]').classList.contains('is-held'));
      await page.keyboard.up('a');
      await page.keyboard.press('z');
      assert.equal(await page.locator('#octave-value').textContent(), '0');
      await page.keyboard.down('a');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await heldCount(0);
      await page.keyboard.up('a');
      for (let i = 0; i < 5; i++) await page.keyboard.press('x');
      assert.equal(await page.locator('#octave-value').textContent(), '+3');
      assert.equal(await page.locator('#octave-up').isDisabled(), true);
      for (let i = 0; i < 3; i++) await page.keyboard.press('z');
      checkpoint('Octave shift bounds and lost-focus cleanup');
    });

    await t.test('renderer reload clears held notes and sustain without leaking a process', async () => {
      const pid = (await snapshot()).status.pid;
      await page.click('#sustain');
      await page.keyboard.down('a');
      await heldCount(1);
      await page.reload();
      await ready();
      await page.waitForFunction(() => !document.querySelector('#power').disabled);
      await heldCount(0);
      await page.keyboard.up('a');
      assert.equal((await snapshot()).controls.sustain, false);
      assert.equal((await snapshot()).status.pid, pid);
      checkpoint('Renderer reload releases notes and sustain');
    });

    await t.test('stop/start lifecycle leaves no old synthesizer', async () => {
      const oldPid = (await snapshot()).status.pid;
      await page.click('#power');
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'stopped');
      await assertExited(oldPid);
      assert.equal(await page.locator('.key').first().isDisabled(), true);
      await page.click('#power');
      await ready();
      await page.waitForFunction(() => !document.querySelector('#power').disabled);
      assert.equal((await snapshot()).controls.program, 0);
      checkpoint('Audio stop/start and process cleanup');
    });

    await t.test('a real FluidSynth crash is reported and retry restores playback', async () => {
      const pid = (await snapshot()).status.pid;
      assert.ok(Number.isInteger(pid) && pid > 0);
      process.kill(pid);
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'error');
      assert.equal(await page.locator('.key').first().isDisabled(), true);
      assert.equal(await page.locator('#error').isVisible(), true);
      await page.click('#power');
      await ready();
      await page.waitForFunction(() => !document.querySelector('#power').disabled);
      await page.keyboard.down('a');
      await heldCount(1);
      await page.keyboard.up('a');
      await heldCount(0);
      checkpoint('Unexpected process exit and manual retry recovery');
    });

    await page.screenshot({ path: path.join(output, 'keyboard.png'), fullPage: true });
    assert.deepEqual(rendererErrors, []);
    assert.equal(await page.locator('#error').isVisible(), false);
    const finalPid = (await snapshot()).status.pid;
    await application.close();
    closed = true;
    await assertExited(finalPid);
    checkpoint('Application exit shuts down FluidSynth');
  } finally {
    if (!closed) await application.close().catch(() => {});
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ testedAt: new Date().toISOString(), checks: results, rendererErrors, note: 'Real Electron and WASAPI exercised; physical speaker audibility not independently measured.' }, null, 2));
  }
});
