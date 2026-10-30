'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 1024 * 1024;

class ProgressionStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('Progression path must be absolute.');
    this.filePath = filePath;
  }

  async save(document) {
    const content = JSON.stringify(document, null, 2);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new RangeError('Progression exceeds the 1 MiB limit.');
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', encoding: 'utf8' });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async load() {
    let handle;
    try {
      handle = await fs.open(this.filePath, 'r');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new RangeError('Saved progression exceeds the 1 MiB limit.');
      return JSON.parse(bytes.toString('utf8', 0, size).replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('No saved progression yet. Record chords and choose Save first.');
      if (error instanceof SyntaxError) throw new Error('The saved progression is not valid JSON.');
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }
}

module.exports = { ProgressionStore };
