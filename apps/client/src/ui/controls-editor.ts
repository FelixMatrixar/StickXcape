/**
 * Arrange buttons: drag each on-screen control to where your thumbs rest. Opened from Settings;
 * positions are saved per layout as soon as a button is dropped.
 */
import { settings } from '../app/settings.ts';
import { ui } from '../audio/sfx.ts';
import { Controls, LAYOUT_NAMES } from './controls.ts';
import { h, press } from './dom.ts';

export function openControlsEditor(onClose?: () => void): void {
  const controls = new Controls({ editing: true, layout: settings.controlLayout });
  const reset = press(h('button', { class: 'btn btn-small' }, 'Reset'), () => {
    controls.reset();
    ui.back();
  }, { sound: 'none' });
  const done = press(h('button', { class: 'btn btn-small btn-primary', style: 'font-size:16px;min-height:38px' }, 'Done'), () => close(), { sound: 'confirm' });
  const bar = h(
    'div',
    { class: 'editor-bar' },
    h('div', null, h('div', { class: 'kicker', style: 'color:#f2b134', text: LAYOUT_NAMES[settings.controlLayout] }), h('div', { class: 'editor-hint', text: 'Drag the buttons to where your thumbs rest.' })),
    h('div', { style: 'display:flex;gap:8px' }, reset, done),
  );
  const overlay = h('div', { class: 'controls-editor', attrs: { role: 'dialog', 'aria-label': 'Arrange buttons' } }, h('div', { class: 'editor-floor' }), controls.el, bar);
  const close = () => {
    overlay.classList.add('is-leaving');
    setTimeout(() => {
      controls.destroy();
      overlay.remove();
      onClose?.();
    }, 220);
  };
  document.body.append(overlay);
}
