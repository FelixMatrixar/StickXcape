/**
 * Move Studio (MS-1 to MS-9): pick a slot, line up side-on inside the guide, 3-2-1, perform,
 * watch the stick-man replay, trim or retake (up to 5 takes; the cleanest is suggested), then
 * save. Meta AI suggests a name the player can keep or change.
 */
import { HttpAiService } from '@sticxcape/netcode';
import { parseMoveFile, type MoveFile, type MoveSlot } from '@sticxcape/shared';
import { haptic } from '../app/haptics.ts';
import { myInk, myLoadout } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { music } from '../audio/music.ts';
import { ui } from '../audio/sfx.ts';
import { DEMO_ASPECT, demoTake } from '../capture/demo.ts';
import { bodyBox, HAZARDS, SpaceWatch } from '../capture/space.ts';
import { CameraError, loadTracker, openCamera, Tracking, type CameraFacing, type PoseFrame } from '../capture/tracker.ts';
import { J, JOINT_COUNT } from '../engine/skeleton.ts';
import { analyse, cleanCapture, CleanupError, encodeMove, floatJoints, jitterTip, prepareFrames, prepareIdle, type CleanCapture } from '../moves/cleanup.ts';
import { defaultMoves } from '../moves/defaults.ts';
import { uuid, withHashSync } from '../moves/hash.ts';
import { library } from '../moves/library.ts';
import { LOADOUT_KEYS, type LoadoutKey } from '../moves/loadout.ts';
import { MovePreview } from '../render/preview.ts';
import { drawFigure } from '../render/stickman.ts';
import { h, press, sleep, stagger, svg, toast } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';

const RECORD_SECONDS = 3;

/** Not a loadout place: an idle stance, drawn between moves for looks only (LS-12). */
const IDLE_PLACE = { key: 'idle', slot: 'taunt', label: 'Idle stance', input: 'Between moves' } as const;
type Place = (typeof LOADOUT_KEYS)[number] | typeof IDLE_PLACE;

function hintFor(place: Place): string {
  return place.key === 'idle' ? 'How you bounce between moves (looks only)' : SLOT_HINTS[place.slot];
}
const MAX_TAKES = 5;

const SLOT_HINTS: Record<MoveSlot, string> = {
  light: 'A quick jab or snap kick',
  heavy: 'A big haymaker or spinning strike',
  low: 'A sweep or a low kick',
  special: 'Your signature: a flying kick, a cartwheel strike',
  defense: 'A slip, a duck or a roll',
  taunt: 'Anything goes; no combat effect',
  victory: 'Your victory pose',
};

interface Take {
  raw: PoseFrame[];
  aspect: number;
  clean: CleanCapture;
}

const ai = new HttpAiService();

export function studioScreen(onDone: () => void, startKey?: LoadoutKey): Screen {
  const ink = myInk();
  const stage = h('div', { class: 'studio-stage' });
  const panel = h('div', { class: 'studio-panel' });
  const el = h('section', { class: 'studio' }, stage, panel);

  let place: Place | null = null;
  let halfSpeed = false;
  let stream: MediaStream | null = null;
  let tracking: Tracking | null = null;
  /** The clear-space check, while the camera is open. */
  let space: SpaceWatch | null = null;
  let facing: CameraFacing = 'user';
  let video: HTMLVideoElement | null = null;
  let overlay: HTMLCanvasElement | null = null;
  let lastFrame: PoseFrame | null = null;
  let recording: PoseFrame[] | null = null;
  let takes: Take[] = [];
  let current = 0;
  let trim: [number, number] = [0, 0];
  let mirror = false;
  let speed = 1;
  let preview: MovePreview | null = null;
  let disposed = false;
  let demoMode = false;
  const aiNames = new Map<number, string>();

  // Slot picker.

  function showSlots(stamped?: LoadoutKey): void {
    stopCamera();
    preview?.destroy();
    preview = null;
    const loadout = myLoadout();
    const art = h('canvas');
    stage.replaceChildren(art, h('div', { class: 'stage-hint' }, h('span', { text: 'Pick a slot. The recording sets how the move looks; the slot sets its power.' })));
    const idle = new MovePreview(art, { ink, background: '#1b1916', floor: 'rgba(255,255,255,0.1)', span: 2.5, outline: 'rgba(255,250,240,0.9)' });
    preview = idle;
    idle.setMove(loadout[0]);
    idle.play();
    const grid = h('div', { class: 'slot-grid' });
    LOADOUT_KEYS.forEach((key, i) => {
      const move = loadout[i];
      const recorded = library.get(move.id) !== undefined;
      const card = press(
        h(
          'button',
          { class: `card slot-pick is-tappable pop-in${key.key === stamped ? ' is-stamped' : ''}` },
          h('b', { text: key.label }),
          h('small', { text: recorded ? `Yours: ${move.name}` : SLOT_HINTS[key.slot] }),
          recorded ? h('span', { class: 'done' }, svg(ICON.check)) : null,
        ),
        () => choose(key),
      );
      card.addEventListener('pointerenter', () => idle.setMove(move));
      card.addEventListener('focus', () => idle.setMove(move));
      grid.append(card);
    });
    stagger(grid);
    const back = press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Back' } }, svg(ICON.back)), () => leaveStudio(), { sound: 'back' });
    panel.replaceChildren(
      h('div', { style: 'display:flex;align-items:center;gap:12px' }, back, h('div', null, h('div', { class: 'kicker', text: 'Move Studio' }), h('h2', { text: 'Record a move' }))),
      h('p', { class: 'muted', style: 'margin:0;font-size:13px', text: 'Start with light, heavy, low and special. Every capture is fitted to the same body, so nobody gets extra reach.' }),
      grid,
      idleRow(),
    );
  }

  function idleRow(): HTMLElement {
    const stored = settings.idleStance ? library.get(settings.idleStance) : undefined;
    const record = press(h('button', { class: 'btn btn-small' }, svg(ICON.camera), stored ? 'Re-record' : 'Record'), () => choose(IDLE_PLACE));
    const reset = stored
      ? press(h('button', { class: 'btn btn-small btn-ghost' }, 'Use the standard stance'), () => {
          updateSettings({ idleStance: null });
          void library.remove(stored.move.id);
          toast('Back to the standard stance.');
          showSlots();
        }, { sound: 'back' })
      : null;
    return h(
      'div',
      { class: 'card', style: 'padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap' },
      h('div', { style: 'display:flex;flex-direction:column;gap:2px' }, h('b', { style: 'font:400 20px/1 var(--display);text-transform:uppercase', text: 'Idle stance' }), h('small', { class: 'muted', style: 'font:600 11.5px/1.3 var(--ui)', text: stored ? `Yours: ${stored.move.name}. Looks only.` : 'The standard stance. Record your own bounce; looks only.' })),
      h('div', { class: 'actions' }, record, reset),
    );
  }

  function choose(key: Place): void {
    place = key;
    takes = [];
    current = 0;
    aiNames.clear();
    if (!settings.coachMarks) void startCamera();
    else showConsent();
  }

  function showConsent(): void {
    const agree = press(h('button', { class: 'btn btn-primary' }, svg(ICON.camera), 'Open the camera'), () => {
      updateSettings({ coachMarks: false });
      void startCamera();
    }, { sound: 'confirm' });
    const demo = press(h('button', { class: 'btn' }, 'Try a demo take'), () => runDemo());
    const back = press(h('button', { class: 'btn btn-ghost' }, 'Back'), () => showSlots(), { sound: 'back' });
    panel.replaceChildren(
      h('div', { class: 'kicker', text: place?.label ?? '' }),
      h('h2', { text: 'Before you record' }),
      h(
        'div',
        { class: 'card', style: 'padding:12px 14px;display:flex;flex-direction:column;gap:8px;font:600 13px/1.4 var(--ui)' },
        h('div', { text: '📷  The camera tracks your body on this phone. The video never leaves it; only the stick-man skeleton is kept.' }),
        h('div', { text: '🙋  Only you: Move Studio pauses if it sees a second person.' }),
        h('div', { text: '🧱  Clear an arm’s length all around. No stairs, glass or pets nearby. Grippy shoes or bare feet.' }),
        h('div', { text: '📱  Prop the phone 2–3 m away, side-on, whole body in frame.' }),
      ),
      h('div', { class: 'actions' }, agree, demo, back),
    );
  }

  // Camera and tracking.

  async function startCamera(): Promise<void> {
    demoMode = false;
    video = h('video', { playsInline: true, muted: true, autoplay: true, attrs: { 'aria-label': 'Camera preview' } });
    overlay = h('canvas');
    const flip = press(h('button', { class: 'btn btn-icon', style: 'position:absolute;z-index:3;top:10px;right:10px', attrs: { 'aria-label': 'Switch camera' } }, svg(ICON.swap)), () => {
      facing = facing === 'user' ? 'environment' : 'user';
      void startCamera();
    });
    stage.replaceChildren(video, overlay, flip, h('div', { class: 'stage-hint' }, h('span', { text: 'Starting the camera…' })));
    renderSetup('Starting the camera…');
    try {
      stopCamera();
      stream = await openCamera(facing);
      if (disposed) return stopCamera();
      video.srcObject = stream;
      video.classList.toggle('is-mirrored', facing === 'user');
      await video.play().catch(() => undefined);
      renderSetup('Loading the body tracker…');
      const landmarker = await loadTracker();
      if (disposed) return stopCamera();
      tracking = new Tracking(landmarker, video, (frame) => onTracked(frame));
      tracking.start();
      // Safety: nothing to kick within reach. Paused while recording so tracking stays smooth.
      space = new SpaceWatch(video, () => (lastFrame ? bodyBox(lastFrame.points) : null), () => recording !== null);
      space.start();
      renderSetup(null);
    } catch (err) {
      stopCamera();
      const message = err instanceof CameraError ? err.message : 'The body tracker couldn’t load. Check your connection.';
      const hint = stage.querySelector('.stage-hint span');
      if (hint) hint.textContent = 'No camera. A demo take still works.';
      renderSetup(null, message);
    }
  }

  function stopCamera(): void {
    tracking?.stop();
    tracking = null;
    space?.stop();
    space = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  let statusEl: HTMLElement | null = null;
  let recButton: HTMLButtonElement | null = null;

  function renderSetup(loading: string | null, error?: string): void {
    if (!place) return;
    statusEl = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    recButton = h('button', { class: 'rec', attrs: { 'aria-label': 'Record' } }, svg('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44"/></svg>'));
    press(recButton, () => void countdownAndRecord(), { sound: 'none', noRipple: true });
    if (loading || error) recButton.disabled = true;
    const demo = press(h('button', { class: 'btn btn-small' }, 'Try a demo take'), () => runDemo());
    const back = press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Back to slots' } }, svg(ICON.back)), () => showSlots(), { sound: 'back' });
    // Safety: perform at half speed and the game plays it at full speed, within the speed cap.
    const slow = h('button', { class: `switch${halfSpeed ? ' is-on' : ''}`, attrs: { role: 'switch', 'aria-label': 'Record at half speed', 'aria-checked': String(halfSpeed) } });
    slow.addEventListener('click', () => {
      halfSpeed = !halfSpeed;
      slow.classList.toggle('is-on', halfSpeed);
      slow.setAttribute('aria-checked', String(halfSpeed));
      ui.toggle(halfSpeed);
      seconds.textContent = recordHint();
    });
    const seconds = h('div', { class: 'muted', style: 'font:600 12.5px/1.35 var(--ui)', text: recordHint() });
    panel.replaceChildren(
      h('div', { style: 'display:flex;align-items:center;gap:12px' }, back, h('div', null, h('div', { class: 'kicker', text: `${place.label} · take ${takes.length + 1} of ${MAX_TAKES}` }), h('h2', { text: hintFor(place) }))),
      error
        ? h('div', { class: 'card', style: 'padding:12px 14px;background:#ffe5df;font:600 13px/1.4 var(--ui)', text: error })
        : loading
          ? h('div', { class: 'status-line' }, h('i', { class: 'spinner', style: 'border-color:rgba(0,0,0,.15);border-top-color:var(--ink)' }), loading)
          : statusEl,
      h('div', { class: 'rec-row' }, recButton, seconds),
      h('div', { class: 'setting', style: 'padding:6px 0' }, h('div', { class: 'setting-text' }, h('span', { class: 'setting-title', text: 'Record at half speed' }), h('span', { class: 'setting-hint', text: 'Safer for kicks and spins; it plays back at full speed' })), slow),
      h('div', { class: 'actions' }, demo, takes.length > 0 ? press(h('button', { class: 'btn btn-small' }, 'Back to takes'), () => showReview()) : null),
    );
    if (!loading && !error) updateStatus();
  }

  function recordHint(): string {
    const secs = RECORD_SECONDS * (halfSpeed ? 2 : 1);
    return halfSpeed ? `Move at half speed. You have ${secs} seconds after the countdown.` : `Tap record, then perform within ${secs} seconds after the countdown.`;
  }

  function updateStatus(): void {
    if (!statusEl) return;
    const frame = lastFrame;
    const checks = assess(frame);
    statusEl.replaceChildren(
      ...checks.map((c) => h('div', { class: 'status-line' }, h('i', { class: `light ${c.ok ? 'is-good' : 'is-bad'}` }), c.text)),
    );
    if (recButton && !recording) recButton.disabled = !checks.every((c) => c.ok || c.optional);
  }

  let lastStatusAt = 0;
  function onTracked(frame: PoseFrame | null): void {
    lastFrame = frame;
    if (recording && frame) {
      if (frame.people > 1) {
        toast('Someone else is in frame. Only you can be recorded.', 'error');
        recording = null;
        stage.querySelector('.countdown')?.remove();
        renderSetup(null);
      } else recording.push(frame);
    }
    drawOverlay(frame);
    const now = performance.now();
    if (now - lastStatusAt > 250) {
      lastStatusAt = now;
      updateStatus();
    }
  }

  function drawOverlay(frame: PoseFrame | null): void {
    if (!overlay || !video) return;
    const rect = overlay.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
    const ctx = overlay.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const hgt = rect.height;
    // The outline guide: where to stand.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    const gw = Math.min(w * 0.5, hgt * 0.5);
    ctx.strokeRect((w - gw) / 2, hgt * 0.06, gw, hgt * 0.88);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(w * 0.15, hgt * 0.94);
    ctx.lineTo(w * 0.85, hgt * 0.94);
    ctx.stroke();
    if (!frame) return;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.max(w / vw, hgt / vh);
    const ox = (w - vw * scale) / 2;
    const oy = (hgt - vh * scale) / 2;
    const mirrored = facing === 'user';
    const map = (i: number): [number, number] => {
      let x = ox + frame.points[i * 4] * vw * scale;
      if (mirrored) x = w - x;
      return [x, oy + frame.points[i * 4 + 1] * vh * scale];
    };
    // A live stick man in your ink over the camera (MS-2).
    const joints = new Float32Array(JOINT_COUNT * 2);
    const pick: Record<number, number[]> = {
      [J.head]: [0, 7, 8],
      [J.neck]: [11, 12],
      [J.pelvis]: [23, 24],
      [J.lShoulder]: [11],
      [J.lElbow]: [13],
      [J.lWrist]: [15],
      [J.rShoulder]: [12],
      [J.rElbow]: [14],
      [J.rWrist]: [16],
      [J.lHip]: [23],
      [J.lKnee]: [25],
      [J.lAnkle]: [27],
      [J.lToe]: [31],
      [J.rHip]: [24],
      [J.rKnee]: [26],
      [J.rAnkle]: [28],
      [J.rToe]: [32],
    };
    for (let j = 0; j < JOINT_COUNT; j++) {
      let x = 0;
      let y = 0;
      for (const i of pick[j]) {
        const [px, py] = map(i);
        x += px;
        y += py;
      }
      joints[2 * j] = x / pick[j].length;
      joints[2 * j + 1] = y / pick[j].length;
    }
    const torso = Math.hypot(joints[2 * J.neck] - joints[2 * J.pelvis], joints[2 * J.neck + 1] - joints[2 * J.pelvis + 1]);
    const facingDir = joints[2 * J.lToe] > joints[2 * J.lAnkle] ? 1 : -1;
    drawFigure(ctx, joints, { ink, scale: torso / 0.5, facing: facingDir, alpha: recording ? 0.95 : 0.8, weight: 0.8 });
    // Anything within reach gets a red outline and a name.
    if (!recording) {
      for (const hazard of space?.hazards ?? []) {
        let x0 = ox + hazard.x0 * vw * scale;
        let x1 = ox + hazard.x1 * vw * scale;
        if (mirrored) [x0, x1] = [w - x1, w - x0];
        const y0 = oy + hazard.y0 * vh * scale;
        const y1 = oy + hazard.y1 * vh * scale;
        ctx.strokeStyle = 'rgba(255, 92, 70, 0.95)';
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 6]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
        const label = HAZARDS[hazard.label].replace(/^An? /, '');
        ctx.font = '800 13px system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 14;
        ctx.fillStyle = 'rgba(255, 92, 70, 0.95)';
        ctx.fillRect(x0, Math.max(0, y0 - 22), tw, 22);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, x0 + 7, Math.max(0, y0 - 22) + 15);
      }
    }
  }

  function assess(frame: PoseFrame | null): { ok: boolean; text: string; optional?: boolean }[] {
    if (!frame) return [{ ok: false, text: 'Step into the frame' }];
    const p = frame.points;
    const vis = (i: number) => p[i * 4 + 3];
    const inside = (i: number) => p[i * 4] > 0.01 && p[i * 4] < 0.99 && p[i * 4 + 1] > 0.01 && p[i * 4 + 1] < 0.99;
    const whole = [0, 27, 28].every((i) => vis(i) > 0.45 && inside(i)) || [0, 31, 32].every((i) => vis(i) > 0.45 && inside(i));
    const shoulderGap = Math.abs(p[11 * 4] - p[12 * 4]);
    const torso = Math.hypot(p[11 * 4] - p[23 * 4], p[11 * 4 + 1] - p[23 * 4 + 1]) || 1;
    const sideOn = shoulderGap / torso < 0.38;
    const avgVis = [0, 11, 12, 23, 24, 25, 26, 27, 28].reduce((s, i) => s + vis(i), 0) / 9;
    return [
      { ok: whole, text: whole ? 'Whole body in frame' : 'Step back: head and feet in frame' },
      { ok: frame.people <= 1, text: frame.people <= 1 ? 'Just you in frame' : 'Only one person, please' },
      spaceCheck(),
      { ok: sideOn, text: sideOn ? 'Standing side-on' : 'Turn side-on to the phone', optional: true },
      { ok: avgVis > 0.7, text: avgVis > 0.7 ? 'Good light' : 'A bit dark: add some light', optional: true },
    ];
  }

  /** The clear-space check as a status line: it blocks recording until nothing is within reach. */
  function spaceCheck(): { ok: boolean; text: string; optional?: boolean } {
    if (!space) return { ok: true, text: 'Clear space around you', optional: true };
    if (space.state === 'loading') return { ok: false, text: 'Checking the space around you…' };
    if (space.state === 'failed') return { ok: false, optional: true, text: 'Couldn’t check the space: clear an arm’s length yourself' };
    const hazard = space.hazards[0];
    return hazard ? { ok: false, text: `${HAZARDS[hazard.label]} is within reach: move it or step away` } : { ok: true, text: 'Clear space around you' };
  }

  async function countdown(): Promise<void> {
    for (const n of [3, 2, 1]) {
      const node = h('div', { class: 'countdown' }, h('b', { text: String(n) }));
      stage.append(node);
      ui.countdown(n);
      haptic('ui');
      await sleep(900);
      node.remove();
      if (disposed) return;
    }
    const go = h('div', { class: 'countdown' }, h('b', { text: 'GO', style: 'font-size:clamp(90px,26vh,180px)' }));
    stage.append(go);
    ui.countdown(0);
    setTimeout(() => go.remove(), 700);
  }

  async function countdownAndRecord(): Promise<void> {
    if (!recButton || recording || !place) return;
    recButton.disabled = true;
    await countdown();
    if (disposed) return;
    recording = [];
    ui.record(true);
    const button = recButton;
    button.classList.add('is-recording');
    button.disabled = false;
    const ring = button.querySelector('circle') as SVGCircleElement;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = (performance.now() - started) / (RECORD_SECONDS * (halfSpeed ? 2 : 1) * 1000);
        ring.style.setProperty('--off', String(276 * (1 - Math.min(1, t))));
        if (t >= 1 || !recording) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
    const frames = recording;
    recording = null;
    button.classList.remove('is-recording');
    ui.record(false);
    if (!frames) return;
    const aspect = video && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    await process(frames, aspect);
  }

  async function runDemo(): Promise<void> {
    if (!place) return;
    demoMode = true;
    stopCamera();
    const art = h('canvas');
    stage.replaceChildren(art, h('div', { class: 'stage-hint' }, h('span', { text: 'Demo take: a default move, tracked as if by the camera, with real jitter.' })));
    const ghost = new MovePreview(art, { ink, background: '#1b1916', floor: 'rgba(255,255,255,0.1)', span: 2.5, outline: 'rgba(255,250,240,0.9)' });
    // The idle demo borrows the taunt's motion.
    const source = defaultMoves()[place.key === 'idle' ? 7 : LOADOUT_KEYS.findIndex((k) => k.key === place!.key)];
    ghost.setMove(source);
    ghost.play();
    panel.replaceChildren(h('div', { class: 'kicker', text: place.label }), h('h2', { text: 'Demo take' }), h('div', { class: 'status-line' }, h('i', { class: 'spinner', style: 'border-color:rgba(0,0,0,.15);border-top-color:var(--ink)' }), 'Get ready…'));
    await countdown();
    ui.record(true);
    await sleep(1100);
    ghost.destroy();
    ui.record(false);
    await process(demoTake(source), DEMO_ASPECT);
  }

  async function process(frames: PoseFrame[], aspect: number): Promise<void> {
    if (!place) return;
    const steps = ['Smoothing each joint', 'Fitting the standard skeleton', 'Locking planted feet', 'Capping limb speed', 'Finding the strike'];
    const list = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    panel.replaceChildren(h('div', { class: 'kicker', text: place.label }), h('h2', { text: 'Cleaning up' }), list);
    for (const [i, step] of steps.entries()) {
      list.append(h('div', { class: 'status-line rise', style: `--i:${i}` }, h('i', { class: 'light is-good' }), step));
      await sleep(110);
    }
    try {
      const clean = cleanCapture(frames, aspect, { halfSpeed: halfSpeed && !demoMode });
      takes.push({ raw: frames, aspect, clean });
      current = takes.length - 1;
      trim = [...clean.trim];
      mirror = false;
      speed = 1;
      ui.sparkle();
      showReview();
    } catch (err) {
      toast(err instanceof CleanupError ? err.message : 'That take couldn’t be cleaned up. Try again.', 'error');
      if (demoMode) showSlots();
      else renderSetup(null);
    }
  }

  // Review.

  let nameInput: HTMLInputElement | null = null;

  function buildCurrent(name: string): MoveFile {
    const take = takes[current];
    const frames = place!.key === 'idle' ? prepareIdle(take.clean, trim) : prepareFrames(take.clean, { trim, mirror, speed });
    const info = analyse(frames, place!.slot);
    const move = withHashSync(encodeMove(frames, info, { id: uuid(), slot: place!.slot, name }));
    return move;
  }

  function bestTake(): number {
    let best = 0;
    takes.forEach((take, i) => {
      if (take.clean.quality > takes[best].clean.quality) best = i;
    });
    return best;
  }

  function showReview(): void {
    if (!place) return;
    stopCamera();
    const take = takes[current];
    const canvas = h('canvas');
    stage.replaceChildren(canvas);
    preview?.destroy();
    preview = new MovePreview(canvas, { ink, background: '#1b1916', floor: 'rgba(255,255,255,0.12)', span: 2.6, rest: 0.35, outline: 'rgba(255,250,240,0.9)' });
    const refresh = () => {
      try {
        preview!.setMove(buildCurrent(nameInput?.value || place!.label));
        preview!.play();
      } catch {
        // A trim too short to build; keep the last preview.
      }
    };

    // Takes.
    const best = bestTake();
    const takeRow = h('div', { class: 'takes' });
    takes.forEach((_, i) => {
      const chip = press(h('button', { class: `btn take${i === current ? ' is-on' : ''}` }, `${i + 1}`, i === best && takes.length > 1 ? h('span', { class: 'best', text: 'BEST' }) : null), () => {
        current = i;
        trim = [...takes[i].clean.trim];
        showReview();
      }, { sound: 'pop' });
      takeRow.append(chip);
    });

    // Trim.
    const total = take.clean.frames.length;
    const trimEl = h('div', { class: 'trim' });
    const track = h('div', { class: 'trim-track' });
    const range = h('div', { class: 'trim-range' });
    const handleA = h('div', { class: 'trim-handle', attrs: { role: 'slider', 'aria-label': 'Trim start' } });
    const handleB = h('div', { class: 'trim-handle', attrs: { role: 'slider', 'aria-label': 'Trim end' } });
    const head = h('div', { class: 'trim-head' });
    trimEl.append(track, range, head, handleA, handleB);
    const paint = () => {
      const a = (trim[0] / (total - 1)) * 100;
      const b = (trim[1] / (total - 1)) * 100;
      handleA.style.left = `${a}%`;
      handleB.style.left = `${b}%`;
      range.style.left = `${a}%`;
      range.style.width = `${b - a}%`;
    };
    paint();
    const drag = (handle: HTMLElement, which: 0 | 1) => {
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // Dragging still works while the pointer stays on the handle.
        }
        handle.classList.add('is-dragging');
        haptic('ui');
      });
      handle.addEventListener('pointermove', (event) => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const rect = trimEl.getBoundingClientRect();
        const f = Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (total - 1));
        const next: [number, number] = which === 0 ? [Math.min(f, trim[1] - 12), trim[1]] : [trim[0], Math.max(f, trim[0] + 12)];
        if (next[0] !== trim[0] || next[1] !== trim[1]) {
          trim = [Math.max(0, next[0]), Math.min(total - 1, next[1])];
          paint();
          ui.type();
        }
      });
      const up = (event: PointerEvent) => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        handle.releasePointerCapture(event.pointerId);
        handle.classList.remove('is-dragging');
        refresh();
      };
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    };
    drag(handleA, 0);
    drag(handleB, 1);

    // Mirror and speed (MS-8).
    const mirrorSwitch = h('button', { class: `switch${mirror ? ' is-on' : ''}`, attrs: { role: 'switch', 'aria-label': 'Mirror' } });
    mirrorSwitch.addEventListener('click', () => {
      mirror = !mirror;
      mirrorSwitch.classList.toggle('is-on', mirror);
      ui.toggle(mirror);
      refresh();
    });
    const speedInput = h('input', { class: 'slider', type: 'range', min: '0.75', max: '1.25', step: '0.05', value: String(speed), attrs: { 'aria-label': 'Speed' } });
    const speedLabel = h('span', { class: 'kicker', text: `${Math.round(speed * 100)}%` });
    const paintSpeed = () => speedInput.style.setProperty('--fill', `${((speed - 0.75) / 0.5) * 100}%`);
    paintSpeed();
    speedInput.addEventListener('input', () => {
      speed = Number(speedInput.value);
      speedLabel.textContent = `${Math.round(speed * 100)}%`;
      paintSpeed();
    });
    speedInput.addEventListener('change', () => refresh());

    // Quality.
    const quality = take.clean.quality;
    const tip = jitterTip(take.clean);
    const meter = h('div', { class: 'meter' }, h('i', { style: `transform:scaleX(${quality.toFixed(2)});background:${quality > 0.62 ? 'var(--green)' : 'var(--gold)'}` }));

    // Name, with a Meta AI suggestion (MS-7).
    nameInput = h('input', { class: 'input', maxLength: 32, placeholder: 'Name your move', attrs: { 'aria-label': 'Move name' } });
    const aiTag = h('span', { class: 'tag tag-ai', text: 'Meta AI' });
    const nameWrap = h('div', { class: 'ai-name' }, nameInput, aiTag);
    aiTag.style.display = 'none';
    const known = aiNames.get(current);
    if (known) {
      nameInput.value = known;
      aiTag.style.display = '';
    } else {
      nameInput.placeholder = 'Meta AI is naming it…';
      void suggestName(current).then((name) => {
        if (!nameInput || nameInput.value) return;
        nameInput.value = name.name;
        nameInput.placeholder = 'Name your move';
        aiTag.style.display = name.ai ? '' : 'none';
        if (name.ai) ui.sparkle();
      });
    }
    nameInput.addEventListener('input', () => (aiTag.style.display = 'none'));

    const retake = press(h('button', { class: 'btn' }, svg(ICON.redo), 'Retake'), () => {
      if (demoMode) void runDemo();
      else void startCamera();
    });
    if (takes.length >= MAX_TAKES) retake.disabled = true;
    const idle = place.key === 'idle';
    const save = press(h('button', { class: 'btn btn-primary' }, svg(ICON.check), idle ? 'Save stance' : 'Save move'), () => void saveMove(), { sound: 'none' });

    panel.replaceChildren(
      h('div', { style: 'display:flex;align-items:center;gap:12px' }, press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Back to slots' } }, svg(ICON.back)), () => showSlots(), { sound: 'back' }), h('div', null, h('div', { class: 'kicker', text: `${place.label} · Review` }), h('h2', { text: 'Your stick man' }))),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Takes' }), takeRow),
      h('div', { class: 'field' }, h('div', { style: 'display:flex;justify-content:space-between' }, h('span', { class: 'field-label', text: 'Capture quality' }), h('span', { class: 'kicker', text: `${Math.round(quality * 100)}%` })), meter, tip ? h('span', { class: 'muted', style: 'font-size:12px', text: tip }) : null),
      h('div', { class: 'status-line' }, h('i', { class: 'light is-good' }), take.clean.corrected > 0 ? `Physics check: fixed ${take.clean.corrected} frames past human limits` : 'Physics check: every joint within human limits'),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Trim' }), trimEl),
      // An idle stance loops in place: mirror and speed don't apply.
      ...(idle
        ? []
        : [
            h('div', { class: 'setting', style: 'padding:4px 0' }, h('span', { class: 'setting-title', text: 'Mirror left and right' }), mirrorSwitch),
            h('div', { class: 'setting', style: 'padding:4px 0' }, h('span', { class: 'setting-title', text: 'Speed' }), h('div', { style: 'display:flex;align-items:center;gap:8px;flex:1;max-width:200px' }, speedInput, speedLabel)),
          ]),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), nameWrap),
      h('div', { class: 'actions' }, save, retake),
    );
    preview.onFrame = (frame) => {
      const pos = trim[0] + Math.max(0, frame - 5);
      head.style.left = `${(Math.min(trim[1], pos) / (total - 1)) * 100}%`;
    };
    refresh();
  }

  async function suggestName(index: number): Promise<{ name: string; ai: boolean }> {
    const take = takes[index];
    if (!take || !place) return { name: place?.label ?? 'Move', ai: false };
    const frames = prepareFrames(take.clean, { trim: take.clean.trim, mirror: false, speed: 1 });
    const info = analyse(frames, place.slot);
    const picks = [Math.max(0, info.active[0] - 6), info.peak, Math.min(frames.length - 1, info.active[1] + 6)];
    const keyframes = picks.map((f) => keyframeImage(frames[f]));
    const slotIndex = place.key.endsWith('2') ? 2 : 1;
    const suggestion = await ai.suggestMoveName({ slot: place.slot, limb: info.limb, height: info.height, peakSpeed: Math.round(info.peakSpeed * 10) / 10, keyframes }, slotIndex);
    const name = suggestion.name.slice(0, 32);
    aiNames.set(index, name);
    return { name, ai: suggestion.source === 'ai' };
  }

  function keyframeImage(pose: Float64Array): string {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 160, 120);
    const joints = new Float64Array(JOINT_COUNT * 2);
    floatJoints(pose, joints);
    const screen = new Float32Array(JOINT_COUNT * 2);
    const scale = 48;
    for (let j = 0; j < JOINT_COUNT; j++) {
      screen[2 * j] = 70 + (joints[2 * j] - pose[0]) * scale;
      screen[2 * j + 1] = 112 - joints[2 * j + 1] * scale;
    }
    drawFigure(ctx, screen, { ink: myInk(), scale, facing: 1, outline: null });
    const webp = canvas.toDataURL('image/webp', 0.7);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  }

  async function saveMove(): Promise<void> {
    if (!place) return;
    const name = (nameInput?.value ?? '').replace(/\s+/g, ' ').trim() || place.label;
    let move: MoveFile;
    try {
      move = buildCurrent(name.slice(0, 32));
    } catch {
      toast('That trim is too short to make a move.', 'error');
      return;
    }
    if (!parseMoveFile(move)) {
      toast('Use letters, numbers and spaces in the name.', 'error');
      return;
    }
    const take = takes[current];
    if (place.key === 'idle') {
      const previous = settings.idleStance;
      await library.save({ move, createdAt: Date.now(), description: null, quality: take.clean.quality, kind: 'idle' });
      if (previous && previous !== move.id) void library.remove(previous);
      updateSettings({ idleStance: move.id });
    } else {
      await library.save({ move, createdAt: Date.now(), description: null, quality: take.clean.quality, kind: 'move' });
      updateSettings({ loadout: { ...settings.loadout, [place.key]: move.id } });
    }
    ui.stamp();
    haptic('heavy');
    toast(`${move.name} saved to ${place.label}.`, 'good');
    const key = place.key === 'idle' ? undefined : place.key;
    place = null;
    showSlots(key);
  }

  function leaveStudio(): void {
    stopCamera();
    onDone();
  }

  return {
    el,
    enter() {
      music.stop(0.8);
      const start = startKey ? LOADOUT_KEYS.find((k) => k.key === startKey) : undefined;
      if (start) choose(start);
      else showSlots();
    },
    leave() {
      disposed = true;
      stopCamera();
      preview?.destroy();
    },
  };
}
