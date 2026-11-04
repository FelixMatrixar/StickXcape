/**
 * The relay lab: a toy match between two phones through the real relay, for the week 2 check
 * before the fight engine exists. It uses the game's own netcode (RelayClient, MatchSession, and
 * LockstepDriver or RollbackDriver) with ToySim standing in for the fight.
 */
import {
  AccountClient,
  ApiRequestError,
  connectWebSocket,
  passkeysSupported,
  RelayClient,
  RelayError,
  ServicesClient,
  ToyMatch,
  toyBotInput,
  toyLoadout,
  type MatchSession,
  type ToySim,
} from '@sticxcape/netcode';
import { Button, FRAME_MS, fromFixed, isRoomCode, type ButtonName, type MatchEndMessage, type RoomInfo } from '@sticxcape/shared';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const services = new ServicesClient();
const nicknameInput = $<HTMLInputElement>('nickname');
const enterButton = $<HTMLButtonElement>('enter');
const readyButton = $<HTMLButtonElement>('ready');
const autoInput = $<HTMLInputElement>('auto');
const rollbackInput = $<HTMLInputElement>('rollback');
const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d')!;

const NICKNAME_KEY = 'sticxcape.nickname';
const ROLLBACK_KEY = 'sticxcape.lab.rollback';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the default nickname still works.
  }
}

nicknameInput.value = load(NICKNAME_KEY) || `Player ${10 + Math.floor(Math.random() * 90)}`;
nicknameInput.addEventListener('change', () => save(NICKNAME_KEY, nicknameInput.value.trim()));
rollbackInput.checked = load(ROLLBACK_KEY) === '1';
rollbackInput.addEventListener('change', () => save(ROLLBACK_KEY, rollbackInput.checked ? '1' : '0'));

// Home: create a room, or join the one in the link.

let linkedRoom = new URLSearchParams(location.search).get('room')?.toLowerCase() ?? null;
if (linkedRoom !== null && isRoomCode(linkedRoom)) enterButton.textContent = 'Join the room';

enterButton.addEventListener('click', async () => {
  enterButton.disabled = true;
  try {
    let code = linkedRoom !== null && isRoomCode(linkedRoom) ? linkedRoom : null;
    if (code === null) {
      code = (await services.createRoom(nicknameInput.value)).code;
      history.replaceState(null, '', `/lab/?room=${code}`);
    }
    await enterRoom(code);
  } catch (err) {
    $('home-status').textContent = err instanceof Error ? err.message : String(err);
    enterButton.disabled = false;
  }
});

// The room.

interface CurrentMatch {
  match: ToyMatch;
  startedAt: number | null;
  stalledMs: number;
  desyncFrame: number | null;
  end: MatchEndMessage | null;
}

let client: RelayClient | null = null;
let room: RoomInfo | null = null;
let current: CurrentMatch | null = null;
let readyPressed = false;

async function enterRoom(code: string): Promise<void> {
  const relay = new RelayClient(await connectWebSocket(services.relayUrl));
  relay.on('room', (info) => {
    room = info;
    if (!info.fighters && !info.players.some((p) => p.player === relay.player && p.ready)) readyPressed = false;
    renderRoom();
  });
  relay.on('start', startMatch);
  relay.on('end', (end) => {
    if (current) current.end = end;
    readyPressed = false;
    renderRoom();
  });
  let lastError = '';
  relay.on('error', (error) => {
    lastError = error.code === 'version_mismatch' ? 'This page is out of date; reload it.' : error.message;
    setStatus(lastError, true);
  });
  relay.on('close', () => setStatus(`${lastError ? `${lastError}. ` : ''}Disconnected from the relay; reload to rejoin.`, true));

  try {
    const joined = await relay.join(code, nicknameInput.value);
    client = relay;
    room = joined.room;
  } catch (err) {
    relay.close();
    if (err instanceof RelayError && err.code === 'room_not_found') {
      linkedRoom = null;
      history.replaceState(null, '', '/lab/');
      enterButton.textContent = 'Create a room';
      throw new Error('That room has closed or never existed. Create a new one.');
    }
    throw err;
  }
  relay.sendLoadout(toyLoadout());

  const link = `${location.origin}/lab/?room=${code}`;
  $('home').hidden = true;
  $('room').hidden = false;
  const anchor = $<HTMLAnchorElement>('link');
  anchor.href = link;
  anchor.textContent = link;
  $('share').addEventListener('click', () => void shareLink(link));
  renderRoom();
}

async function shareLink(link: string): Promise<void> {
  if (navigator.share) {
    await navigator.share({ title: 'SticXcape relay lab', url: link }).catch(() => {});
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    setStatus('Invite link copied.');
  } catch {
    prompt('Copy this link', link);
  }
}

readyButton.addEventListener('click', () => {
  if (!client) return;
  readyPressed = true;
  // The relay uses rollback only when both fighters ask; the Rollback stat shows what it picked.
  client.rollback = rollbackInput.checked;
  client.ready();
  renderRoom();
});

function nameOf(player: number | null): string {
  return room?.players.find((p) => p.player === player)?.nickname ?? `Player ${player}`;
}

function renderRoom(): void {
  if (!client || !room) return;
  const me = client.player;
  const list = $('players');
  list.replaceChildren(
    ...room.players.map((p) => {
      const item = document.createElement('li');
      if (p.player === me) item.className = 'me';
      const tags = [
        p.player === me ? 'you' : null,
        p.host ? 'host' : null,
        room!.fighters?.includes(p.player) ? 'fighting' : p.ready ? 'ready' : null,
      ].filter(Boolean);
      item.textContent = p.nickname;
      if (tags.length > 0) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = tags.join(' · ');
        item.append(tag);
      }
      return item;
    }),
  );

  const next = room.queue.slice(0, 2);
  const myTurn = me !== null && next.length === 2 && next.includes(me);
  readyButton.disabled = !myTurn || room.fighters !== null || readyPressed;
  const rematch = current?.end && current.match.session.fighters.every((p) => next.includes(p));
  readyButton.textContent = rematch ? 'Rematch' : 'Ready';

  if (room.fighters) setStatus(`${nameOf(room.fighters[0])} vs ${nameOf(room.fighters[1])}`);
  else if (room.players.length < 2) setStatus('Waiting for someone to open the invite link…');
  else if (!myTurn) setStatus(`${nameOf(next[0]!)} and ${nameOf(next[1]!)} fight next; you are in the queue.`);
  else if (readyPressed) setStatus(`Waiting for ${nameOf(next.find((p) => p !== me)!)} to tap Ready…`);
  else setStatus(current?.end ? resultText(current.end) : 'Tap Ready when you are set.');
}

function setStatus(text: string, bad = false): void {
  const status = $('status');
  status.textContent = text;
  status.className = bad ? 'bad' : '';
}

// The match.

function startMatch(session: MatchSession): void {
  const bot = toyBotInput(session.seed ^ session.localPlayer);
  const state: CurrentMatch = {
    match: new ToyMatch(session, { input: (sim, side) => (autoInput.checked ? bot(sim, side) : heldButtons()) }),
    startedAt: null,
    stalledMs: 0,
    desyncFrame: null,
    end: null,
  };
  session.onDesync((frame) => (state.desyncFrame = frame));
  current = state;
  readyPressed = false;
  renderRoom();
}

function resultText(end: MatchEndMessage): string {
  const me = client?.player ?? null;
  switch (end.reason) {
    case 'finished':
      return end.winner === null ? 'Draw' : end.winner === me ? 'You won' : `${nameOf(end.winner)} won`;
    case 'desync':
      return 'Desync: the phones computed different fights';
    case 'disconnect':
      return end.winner === me ? 'Your opponent left or went quiet: you win' : 'A phone stopped sending inputs';
    case 'room_closed':
      return 'The room closed';
  }
}

// Input: keys and the on-screen buttons. Each source holds at most one button.

const held = new Map<string, ButtonName>();

function heldButtons(): number {
  let buttons = 0;
  for (const name of held.values()) buttons |= Button[name];
  return buttons;
}

const KEYS: Record<string, ButtonName> = {
  ArrowLeft: 'Left',
  KeyA: 'Left',
  ArrowRight: 'Right',
  KeyD: 'Right',
  ArrowUp: 'Up',
  KeyW: 'Up',
  Space: 'Up',
  KeyJ: 'Light',
  Enter: 'Light',
};

window.addEventListener('keydown', (event) => {
  const button = KEYS[event.code];
  if (!button || event.target instanceof HTMLInputElement || (event.target instanceof HTMLButtonElement && event.code === 'Enter')) return;
  event.preventDefault();
  held.set(`key:${event.code}`, button);
});
window.addEventListener('keyup', (event) => held.delete(`key:${event.code}`));
window.addEventListener('blur', () => held.clear());

for (const element of document.querySelectorAll<HTMLButtonElement>('#controls button')) {
  const button = element.dataset.button as ButtonName;
  const release = (event: PointerEvent) => {
    held.delete(`pointer:${event.pointerId}`);
    element.classList.remove('held');
  };
  element.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    held.set(`pointer:${event.pointerId}`, button);
    element.classList.add('held');
  });
  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);
  element.addEventListener('lostpointercapture', release);
  element.addEventListener('contextmenu', (event) => event.preventDefault());
}

// Drawing.

const ARENA_METRES = 8;
let colors = readColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (colors = readColors()));

function readColors() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return { ink: token('--ink'), muted: token('--muted'), line: token('--line'), left: token('--left'), right: token('--right'), bad: token('--bad') };
}

function fitCanvas(): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function draw(): void {
  fitCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w / (ARENA_METRES + 1.2), h / 2.6);
  const left = (w - ARENA_METRES * scale) / 2;
  const floor = h - Math.max(18, h * 0.1);
  const toX = (metres: number) => left + metres * scale;

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(toX(0), floor);
  ctx.lineTo(toX(ARENA_METRES), floor);
  ctx.stroke();

  const sim: ToySim | undefined = current?.match.sim;
  const xs = sim ? [fromFixed(sim.x[0]), fromFixed(sim.x[1])] : [2, 6];
  const ys = sim ? [fromFixed(sim.y[0]), fromFixed(sim.y[1])] : [0, 0];
  for (const side of [0, 1] as const) {
    const other = side === 0 ? 1 : 0;
    const facing = xs[other]! >= xs[side]! ? 1 : -1;
    const jabbing = sim !== undefined && sim.cooldown[side] > 14;
    drawFighter(toX(xs[side]!), floor - ys[side]! * scale, facing, jabbing, side === 0 ? colors.left : colors.right, scale);
  }

  const fighters = current?.match.session.fighters ?? room?.queue.slice(0, 2) ?? [];
  const barWidth = Math.min(w * 0.36, 280);
  ctx.font = '600 13px system-ui, sans-serif';
  for (const side of [0, 1] as const) {
    const health = sim ? sim.health[side] : 100;
    const x = side === 0 ? 12 : w - 12 - barWidth;
    ctx.fillStyle = colors.line;
    ctx.fillRect(x, 26, barWidth, 8);
    ctx.fillStyle = side === 0 ? colors.left : colors.right;
    const fill = (barWidth * health) / 100;
    ctx.fillRect(side === 0 ? x : x + barWidth - fill, 26, fill, 8);
    ctx.textAlign = side === 0 ? 'left' : 'right';
    const player = fighters[side];
    ctx.fillText(player === undefined ? '' : nameOf(player), side === 0 ? x : x + barWidth, 18);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = colors.muted;
  if (current?.end) {
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.fillStyle = current.end.reason === 'finished' ? colors.ink : colors.bad;
    ctx.fillText(resultText(current.end), w / 2, h * 0.38);
  } else if (current && current.match.session.stalledFor() > 150) {
    ctx.fillText('Waiting for the other phone…', w / 2, h * 0.38);
  } else if (!current) {
    ctx.fillText('Two phones, one room, then tap Ready', w / 2, h * 0.38);
  }
}

function drawFighter(x: number, footY: number, facing: number, jabbing: boolean, color: string, s: number): void {
  const hip = footY - 0.92 * s;
  const neck = footY - 1.45 * s;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(3, 0.06 * s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const line = (points: [number, number][]) => {
    ctx.beginPath();
    ctx.moveTo(points[0]![0], points[0]![1]);
    for (const [px, py] of points.slice(1)) ctx.lineTo(px, py);
    ctx.stroke();
  };
  line([
    [x - 0.2 * s, footY],
    [x, hip],
    [x + 0.2 * s, footY],
  ]);
  line([
    [x, hip],
    [x, neck],
  ]);
  const shoulder = neck + 0.08 * s;
  line(
    jabbing
      ? [
          [x, shoulder],
          [x + facing * 0.78 * s, shoulder + 0.02 * s],
        ]
      : [
          [x, shoulder],
          [x + facing * 0.26 * s, shoulder + 0.3 * s],
          [x + facing * 0.36 * s, shoulder + 0.04 * s],
        ],
  );
  line([
    [x, shoulder],
    [x - facing * 0.12 * s, shoulder + 0.32 * s],
    [x + facing * 0.12 * s, shoulder + 0.12 * s],
  ]);
  ctx.beginPath();
  ctx.arc(x, neck - 0.17 * s, 0.14 * s, 0, Math.PI * 2);
  ctx.fill();
}

// Stats.

function setStat(id: string, text: string, tone: 'good' | 'bad' | '' = ''): void {
  const element = $(id);
  if (element.textContent !== text) element.textContent = text;
  element.className = tone;
}

function updateStats(now: number): void {
  setStat('s-ping', client?.rtt == null ? '–' : `${Math.round(client.rtt)} ms`);
  if (!current) return;
  const { match, startedAt, stalledMs, desyncFrame, end } = current;
  const delay = match.session.inputDelay;
  setStat('s-delay', `${delay} frames (${Math.round(delay * FRAME_MS)} ms)`);
  const rollback = match.rollbackStats;
  setStat('s-rollback', rollback ? `${rollback.rollbacks} rewinds, deepest ${rollback.deepest} frames` : 'Off');
  setStat('s-frame', String(match.sim.frame));
  const elapsed = startedAt === null ? 0 : now - startedAt;
  setStat('s-wait', elapsed > 0 ? `${(stalledMs / 1000).toFixed(1)} s (${((stalledMs / elapsed) * 100).toFixed(1)}%)` : '–');
  // Hashes go out after frames 0, 60, 120 and so on, once the frame is final.
  const lastFinal = Math.min(match.session.frame - 1, match.session.confirmedFrame);
  const checks = lastFinal < 0 ? 0 : Math.floor(lastFinal / 60) + 1;
  if (desyncFrame !== null) setStat('s-hash', `Desync at frame ${desyncFrame}`, 'bad');
  else setStat('s-hash', checks > 0 ? `${checks} sent, all matching` : '–', checks > 0 ? 'good' : '');
  setStat('s-result', end ? resultText(end) : 'Playing', end ? (end.reason === 'finished' ? 'good' : 'bad') : '');
}

// The account panel: passkeys and the cloud move library, to try on phones before the game has them.

const accounts = new AccountClient();
const accountButtons = {
  create: $<HTMLButtonElement>('account-create'),
  signIn: $<HTMLButtonElement>('account-signin'),
  save: $<HTMLButtonElement>('account-save'),
  signOut: $<HTMLButtonElement>('account-signout'),
};

function showAccountButtons(signedIn: boolean | null): void {
  accountButtons.create.hidden = accountButtons.signIn.hidden = signedIn !== false;
  accountButtons.save.hidden = accountButtons.signOut.hidden = signedIn !== true;
}

async function refreshAccount(): Promise<void> {
  const status = $('account-status');
  if (!passkeysSupported()) {
    showAccountButtons(null);
    status.textContent = 'Passkeys need HTTPS: they work on staging or on localhost, not on a Wi-Fi address like this one.';
    return;
  }
  const { account, passkeys } = await accounts.status();
  if (!passkeys) {
    showAccountButtons(null);
    status.textContent = 'This server has accounts switched off, or is not on a domain name.';
    return;
  }
  showAccountButtons(account !== null);
  if (!account) {
    status.textContent = 'Not signed in. Make a passkey under your nickname, or sign in with one you made before.';
    return;
  }
  const library = await accounts.getLibrary();
  const count = library.moves.length;
  status.textContent = `Signed in as ${account.name}. Cloud library: ${count} ${count === 1 ? 'move' : 'moves'}.`;
}

function accountAction(button: HTMLButtonElement, action: () => Promise<unknown>): void {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await action();
      await refreshAccount();
    } catch (err) {
      $('account-status').textContent = accountErrorText(err);
    } finally {
      button.disabled = false;
    }
  });
}

function accountErrorText(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  // The browser rejects with NotAllowedError when the prompt is cancelled or times out.
  if (err instanceof DOMException && err.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.';
  if (err instanceof DOMException && err.name === 'InvalidStateError') return 'This phone already has a passkey for this site; sign in with it instead.';
  return err instanceof Error ? err.message : String(err);
}

accountAction(accountButtons.create, () => accounts.createAccount(nicknameInput.value));
accountAction(accountButtons.signIn, () => accounts.signIn());
accountAction(accountButtons.save, () =>
  accounts.saveMove({ move: toyLoadout()[0]!, kind: 'move', description: "The relay lab's toy jab", quality: null, createdAt: Date.now() }),
);
accountAction(accountButtons.signOut, () => accounts.signOut());
refreshAccount().catch((err: unknown) => ($('account-status').textContent = accountErrorText(err)));

// One loop drives the match, the drawing and the stats.

let lastFrameAt = performance.now();
let lastStatsAt = 0;

function loop(now: number): void {
  const dt = now - lastFrameAt;
  lastFrameAt = now;
  if (current && !current.match.session.ended) {
    current.startedAt ??= now;
    current.match.update(now);
    if (current.match.stalled) current.stalledMs += dt;
  }
  draw();
  if (now - lastStatsAt > 200) {
    lastStatsAt = now;
    updateStats(now);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
