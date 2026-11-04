/**
 * Things on screen everywhere: the mute button (always on screen, LS-8), the settings sheet
 * with the comfort sliders (GF-5) and volumes (LS-10), and the rotate-your-phone prompt.
 */
import { onSettings, settings, updateSettings } from '../app/settings.ts';
import { audio } from '../audio/engine.ts';
import { ui } from '../audio/sfx.ts';
import type { BotLevel } from '../engine/bot.ts';
import type { ControlLayout } from '../app/settings.ts';
import { openControlsEditor } from './controls-editor.ts';
import { h, press, svg } from './dom.ts';
import { ICON } from './icons.ts';

let corner: HTMLElement;
let muteButton: HTMLButtonElement;

export function initOverlay(root: HTMLElement): void {
  muteButton = h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Mute' } });
  press(muteButton, () => toggleMute(), { sound: 'none' });
  const gear = press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Settings' } }, svg(ICON.gear)), () => openSettings());
  corner = h('div', { class: 'corner' }, muteButton, gear);
  const rotate = h(
    'div',
    { class: 'rotate', attrs: { role: 'alert' } },
    h('div', { class: 'phone' }, svg(ICON.stick, 'fig')),
    h('div', { class: 'display', style: 'font-size:34px', text: 'Turn your phone' }),
    h('p', { class: 'muted', style: 'margin:0;color:#cfc6b6;max-width:30ch', text: 'SticXcape plays sideways, so both fighters have room to move.' }),
  );
  root.append(corner, rotate);
  renderMute();
  onSettings(renderMute);
  audio.setMuted(settings.muted);
  audio.setVolumes({ music: settings.music, sfx: settings.sfx });
}

function renderMute(): void {
  muteButton.replaceChildren(svg(settings.muted ? ICON.muted : ICON.sound));
  muteButton.setAttribute('aria-label', settings.muted ? 'Unmute' : 'Mute');
}

export function toggleMute(): void {
  updateSettings({ muted: !settings.muted });
  audio.setMuted(settings.muted);
  if (!settings.muted) ui.toggle(true);
}

/** Dark corner buttons over the fight. */
export function setCornerDark(dark: boolean): void {
  corner.classList.toggle('is-dark', dark);
}

export function setCornerVisible(visible: boolean): void {
  corner.style.display = visible ? '' : 'none';
}

function slider(value: number, onInput: (v: number) => void, min = 0, max = 1, step = 0.05): HTMLInputElement {
  const input = h('input', { class: 'slider', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const paint = () => input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  paint();
  let last = 0;
  input.addEventListener('input', () => {
    paint();
    onInput(Number(input.value));
    const now = performance.now();
    if (now - last > 70) {
      ui.type();
      last = now;
    }
  });
  return input;
}

function toggle(on: boolean, onChange: (on: boolean) => void): HTMLButtonElement {
  const el = h('button', { class: `switch${on ? ' is-on' : ''}`, attrs: { role: 'switch', 'aria-checked': String(on) } });
  el.addEventListener('click', () => {
    const next = !el.classList.contains('is-on');
    el.classList.toggle('is-on', next);
    el.setAttribute('aria-checked', String(next));
    ui.toggle(next);
    onChange(next);
  });
  return el;
}

function row(title: string, hint: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'setting' }, h('div', { class: 'setting-text' }, h('span', { class: 'setting-title', text: title }), h('span', { class: 'setting-hint', text: hint })), control);
}

export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (value: T) => void): HTMLElement {
  const pill = h('i', { class: 'seg-pill' });
  const el = h('div', { class: 'seg', attrs: { role: 'radiogroup' } }, pill);
  const buttons = options.map((option) => {
    const b = h('button', { class: option.value === value ? 'is-on' : '', text: option.label, attrs: { role: 'radio', 'aria-checked': String(option.value === value) } });
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      for (const other of buttons) {
        other.classList.toggle('is-on', other === b);
        other.setAttribute('aria-checked', String(other === b));
      }
      place();
      ui.toggle(true);
      onChange(option.value);
    });
    el.append(b);
    return b;
  });
  const place = () => {
    const on = buttons.find((b) => b.classList.contains('is-on')) ?? buttons[0];
    pill.style.width = `${on.offsetWidth}px`;
    pill.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  };
  requestAnimationFrame(place);
  new ResizeObserver(place).observe(el);
  return el;
}

let sheetOpen = false;

export function openSettings(): void {
  if (sheetOpen) return;
  sheetOpen = true;
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const close = () => {
    sheet.classList.add('is-leaving');
    backdrop.classList.add('is-leaving');
    ui.back();
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
      sheetOpen = false;
    }, 250);
  };
  backdrop.addEventListener('click', close);
  const sheet = h(
    'aside',
    { class: 'sheet', attrs: { role: 'dialog', 'aria-label': 'Settings' } },
    h('div', { class: 'sheet-head' }, h('h2', { text: 'Settings' }), press(h('button', { class: 'btn btn-icon btn-ghost', attrs: { 'aria-label': 'Close' } }, svg(ICON.close)), close, { sound: 'none' })),
    h('div', { class: 'kicker', style: 'margin-top:4px', text: 'Sound' }),
    row('Music', 'Fight loop and menu track', slider(settings.music, (v) => {
      updateSettings({ music: v });
      audio.setVolumes({ music: v });
    })),
    row('Effects', 'Hits, whooshes and buttons', slider(settings.sfx, (v) => {
      updateSettings({ sfx: v });
      audio.setVolumes({ sfx: v });
    })),
    h('div', { class: 'kicker', style: 'margin-top:16px', text: 'Comfort' }),
    row('Screen shake', 'Down to off for motion sensitivity', slider(settings.shake, (v) => updateSettings({ shake: v }))),
    row('Flashes', 'Impact flashes and the KO frame', slider(settings.flashes, (v) => updateSettings({ flashes: v }))),
    row('Vibration', 'Android only; iPhones can’t vibrate from a browser', toggle(settings.vibration, (on) => updateSettings({ vibration: on }))),
    h('div', { class: 'kicker', style: 'margin-top:16px', text: 'Fight' }),
    row('Damage numbers', 'Show how much each hit took', toggle(settings.damageNumbers, (on) => updateSettings({ damageNumbers: on }))),
    h('div', { class: 'kicker', style: 'margin-top:16px', text: 'Controls' }),
    h(
      'div',
      { class: 'setting', style: 'flex-direction:column;align-items:stretch' },
      h('div', { class: 'setting-text' }, h('span', { class: 'setting-title', text: 'Layout' }), h('span', { class: 'setting-hint', text: 'One thumb puts every move around the stick on one side' })),
      segmented<ControlLayout>(
        [
          { value: 'two', label: 'Two thumbs' },
          { value: 'oneRight', label: 'One · right' },
          { value: 'oneLeft', label: 'One · left' },
        ],
        settings.controlLayout,
        (layout) => updateSettings({ controlLayout: layout }),
      ),
    ),
    row('Button size', 'Scale the on-screen controls', slider(settings.buttonScale, (v) => updateSettings({ buttonScale: v }), 0.75, 1.35, 0.05)),
    row('Arrange buttons', 'Drag each control where your thumbs rest', press(h('button', { class: 'btn btn-small', text: 'Arrange' }), () => openControlsEditor())),
    row(
      'Practice bot',
      'How sharp the bot reacts',
      segmented<BotLevel>(
        [
          { value: 'easy', label: 'Easy' },
          { value: 'normal', label: 'Normal' },
          { value: 'hard', label: 'Hard' },
        ],
        settings.botLevel,
        (level) => updateSettings({ botLevel: level }),
      ),
    ),
  );
  document.body.append(backdrop, sheet);
}
