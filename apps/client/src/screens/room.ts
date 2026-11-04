/**
 * The room (MP-1): both players and their loadouts, the host picks the arena (AR-2), both tap
 * Ready. Winner stays on when more people wait in the room.
 */
import type { LockstepSession } from '@sticxcape/netcode';
import type { MatchEndMessage, RoomInfo } from '@sticxcape/shared';
import { relayErrorText, type OnlineRoom } from '../app/online.ts';
import { myInk } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { isBlocked } from '../app/social.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { music } from '../audio/music.ts';
import { ui } from '../audio/sfx.ts';
import { allArenas, arenaById, isOfficialArena, type ArenaArt } from '../render/arenas.ts';
import { FightCamera } from '../render/camera.ts';
import { contrastInk } from '../render/inks.ts';
import { copyText, h, press, stagger, svg, tilt, toast } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';

export interface RoomActions {
  leave(): void;
  start(session: LockstepSession): void;
}

export function roomScreen(room: OnlineRoom, actions: RoomActions, lastEnd: MatchEndMessage | null = null): Screen {
  const me = room.me;
  const left = h('div', { class: 'room-col' });
  const right = h('div', { class: 'room-col' });
  const el = h('section', { class: 'room' }, left, right);
  let readyPressed = false;
  // Photo arenas live on one phone until sharing is live, so rooms only use official ones.
  let arenaId = room.client.room?.arenaId ?? (isOfficialArena(settings.arena) ? settings.arena : 'rooftop');
  const unsubscribe: (() => void)[] = [];

  const players = h('div', { class: 'players' });
  const status = h('div', { class: 'status-line', style: 'min-height:20px' });
  const readyButton = press(h('button', { class: 'btn btn-red', style: 'width:100%' }, 'Ready'), () => {
    readyPressed = true;
    room.client.ready();
    ui.confirm();
    render();
  }, { sound: 'none' });

  // Invite.
  const linkText = h('span', { text: room.link });
  const copy = press(h('button', { class: 'btn btn-small' }, svg(ICON.copy), 'Copy'), async () => {
    if (await copyText(room.link)) toast('Invite link copied.', 'good');
  });
  const share = press(h('button', { class: 'btn btn-small' }, svg(ICON.share), 'Share'), async () => {
    if (navigator.share) {
      await navigator.share({ title: 'Fight me in SticXcape', text: 'Your moves vs mine.', url: room.link }).catch(() => undefined);
    } else if (await copyText(room.link)) toast('Invite link copied.', 'good');
  });
  const invite = h(
    'div',
    { class: 'card invite rise' },
    h('div', { class: 'kicker', text: 'Invite a friend' }),
    h('div', { class: 'invite-link' }, svg(ICON.link), linkText),
    h('div', { class: 'actions' }, share, copy),
  );

  const leave = press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Leave the room' } }, svg(ICON.back)), () => actions.leave(), { sound: 'back' });
  left.append(
    h('header', { style: 'display:flex;align-items:center;gap:12px' }, leave, h('div', null, h('div', { class: 'kicker', text: 'Friend room' }), h('h1', { class: 'hero-title', style: 'font-size:clamp(28px,6vh,44px)', text: 'Room' }))),
    invite,
    h('div', { class: 'kicker rise', text: 'Players' }),
    players,
    status,
  );

  // Arena picker.
  const arenaGrid = h('div', { class: 'arenas' });
  const arenaCards = new Map<string, HTMLButtonElement>();
  const thumbs: (() => void)[] = [];
  for (const arena of allArenas()) {
    const canvas = h('canvas');
    const card = press(
      h('button', { class: 'card arena-card is-tappable' }, canvas, h('span', { class: 'check' }, svg(ICON.check)), h('b', { text: arena.name }), h('small', { text: arena.blurb })),
      () => {
        if (!room.client.host) {
          toast('The host picks the arena.');
          return;
        }
        arenaId = arena.id;
        updateSettings({ arena: arena.id });
        room.client.setArena(arena.id);
        renderArenas();
      },
      { sound: 'pop' },
    );
    tilt(card, 6);
    arenaCards.set(arena.id, card);
    arenaGrid.append(card);
    thumbs.push(() => paintArena(canvas, arena));
  }
  const renderArenas = () => {
    for (const [id, card] of arenaCards) card.classList.toggle('is-on', id === arenaId);
  };

  const ink = myInk();
  right.append(
    h('div', { class: 'kicker rise', text: 'Arena' }),
    arenaGrid,
    h('div', { class: 'card rise', style: 'padding:12px 14px;display:flex;flex-direction:column;gap:10px' }, h('div', { class: 'kicker', text: 'Your fighter' }), h('div', { style: 'display:flex;align-items:center;gap:10px;font:800 14px/1.2 var(--ui)' }, h('span', { class: 'dot', style: `background:${ink.ink};width:14px;height:14px` }), `${settings.nickname ?? 'You'} in ${ink.name}`), readyButton),
  );

  function nameOf(info: RoomInfo, player: number | undefined): string {
    return info.players.find((p) => p.player === player)?.nickname ?? `Player ${player}`;
  }

  function render(): void {
    const info = room.client.room;
    if (!info) return;
    if (info.arenaId && info.arenaId !== arenaId) arenaId = info.arenaId;
    renderArenas();
    const opponentInk = contrastInk(ink);
    players.replaceChildren(
      ...info.players.map((p, i) => {
        const mine = p.player === me;
        const fighting = info.fighters?.includes(p.player);
        const badge = fighting ? 'Fighting' : p.ready ? 'Ready' : p.hasLoadout ? 'Waiting' : 'Joining';
        const row = h(
          'div',
          { class: 'player', style: `--i:${i}` },
          h('span', { class: 'avatar', style: `background:${mine ? ink.ink : opponentInk.ink}`, text: p.nickname.charAt(0).toUpperCase() }),
          h('span', { class: 'player-name', text: p.nickname }),
          mine ? h('span', { class: 'tag', text: 'You' }) : null,
          p.host ? h('span', { class: 'tag tag-mid', text: 'Host' }) : null,
          !mine && isBlocked(p.nickname) ? h('span', { class: 'tag tag-blocked', text: 'Blocked' }) : null,
          h('span', { class: `ready-badge${p.ready || fighting ? ' is-ready' : ''}`, text: badge }),
        );
        return row;
      }),
    );
    const next = info.queue.slice(0, 2);
    const myTurn = me !== null && next.length === 2 && next.includes(me);
    const rematch = lastEnd !== null && myTurn;
    // Never fight someone you blocked.
    const opponent = myTurn ? next.find((p) => p !== me) : undefined;
    const blockedOpponent = opponent !== undefined && isBlocked(nameOf(info, opponent));
    readyButton.replaceChildren(rematch ? 'Rematch' : 'Ready');
    readyButton.disabled = !myTurn || info.fighters !== null || readyPressed || blockedOpponent;
    readyButton.classList.toggle('pulse', myTurn && !readyPressed && info.players.length >= 2 && !blockedOpponent);
    let text: string;
    if (blockedOpponent) text = `You blocked ${nameOf(info, opponent)}. Unblock them in Settings to fight, or leave the room.`;
    else if (info.fighters) text = `${nameOf(info, info.fighters[0])} vs ${nameOf(info, info.fighters[1])}: fight in progress.`;
    else if (info.players.length < 2) text = 'Waiting for someone to open the invite link…';
    else if (!myTurn) text = `${nameOf(info, next[0])} and ${nameOf(info, next[1])} fight next. Winner stays on.`;
    else if (readyPressed) text = `Waiting for ${nameOf(info, next.find((p) => p !== me))} to tap Ready…`;
    else text = 'Tap Ready when you’re set.';
    status.replaceChildren(h('i', { class: `light ${info.players.length >= 2 ? 'is-good' : ''}` }), text);
  }

  return {
    el,
    enter() {
      stagger(left);
      stagger(right);
      for (const paint of thumbs) paint();
      music.play('menu');
      if (room.client.host && !room.client.room?.arenaId) room.client.setArena(arenaId);
      unsubscribe.push(
        room.client.on('room', (info) => {
          if (!info.fighters && !info.players.some((p) => p.player === me && p.ready)) readyPressed = false;
          render();
        }),
        room.client.on('arena', (id) => {
          arenaId = id;
          if (!room.client.host) ui.pop();
          renderArenas();
        }),
        room.client.on('start', (session) => actions.start(session)),
        room.client.on('error', (err) => toast(relayErrorText(err), 'error')),
        room.client.on('close', () => {
          toast('Disconnected from the room.', 'error');
          actions.leave();
        }),
      );
      render();
      const pending = room.client.session;
      if (pending && !pending.ended) actions.start(pending);
    },
    leave() {
      for (const off of unsubscribe) off();
    },
  };
}

/** A small painting of an arena, for the picker. */
export function paintArena(canvas: HTMLCanvasElement, arena: ArenaArt): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cam = new FightCamera();
  cam.resize(rect.width, rect.height);
  cam.arenaWidth = arena.file.width;
  cam.update(0, { x0: 3.6, x1: 6.4, top: 1.8 }, true);
  arena.draw(ctx, cam, 0);
}

export { arenaById };
