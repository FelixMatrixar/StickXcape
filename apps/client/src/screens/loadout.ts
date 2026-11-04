/**
 * Loadout: nine moves (two light, two heavy, low, special, defense, taunt, victory). Each card
 * loops its move and shows its traits (CB-9): the height it lands at and whether it's light or
 * heavy. Tap a card to swap the move, record a new one, or delete a recording.
 */
import type { MoveFile } from '@sticxcape/shared';
import { myInk, myLoadout } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { ui } from '../audio/sfx.ts';
import { defaultMoves, isDefaultMove } from '../moves/defaults.ts';
import { library } from '../moves/library.ts';
import { LOADOUT_KEYS, type LoadoutKey } from '../moves/loadout.ts';
import { MovePreview } from '../render/preview.ts';
import { h, press, stagger, svg, tilt, toast } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';

export function traitTags(move: MoveFile): HTMLElement[] {
  const glyph = move.height === 'high' ? '▲' : move.height === 'low' ? '▼' : '●';
  const tags = [h('span', { class: `tag tag-${move.height}` }, h('span', { class: 'tag-glyph', text: glyph, attrs: { 'aria-hidden': 'true' } }), move.height)];
  if (move.slot === 'heavy' || move.slot === 'special') tags.push(h('span', { class: 'tag tag-heavy', text: 'Heavy' }));
  else if (move.slot === 'light') tags.push(h('span', { class: 'tag', text: 'Light' }));
  return tags;
}

export function loadoutScreen(actions: { back(): void; record(key: LoadoutKey): void }): Screen {
  const ink = myInk();
  const grid = h('div', { class: 'slots' });
  const previews: MovePreview[] = [];
  const el = h(
    'section',
    { class: 'loadout' },
    h(
      'header',
      { class: 'screen-head' },
      press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Back' } }, svg(ICON.back)), () => actions.back(), { sound: 'back' }),
      h('div', null, h('div', { class: 'kicker', text: 'Your nine moves' }), h('h1', { text: 'Loadout' })),
    ),
    grid,
  );

  function render(stamped?: LoadoutKey): void {
    for (const p of previews.splice(0)) p.destroy();
    grid.replaceChildren();
    const loadout = myLoadout();
    LOADOUT_KEYS.forEach((key, i) => {
      const move = loadout[i];
      const mine = !isDefaultMove(move.id);
      const canvas = h('canvas');
      const card = press(
        h(
          'button',
          { class: `card slot is-tappable rise${mine ? ' is-recorded' : ''}${stamped === key.key ? ' is-stamped' : ''}` },
          h('div', { class: 'slot-top' }, h('span', { class: 'kicker', style: 'color:var(--ink)', text: key.label }), h('span', { class: 'slot-input', text: key.input })),
          canvas,
          h('div', { class: 'slot-name', text: move.name }),
          h('div', { class: 'slot-tags' }, ...traitTags(move), mine ? h('span', { class: 'tag tag-ai', text: 'Yours' }) : null),
        ),
        () => openPicker(key.key),
      );
      tilt(card, 6);
      grid.append(card);
      const preview = new MovePreview(canvas, { ink, span: 2.4, rest: 0.6, trails: true });
      preview.setMove(move);
      preview.play();
      previews.push(preview);
    });
    const record = press(
      h('button', { class: 'card slot is-tappable rise', style: 'align-items:center;justify-content:center;gap:8px;background:var(--ink);color:var(--paper);box-shadow:4px 4px 0 var(--red)' }, svg(ICON.camera), h('div', { class: 'slot-name', text: 'Record new' }), h('small', { style: 'opacity:.75;font:600 11px/1.3 var(--ui);text-align:center', text: 'Opens Move Studio' })),
      () => actions.record('light1'),
    );
    grid.append(record);
    stagger(grid);
  }

  function openPicker(key: LoadoutKey): void {
    const index = LOADOUT_KEYS.findIndex((k) => k.key === key);
    const place = LOADOUT_KEYS[index];
    const loadout = myLoadout();
    const currentId = loadout[index].id;
    const options: MoveFile[] = [defaultMoves()[index], ...defaultMoves().filter((m, i) => i !== index && m.slot === place.slot), ...library.files().filter((m) => m.slot === place.slot)];
    const backdrop = h('div', { class: 'sheet-backdrop' });
    const sheetPreviews: MovePreview[] = [];
    const close = () => {
      sheet.classList.add('is-leaving');
      backdrop.classList.add('is-leaving');
      for (const p of sheetPreviews) p.destroy();
      setTimeout(() => {
        sheet.remove();
        backdrop.remove();
      }, 250);
    };
    backdrop.addEventListener('click', close);
    const list = h('div', { class: 'picker-list' });
    for (const move of options) {
      const canvas = h('canvas');
      const recorded = library.get(move.id);
      const del = recorded
        ? press(h('button', { class: 'btn btn-icon btn-small', attrs: { 'aria-label': `Delete ${move.name}` } }, svg(ICON.trash)), async (event) => {
            event.stopPropagation();
            if (!confirm(`Delete “${move.name}”? This can’t be undone.`)) return;
            await library.remove(move.id);
            const next = { ...settings.loadout };
            for (const k of Object.keys(next) as LoadoutKey[]) if (next[k] === move.id) delete next[k];
            updateSettings({ loadout: next });
            toast(`${move.name} deleted.`);
            close();
            render();
          })
        : null;
      const item = press(
        h(
          'button',
          { class: `card pick is-tappable${move.id === currentId ? ' is-on' : ''}` },
          canvas,
          h('div', null, h('h4', { text: move.name }), h('div', { class: 'slot-tags' }, ...traitTags(move), recorded ? h('span', { class: 'tag tag-ai', text: 'Yours' }) : h('span', { class: 'tag', text: 'Default' }))),
          del ?? h('span', { class: 'arrow-go', style: move.id === currentId ? '' : 'opacity:.25' }, svg(ICON.check)),
        ),
        () => {
          const next = { ...settings.loadout };
          // A move can only sit in one place of its slot.
          for (const k of Object.keys(next) as LoadoutKey[]) if (next[k] === move.id) delete next[k];
          if (isDefaultMove(move.id) && move.id === defaultMoves()[index].id) delete next[key];
          else next[key] = move.id;
          updateSettings({ loadout: next });
          ui.stamp();
          close();
          render(key);
        },
        { sound: 'none' },
      );
      list.append(item);
      const preview = new MovePreview(canvas, { ink, span: 2.4, rest: 0.5 });
      preview.setMove(move);
      preview.play();
      sheetPreviews.push(preview);
    }
    const record = press(h('button', { class: 'btn btn-primary' }, svg(ICON.camera), `Record a ${place.label.toLowerCase()}`), () => {
      close();
      actions.record(key);
    }, { sound: 'confirm' });
    const sheet = h(
      'aside',
      { class: 'sheet', attrs: { role: 'dialog', 'aria-label': `${place.label} moves` } },
      h('div', { class: 'sheet-head' }, h('div', null, h('div', { class: 'kicker', text: `Button: ${place.input}` }), h('h2', { text: place.label })), press(h('button', { class: 'btn btn-icon btn-ghost', attrs: { 'aria-label': 'Close' } }, svg(ICON.close)), close, { sound: 'back' })),
      list,
      h('div', { style: 'margin-top:14px' }, record),
    );
    document.body.append(backdrop, sheet);
  }

  return {
    el,
    enter() {
      render();
    },
    leave() {
      for (const p of previews) p.destroy();
    },
  };
}
