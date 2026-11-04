/** First run: pick a nickname and your ink colour (LS-2: you are always drawn in it). */
import { cleanText, NICKNAME_MAX_LENGTH } from '@sticxcape/shared';
import { randomNickname } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { ui } from '../audio/sfx.ts';
import { defaultMoves } from '../moves/defaults.ts';
import { INKS, inkById } from '../render/inks.ts';
import { MovePreview } from '../render/preview.ts';
import { h, press, stagger, svg, toast } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';

export function nicknameScreen(onDone: () => void, options: { step?: string; editing?: boolean } = {}): Screen {
  const input = h('input', {
    class: 'input input-big',
    value: settings.nickname ?? '',
    placeholder: 'Your name',
    maxLength: NICKNAME_MAX_LENGTH,
    autocomplete: 'nickname',
    attrs: { 'aria-label': 'Nickname', enterkeyhint: 'done', spellcheck: 'false' },
  });
  const count = h('span', { class: 'kicker', text: `${input.value.length}/${NICKNAME_MAX_LENGTH}` });
  const dice = press(h('button', { class: 'btn btn-icon dice', attrs: { 'aria-label': 'Random name' } }, svg(ICON.dice)), () => {
    dice.classList.remove('is-rolling');
    void dice.offsetWidth;
    dice.classList.add('is-rolling');
    input.value = randomNickname();
    input.dispatchEvent(new Event('input'));
    setTimeout(() => dice.classList.remove('is-rolling'), 650);
  }, { sound: 'pop' });
  input.addEventListener('input', () => {
    count.textContent = `${input.value.length}/${NICKNAME_MAX_LENGTH}`;
    ui.type();
  });

  const previewCanvas = h('canvas', { class: 'preview-fig' });
  let ink = inkById(settings.ink);
  const preview = new MovePreview(previewCanvas, { ink, span: 2.2, rest: 0.8 });
  const moves = defaultMoves();
  let showcase = 0;
  const cycle = () => {
    preview.setMove(moves[[0, 2, 5, 3][showcase % 4]]);
    showcase += 1;
  };
  cycle();
  const timer = setInterval(cycle, 2200);

  const swatches = h('div', { class: 'swatches', attrs: { role: 'radiogroup', 'aria-label': 'Ink colour' } });
  for (const option of INKS) {
    const sw = h('button', { class: `swatch${option.id === ink.id ? ' is-on' : ''}`, style: `--c:${option.ink}`, attrs: { role: 'radio', 'aria-label': option.name, 'aria-checked': String(option.id === ink.id) } });
    press(sw, () => {
      ink = option;
      for (const other of swatches.children) {
        other.classList.toggle('is-on', other === sw);
        other.setAttribute('aria-checked', String(other === sw));
      }
      preview.setInk(option);
      document.documentElement.style.setProperty('--ink-color', option.ink);
    }, { sound: 'pop', noRipple: true });
    swatches.append(sw);
  }

  const go = press(h('button', { class: 'btn btn-primary', style: 'align-self:flex-start' }, options.editing ? 'Save' : 'Continue', svg(ICON.arrow)), () => submit(), { sound: 'none' });
  const submit = () => {
    const name = cleanText(input.value || randomNickname(), NICKNAME_MAX_LENGTH);
    if (!name) {
      toast('Pick a name with letters or numbers.', 'error');
      input.focus();
      return;
    }
    ui.confirm();
    updateSettings({ nickname: name, ink: ink.id });
    onDone();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  const left = h(
    'div',
    { class: 'rise' },
    h('div', { class: 'kicker', text: options.step ?? 'Welcome' }),
    h('h1', { class: 'hero-title', html: 'What do they <em>call</em> you?' }),
    h('p', { class: 'lede', text: 'Your name shows over your health bar. Your ink is the colour you fight in; opponents get a contrasting one.' }),
    previewCanvas,
  );
  const right = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:18px' },
    h('div', { class: 'field rise' }, h('div', { style: 'display:flex;justify-content:space-between' }, h('span', { class: 'field-label', text: 'Nickname' }), count), h('div', { class: 'nick-row' }, input, dice)),
    h('div', { class: 'field rise' }, h('span', { class: 'field-label', text: 'Your ink' }), swatches),
    h('div', { class: 'rise' }, go),
  );
  const el = h('section', { class: 'nick' }, h('div', { class: 'split' }, left, right));
  return {
    el,
    enter() {
      stagger(right);
      preview.play();
      if (matchMedia('(pointer: fine)').matches) input.focus();
    },
    leave() {
      clearInterval(timer);
      preview.destroy();
    },
  };
}
