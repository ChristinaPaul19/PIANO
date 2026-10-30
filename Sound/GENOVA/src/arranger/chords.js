'use strict';

const QUALITIES = Object.freeze({
  major: [0, 4, 7], minor: [0, 3, 7], dominant7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dim: [0, 3, 6],
  aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7]
});
for (const intervals of Object.values(QUALITIES)) Object.freeze(intervals);
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SUFFIX = { major: '', minor: 'm', dominant7: '7', maj7: 'maj7', min7: 'm7', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4' };
function chord(root, quality) {
  return { root, quality, name: NAMES[root] + SUFFIX[quality], intervals: [...QUALITIES[quality]] };
}
function recognize(notes, previous = null) {
  const sorted = [...notes].filter(note => Number.isInteger(note) && note >= 0 && note < 72).sort((a, b) => a - b);
  const pcs = new Set(sorted.map(note => note % 12));
  if (pcs.size < 3 || pcs.size > 4) return null;
  const candidates = [];
  for (let root = 0; root < 12; root++) {
    for (const [quality, intervals] of Object.entries(QUALITIES)) {
      if (intervals.length === pcs.size && intervals.every(interval => pcs.has((root + interval) % 12))) {
        candidates.push(chord(root, quality));
      }
    }
  }
  return candidates.find(value => previous && value.root === previous.root && value.quality === previous.quality)
    || candidates.find(value => previous && value.root === previous.root)
    || candidates.find(value => value.root === sorted[0] % 12) || candidates[0] || null;
}
module.exports = { QUALITIES, chord, recognize };
