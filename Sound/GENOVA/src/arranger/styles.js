'use strict';

// Original step recipes: four steps per beat, never imported song/style data.
const RECIPES = {
  pop: {
    name: 'Pop', beatsPerBar: 4, defaultTempo: 112,
    mains: [
      { kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [[0, 0, 3], [6, 2, 2], [8, 0, 3], [14, 1, 2]] },
      { kick: [0, 6, 8, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14, 15], bass: [[0, 0, 2], [4, 1, 2], [8, 2, 3], [12, 0, 2], [14, 2, 2]] },
      { kick: [0, 3, 8, 10], snare: [4, 11, 12], hat: [0, 1, 2, 4, 6, 7, 8, 10, 12, 14], bass: [[0, 0, 3], [3, 2, 1], [6, 1, 2], [8, 0, 2], [11, 2, 1], [14, 0, 2]] },
      { kick: [0, 4, 8, 12, 15], snare: [4, 10, 12, 14], hat: [0, 2, 3, 4, 6, 8, 9, 10, 12, 14, 15], bass: [[0, 0, 2], [2, 2, 2], [4, 1, 2], [6, 2, 2], [8, 0, 3], [12, 3, 2], [14, 2, 2]] }
    ]
  },
  rock: {
    name: 'Rock', beatsPerBar: 4, defaultTempo: 126,
    mains: [
      { kick: [0, 2, 8, 10], snare: [4, 12], hat: [0, 4, 8, 12], bass: [[0, 0, 2], [2, 0, 2], [4, 2, 3], [8, 0, 2], [10, 0, 2], [12, 2, 3]] },
      { kick: [0, 2, 6, 8, 10], snare: [4, 12, 15], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [[0, 0, 2], [2, 2, 2], [4, 0, 2], [6, 1, 2], [8, 0, 2], [10, 2, 2], [12, 0, 3]] },
      { kick: [0, 3, 6, 8, 11, 14], snare: [4, 7, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], bass: [[0, 0, 3], [3, 0, 1], [6, 2, 2], [8, 1, 3], [11, 2, 1], [14, 0, 2]] },
      { kick: [0, 2, 5, 8, 10, 13, 15], snare: [4, 7, 12, 14], hat: [0, 1, 2, 4, 6, 8, 9, 10, 12, 14], bass: [[0, 0, 2], [2, 0, 2], [4, 2, 2], [6, 3, 2], [8, 0, 2], [10, 1, 2], [12, 2, 2], [14, 0, 2]] }
    ]
  },
  waltz: {
    name: 'Waltz', beatsPerBar: 3, defaultTempo: 96,
    mains: [
      { kick: [0], snare: [4, 8], hat: [2, 6, 10], bass: [[0, 0, 4], [4, 2, 3], [8, 1, 3]] },
      { kick: [0, 10], snare: [4, 8], hat: [0, 2, 4, 6, 8, 10], bass: [[0, 0, 3], [4, 1, 3], [8, 2, 2], [10, 0, 2]] },
      { kick: [0, 6], snare: [4, 8, 11], hat: [0, 2, 3, 6, 7, 10], bass: [[0, 0, 3], [3, 2, 1], [4, 1, 3], [8, 3, 2], [10, 2, 2]] },
      { kick: [0, 3, 6, 10], snare: [4, 7, 8], hat: [0, 2, 4, 5, 6, 8, 9, 10], bass: [[0, 0, 2], [2, 2, 2], [4, 1, 2], [6, 2, 2], [8, 3, 2], [10, 0, 2]] }
    ]
  }
};
function drum(step, note, velocity = 85) { return { step, channel: 9, note, velocity, duration: 1 }; }
function bass([step, degree, duration]) { return { step, channel: 1, degree, duration, velocity: 88 }; }
const STYLES = Object.fromEntries(Object.entries(RECIPES).map(([id, recipe], styleIndex) => {
  const steps = recipe.beatsPerBar * 4;
  const patterns = {};
  recipe.mains.forEach((main, index) => {
    patterns['ABCD'[index]] = { bars: 1, events: [
      ...main.kick.map(step => drum(step, 36, 100 + index * 3)),
      ...main.snare.map(step => drum(step, id === 'waltz' ? 37 : 38, 84 + index * 4)),
      ...main.hat.map((step, i) => drum(step, id === 'rock' && index > 1 ? 51 : 42, i % 2 ? 56 : 72)),
      ...main.bass.map(bass), ...(index === 3 ? [drum(0, 49, 80)] : [])
    ] };
  });
  patterns.intro = { bars: 2, events: [drum(0, 36, 90), drum(0, 49, 65), bass([0, 0, 4]),
    ...Array.from({ length: recipe.beatsPerBar }, (_, i) => drum(i * 4 + 2, 42, 55)),
    ...patterns.A.events.map(event => ({ ...event, step: event.step + steps })),
    drum(steps * 2 - 2, 45 + styleIndex * 2, 80), drum(steps * 2 - 1, 38, 88)] };
  patterns.fill = { bars: 1, events: [drum(0, 36, 105), bass([0, 0, 4]),
    ...Array.from({ length: steps / 2 }, (_, i) => drum(i * 2, [38, 48 - styleIndex, 45, 43][(i + styleIndex) % 4], 72 + i * 3)),
    drum(steps - 1, 38, 110), bass([steps - 4, 2, 3])] };
  patterns.break = { bars: 1, events: [drum(0, 36, 110), drum(0, 49 - styleIndex * 2, 95), bass([0, 0, 1]),
    drum(steps - 2, id === 'waltz' ? 37 : 42, 48)] };
  patterns.ending = { bars: 2, events: [
    ...patterns.B.events.filter(event => event.step < steps - 2),
    drum(steps, 36, 112), drum(steps, 49, 95), bass([steps, 0, steps - 1]),
    drum(steps + 2 + styleIndex, 42, 40)] };
  return [id, { id, name: recipe.name, beatsPerBar: recipe.beatsPerBar, defaultTempo: recipe.defaultTempo, patterns }];
}));
const styleList = () => Object.values(STYLES).map(({ id, name, beatsPerBar, defaultTempo }) => ({ id, name, beatsPerBar, defaultTempo }));
module.exports = { STYLES, styleList };
