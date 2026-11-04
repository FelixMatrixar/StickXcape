/** A bottom sheet like Settings, for short choices (report a player, pick a photo arena). */
import { ui } from '../audio/sfx.ts';
import { h, press, svg } from './dom.ts';
import { ICON } from './icons.ts';

export interface Sheet {
  close(): void;
}

export function openSheet(title: string, ...body: (HTMLElement | null)[]): Sheet {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.classList.add('is-leaving');
    backdrop.classList.add('is-leaving');
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
    }, 250);
  };
  backdrop.addEventListener('click', () => {
    ui.back();
    close();
  });
  const sheet = h(
    'aside',
    { class: 'sheet', attrs: { role: 'dialog', 'aria-label': title } },
    h('div', { class: 'sheet-head' }, h('h2', { text: title }), press(h('button', { class: 'btn btn-icon btn-ghost', attrs: { 'aria-label': 'Close' } }, svg(ICON.close)), close, { sound: 'back' })),
    ...body,
  );
  document.body.append(backdrop, sheet);
  return { close };
}
