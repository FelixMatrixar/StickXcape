/** Home: practice against the bot, create a room, join from a link, Move Studio and the loadout. */
import { roomCodeFromPath, isRoomCode } from '@sticxcape/shared';
import { myInk, myLoadout, myName } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { music } from '../audio/music.ts';
import type { BotLevel } from '../engine/bot.ts';
import { library } from '../moves/library.ts';
import { MovePreview } from '../render/preview.ts';
import { h, press, stagger, svg, tilt, toast } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';
import { segmented } from '../ui/overlay.ts';

export interface HomeActions {
  practice(): void;
  createRoom(): Promise<void>;
  joinRoom(code: string): void;
  studio(): void;
  loadout(): void;
  editName(): void;
}

export function homeScreen(actions: HomeActions): Screen {
  const ink = myInk();
  document.documentElement.style.setProperty('--ink-color', ink.ink);

  const chip = press(h('button', { class: 'player-chip', attrs: { 'aria-label': 'Change name and ink' } }, h('span', { class: 'avatar', text: myName().charAt(0).toUpperCase() }), h('span', { text: myName() })), () => actions.editName());
  const top = h('header', { class: 'home-top' }, h('div', { class: 'home-brand', html: 'Stic<b>X</b>cape' }), chip);

  // Practice.
  const art = h('canvas');
  const level = segmented<BotLevel>(
    [
      { value: 'easy', label: 'Easy' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' },
    ],
    settings.botLevel,
    (value) => updateSettings({ botLevel: value }),
  );
  level.addEventListener('click', (e) => e.stopPropagation());
  const practice = press(
    h(
      'div',
      { class: 'card home-card practice is-tappable rise', attrs: { role: 'button', tabindex: '0', 'aria-label': 'Practice against the bot' } },
      art,
      h(
        'div',
        { class: 'home-card-body' },
        h('div', null, h('div', { class: 'kicker', style: 'color:#f2b134', text: 'Practice' }), h('h3', { text: 'Fight the bot' }), h('p', { style: 'margin-top:6px;max-width:24ch', text: 'Best of 3, 60 seconds a round. Learn the parry: tap Block just before a hit lands.' })),
        h('div', { class: 'go-row' }, level, h('span', { class: 'arrow-go' }, svg(ICON.play))),
      ),
    ),
    () => actions.practice(),
    { sound: 'confirm' },
  );

  const card = (cls: string, iconSvg: string, kicker: string, title: string, text: string, action: () => void, extra?: HTMLElement) =>
    press(
      h(
        'div',
        { class: `card home-card is-tappable rise ${cls}`, attrs: { role: 'button', tabindex: '0', 'aria-label': title } },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px' }, svg(iconSvg, 'icon'), h('span', { class: 'arrow-go' }, svg(ICON.arrow))),
        h('div', null, h('div', { class: 'kicker', text: kicker }), h('h3', { text: title }), h('p', { style: 'margin-top:4px', text })),
        extra ?? null,
      ),
      action,
    );

  let creating = false;
  const create = card('create', ICON.users, 'Online 1v1', 'Create a room', 'Get an invite link and send it to a friend.', async () => {
    if (creating) return;
    creating = true;
    create.style.opacity = '0.7';
    try {
      await actions.createRoom();
    } finally {
      creating = false;
      create.style.opacity = '';
    }
  });

  const joinInput = h('input', { class: 'input', placeholder: 'Paste a link or code', attrs: { 'aria-label': 'Room link or code', spellcheck: 'false', autocapitalize: 'off' } });
  joinInput.addEventListener('click', (e) => e.stopPropagation());
  const joinGo = press(h('button', { class: 'btn btn-small', text: 'Join' }), (e) => {
    e.stopPropagation();
    join();
  });
  const join = () => {
    const raw = joinInput.value.trim();
    let code: string | null = null;
    try {
      code = raw.includes('/') ? roomCodeFromPath(new URL(raw, location.origin).pathname) : raw.toLowerCase();
    } catch {
      code = null;
    }
    if (!code || !isRoomCode(code)) {
      toast('That doesn’t look like a room link.', 'error');
      joinInput.focus();
      return;
    }
    actions.joinRoom(code);
  };
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
  const joinCard = h(
    'div',
    { class: 'card home-card rise' },
    h('div', null, svg(ICON.link, 'icon'), h('div', { class: 'kicker', style: 'margin-top:4px', text: 'Got an invite?' }), h('h3', { text: 'Join a room' })),
    h('div', { class: 'join-row' }, joinInput, joinGo),
  );

  const recorded = library.moves.length;
  const studio = card('studio', ICON.camera, recorded > 0 ? `${recorded} recorded` : 'Motion capture', 'Move Studio', 'Record a move with your camera. Meta AI names it.', () => actions.studio());
  const loadout = card('loadout', ICON.grid, 'Your nine moves', 'Loadout', 'Choose which moves go on L, H, S and D.', () => actions.loadout());

  const grid = h('div', { class: 'home-grid' }, practice, create, joinCard, studio, loadout);
  const el = h('section', { class: 'home' }, top, grid);

  // Safari can clear storage after a week without a visit: ask iPhone players to install.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (ios && !standalone && !settings.installHint && recorded > 0) {
    const close = press(h('button', { class: 'btn btn-icon btn-ghost', style: 'width:30px;min-height:30px', attrs: { 'aria-label': 'Dismiss' } }, svg(ICON.close)), () => {
      updateSettings({ installHint: true });
      hint.remove();
    });
    const hint = h('div', { class: 'install-hint rise' }, svg(ICON.share), h('span', { style: 'flex:1', text: 'Tap Share, then “Add to Home Screen”, so Safari keeps your recorded moves.' }), close);
    el.append(hint);
  }

  for (const c of [practice, create, studio, loadout]) tilt(c, 5);

  const preview = new MovePreview(art, { ink, background: null, floor: 'rgba(255,255,255,0.1)', span: 2.9, rest: 0.4, outline: 'rgba(255,250,240,0.85)' });
  const moves = myLoadout();
  let showcase = 0;
  const cycle = () => {
    preview.setMove(moves[[0, 2, 4, 5, 3, 1][showcase % 6]]);
    showcase += 1;
  };
  cycle();
  const timer = setInterval(cycle, 2000);
  art.style.cssText = 'position:absolute;inset:auto 0 12% auto;width:72%;height:64%;opacity:.95';

  return {
    el,
    enter() {
      stagger(grid);
      preview.play();
      music.play('menu');
    },
    leave() {
      clearInterval(timer);
      preview.destroy();
    },
  };
}
