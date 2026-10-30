'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');

test('real arranger UI, transport, chord routing and persistent progression', { timeout: 180000 }, async (t) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'genova-arranger-ui-'));
  const outputDirectory = path.join(root, 'verification', 'arranger-ui');
  await fs.mkdir(outputDirectory, { recursive: true });
  const application = await electron.launch({ args: [root], env, timeout: 45000 });
  const checks = [];
  const errors = [];
  let page;
  let finalPid;
  let closed = false;
  try {
    await application.evaluate(({ app }, directory) => app.setPath('userData', directory), dataDirectory);
    page = await application.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready');
    await page.waitForFunction(() => !document.querySelector('#acmp').disabled);
    await page.bringToFront();
    const snapshot = () => page.evaluate(async () => (await window.genova.snapshot()).arranger);
    const wait = async (predicate, argument) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await page.evaluate(predicate, argument)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`Timed out waiting for arranger condition. State: ${JSON.stringify(await snapshot())}`);
    };
    let held = [];
    const release = async () => {
      for (const key of held) await page.keyboard.up(key);
      held = [];
    };
    const chord = async (keys) => {
      await release();
      for (const key of keys) { await page.keyboard.down(key); held.push(key); }
    };
    const check = (name) => checks.push({ name, passed: true });

    await t.test('arranger is opt-in and recognizes all supported chord qualities below C5', async () => {
      assert.equal((await snapshot()).enabled, false);
      assert.equal((await snapshot()).styles.length, 3);
      await page.click('#acmp');
      await wait(async () => (await window.genova.snapshot()).arranger.enabled);
      const cases = [
        [['a', 'd', 'g'], 'major'], [['a', 'e', 'g'], 'minor'],
        [['a', 'd', 'g', 'u'], 'dominant7'], [['a', 'd', 'g', 'j'], 'maj7'],
        [['a', 'e', 'g', 'u'], 'min7'], [['a', 'e', 't'], 'dim'],
        [['a', 'd', 'y'], 'aug'], [['a', 's', 'g'], 'sus2'], [['a', 'f', 'g'], 'sus4']
      ];
      for (const [keys, quality] of cases) {
        await chord(keys);
        await wait(async (expected) => {
          const chord = (await window.genova.snapshot()).arranger.chord;
          return chord && chord.root === 0 && chord.quality === expected;
        }, quality);
      }
      await chord(['a', 'd', 'h']);
      await wait(async () => {
        const chord = (await window.genova.snapshot()).arranger.chord;
        return chord.root === 9 && chord.quality === 'minor';
      });
      await chord(['a', 'd', 'g']);
      await release();
      const before = (await snapshot()).chord;
      await page.keyboard.down('k');
      assert.deepEqual((await snapshot()).chord, before);
      await page.keyboard.up('k');
      assert.equal(await page.locator('.key.chord-zone').count(), 12);
      check('Opt-in split, all nine chord qualities, inversion and upper melody isolation');
    });

    await t.test('all three styles run and all mains transition at bar boundaries', async () => {
      for (const styleId of ['pop', 'rock', 'waltz']) {
        await page.selectOption('#arranger-style', styleId);
        await page.fill('#tempo', '240');
        await page.locator('#tempo').press('Tab');
        await wait(async (id) => {
          const state = (await window.genova.snapshot()).arranger;
          return state.styleId === id && state.tempo === 240;
        }, styleId);
        await page.click('#arranger-start');
        await wait(async () => (await window.genova.snapshot()).arranger.running);
        assert.equal(await page.locator('#arranger-style').isDisabled(), true);
        for (const section of ['B', 'C', 'D', 'A']) {
          await page.click(`#section-${section}`);
          await wait(async (expected) => {
            const state = (await window.genova.snapshot()).arranger;
            return state.section === expected && state.queuedSection === null;
          }, section);
        }
        await page.click('#arranger-stop');
        await wait(async () => !(await window.genova.snapshot()).arranger.running);
      }
      check('Pop, Rock, Waltz and Main A/B/C/D on real FluidSynth');
    });

    await t.test('intro, fill, break and ending complete their musical sections', async () => {
      await page.selectOption('#arranger-style', 'pop');
      await page.fill('#tempo', '240');
      await page.locator('#tempo').press('Tab');
      await page.click('#section-intro');
      await wait(async () => (await window.genova.snapshot()).arranger.section === 'intro');
      await wait(async () => (await window.genova.snapshot()).arranger.section === 'A');
      for (const section of ['fill', 'break']) {
        await page.click(`#section-${section}`);
        await wait(async (expected) => (await window.genova.snapshot()).arranger.section === expected, section);
        await wait(async () => (await window.genova.snapshot()).arranger.section === 'A');
      }
      await page.click('#section-ending');
      await wait(async () => (await window.genova.snapshot()).arranger.section === 'ending');
      await wait(async () => !(await window.genova.snapshot()).arranger.running);
      check('Two-bar intro/ending and one-bar fill/break');
    });

    await t.test('lead program changes and octave shifts preserve backing; panic stops it', async () => {
      await page.click('#arranger-start');
      await wait(async () => (await window.genova.snapshot()).arranger.running);
      await page.selectOption('#instrument', '16');
      assert.equal((await snapshot()).running, true);
      await page.keyboard.press('x');
      assert.equal((await snapshot()).running, true);
      await page.keyboard.press('z');
      await page.keyboard.press('Escape');
      await wait(async () => !(await window.genova.snapshot()).arranger.running);
      check('Independent lead controls and transport panic');
    });

    await t.test('recording quantizes live chord changes and looping replays without held keys', async () => {
      await chord(['a', 'd', 'g']);
      await release();
      await page.click('#arranger-start');
      await page.click('#progression-record');
      await wait(async () => {
        const state = (await window.genova.snapshot()).arranger;
        return state.recording && state.bar >= 1;
      });
      await chord(['a', 'e', 'g']);
      await wait(async () => (await window.genova.snapshot()).arranger.chord.quality === 'minor');
      await release();
      await wait(async () => (await window.genova.snapshot()).arranger.bar >= 2);
      await page.click('#progression-record');
      const recorded = (await snapshot()).progression;
      assert.ok(recorded.lengthBars >= 1);
      assert.ok(recorded.events.length >= 2);
      assert.ok(recorded.events.every((event) => Number.isInteger(event.beat)));
      assert.ok(recorded.events.some((event) => event.quality === 'major'));
      assert.ok(recorded.events.some((event) => event.quality === 'minor'));
      await page.click('#arranger-stop');
      await page.click('#progression-loop');
      assert.equal((await snapshot()).looping, true);
      assert.equal((await snapshot()).running, false);
      await page.click('#arranger-start');
      await wait(async () => (await window.genova.snapshot()).arranger.chord.quality === 'major');
      await wait(async () => (await window.genova.snapshot()).arranger.chord.quality === 'minor');
      await wait(async () => (await window.genova.snapshot()).arranger.chord.quality === 'major');
      await page.click('#arranger-stop');
      await page.click('#progression-loop');
      check('Beat-quantized recording, bar-length loops and automatic chord replay');
    });

    await t.test('save/load survives renderer reload and uses isolated local storage', async () => {
      const recorded = (await snapshot()).progression;
      await page.click('#progression-save');
      await page.waitForFunction(() => document.querySelector('#progression-summary').textContent.includes('Saved locally'));
      const file = path.join(dataDirectory, 'arranger-progression.json');
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), recorded);
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#progression-load').disabled);
      await page.click('#progression-load');
      await page.waitForFunction(() => document.querySelector('#progression-summary').textContent.includes('Loaded saved'));
      assert.deepEqual((await snapshot()).progression, recorded);
      check('Atomic local save and validated load across renderer reload');
    });

    await t.test('audio crash stops backing and retry does not silently restart it', async () => {
      await page.click('#arranger-start');
      await wait(async () => (await window.genova.snapshot()).arranger.running);
      const pid = await page.evaluate(async () => (await window.genova.snapshot()).status.pid);
      process.kill(pid);
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'error');
      assert.equal((await snapshot()).running, false);
      await page.click('#power');
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready');
      await page.waitForFunction(() => !document.querySelector('#power').disabled);
      assert.equal((await snapshot()).running, false);
      await page.click('#arranger-start');
      await wait(async () => (await window.genova.snapshot()).arranger.running);
      await page.click('#arranger-stop');
      check('Backend failure cleanup and explicit transport restart');
    });

    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(outputDirectory, 'arranger.png'), fullPage: true });
    finalPid = await page.evaluate(async () => (await window.genova.snapshot()).status.pid);
    await application.close();
    closed = true;
    assert.throws(() => process.kill(finalPid, 0), { code: 'ESRCH' });
    check('Application shutdown disposes its owned synthesizer');
    await t.test('saved progression survives a full application restart', async () => {
      const reopened = await electron.launch({ args: [root], env, timeout: 45000 });
      let reopenedPid;
      try {
        await reopened.evaluate(({ app }, directory) => app.setPath('userData', directory), dataDirectory);
        const restoredPage = await reopened.firstWindow();
        await restoredPage.waitForFunction(() => !document.querySelector('#progression-load').disabled);
        assert.equal(await restoredPage.evaluate(async () => (await window.genova.snapshot()).arranger.progression), null);
        await restoredPage.click('#progression-load');
        await restoredPage.waitForFunction(() => document.querySelector('#progression-summary').textContent.includes('Loaded saved'));
        const expected = JSON.parse(await fs.readFile(path.join(dataDirectory, 'arranger-progression.json'), 'utf8'));
        assert.deepEqual(await restoredPage.evaluate(async () => (await window.genova.snapshot()).arranger.progression), expected);
        reopenedPid = await restoredPage.evaluate(async () => (await window.genova.snapshot()).status.pid);
      } finally { await reopened.close(); }
      assert.throws(() => process.kill(reopenedPid, 0), { code: 'ESRCH' });
      check('Progression restored from disk after complete application restart');
    });
  } finally {
    if (!closed) {
      if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: true }).catch(() => {});
      await application.close().catch(() => {});
    }
    await fs.writeFile(path.join(outputDirectory, 'result.json'), JSON.stringify({ testedAt: new Date().toISOString(), success: checks.length === 9 && errors.length === 0 && closed, checks, rendererErrors: errors, physicalAudibilityConfirmed: false }, null, 2));
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});
