'use strict';
const { QUALITIES } = require('./chords');
const MAX_BARS = 128;
const MAX_EVENTS = 512;
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError('Invalid progression schema');
  }
}
function validate(document, beatsPerBar) {
  object(document, ['version', 'beatsPerBar', 'lengthBars', 'events']);
  if (document.version !== 1 || document.beatsPerBar !== beatsPerBar
    || ![3, 4].includes(document.beatsPerBar)
    || !Number.isInteger(document.lengthBars) || document.lengthBars < 1 || document.lengthBars > MAX_BARS
    || !Array.isArray(document.events) || document.events.length > MAX_EVENTS) {
    throw new RangeError('Invalid progression version, meter, length or event limit');
  }
  let previous = -1;
  const events = [];
  for (let index = 0; index < document.events.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(document.events, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid progression event');
    const event = descriptor.value;
    object(event, ['beat', 'root', 'quality']);
    if (!Number.isInteger(event.beat) || event.beat <= previous || event.beat >= beatsPerBar * document.lengthBars
      || !Number.isInteger(event.root) || event.root < 0 || event.root > 11
      || typeof event.quality !== 'string' || !Object.hasOwn(QUALITIES, event.quality)) {
      throw new RangeError('Invalid progression event');
    }
    previous = event.beat;
    events.push({ beat: event.beat, root: event.root, quality: event.quality });
  }
  return { version: 1, beatsPerBar, lengthBars: document.lengthBars, events };
}
module.exports = { validate, MAX_BARS, MAX_EVENTS };
