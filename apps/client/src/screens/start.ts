/** First run, step 2: record your moves in Move Studio, or start with the default moveset. */
import { myInk } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { defaultMoves } from '../moves/defaults.ts';
import { MovePreview } from '../render/preview.ts';
import { h, press, stagger, svg, tilt } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';

export function startScreen(choose: (record: boolean) => void): Screen {
  const recordArt = h('canvas');
  const skipArt = h('canvas');
  const record = press(
    h(
      'button',
      { class: 'card choice is-tappable is-featured rise' },
      h('div', { class: 'choice-art' }, recordArt),
      h('div', { style: 'display:flex;align-items:center;gap:8px' }, svg(ICON.camera), h('span', { class: 'kicker', style: 'color:#f2b134', text: 'About 10 minutes' })),
      h('h3', { text: 'Record my moves' }),
      h('p', { text: 'Prop your phone up, stand side-on and throw four moves: light, heavy, low and special.' }),
    ),
    () => choose(true),
    { sound: 'confirm' },
  );
  const skip = press(
    h(
      'button',
      { class: 'card choice is-tappable rise' },
      h('div', { class: 'choice-art' }, skipArt),
      h('div', { style: 'display:flex;align-items:center;gap:8px' }, svg(ICON.bolt), h('span', { class: 'kicker', text: 'Fight right now' })),
      h('h3', { text: 'Use the default moves' }),
      h('p', { text: 'Start with the house moveset. You can record your own any time from the home screen.' }),
    ),
    () => choose(false),
    { sound: 'confirm' },
  );
  tilt(record);
  tilt(skip);
  const choices = h('div', { class: 'choices' }, record, skip);
  const el = h(
    'section',
    null,
    h(
      'div',
      { class: 'split' },
      h('div', { class: 'rise' }, h('div', { class: 'kicker', text: 'Step 2 of 2' }), h('h1', { class: 'hero-title', html: 'Your body writes the <em>move list</em>.' }), h('p', { class: 'lede', text: 'Every fighter’s moves are captured from a real person, so no two players fight alike. The camera only tracks your body: the video never leaves your phone.' })),
      choices,
    ),
  );
  const ink = myInk();
  const a = new MovePreview(recordArt, { ink, floor: 'rgba(255,255,255,0.12)', outline: 'rgba(255,250,240,0.85)', span: 2.4 });
  const b = new MovePreview(skipArt, { ink, span: 2.4 });
  const moves = defaultMoves();
  a.setMove(moves[5]);
  b.setMove(moves[3]);
  return {
    el,
    enter() {
      stagger(choices, 1);
      a.play();
      b.play();
    },
    leave() {
      a.destroy();
      b.destroy();
    },
  };
}
