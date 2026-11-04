/**
 * Photo arenas (AR-4, AR-5, AR-7, LS-11): snap one photo of a real place, watch the privacy pass
 * and the ink restyle run, set where the fight line goes, then fight there or share it with a
 * friend. Your arenas are listed here; they stay on this phone unless you share one.
 */
import { cleanText } from '@sticxcape/shared';
import { myInk } from '../app/player.ts';
import type { Screen } from '../app/router.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { arenaFileFor, ledgesFrom, type PhotoLayout } from '../arenas/layout.ts';
import { makePhotoArena, PhotoRejected, STEPS, type PhotoDraft, type Step } from '../arenas/pipeline.ts';
import { photoArenas, type StoredArena } from '../arenas/store.ts';
import { ui } from '../audio/sfx.ts';
import { CameraError, openCamera } from '../capture/tracker.ts';
import { stancePose } from '../engine/poses.ts';
import { createPose, JOINT_COUNT } from '../engine/skeleton.ts';
import { uuid } from '../moves/hash.ts';
import type { ArenaArt } from '../render/arenas.ts';
import { FightCamera } from '../render/camera.ts';
import { contrastInk } from '../render/inks.ts';
import { photoArenaArt } from '../render/photo-arena.ts';
import { jointsBetween } from '../render/pose.ts';
import { drawFigure } from '../render/stickman.ts';
import { copyText, h, press, stagger, svg, toast } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';
import { segmented } from '../ui/overlay.ts';
import { openSheet } from '../ui/sheet.ts';

export interface ArenaStudioActions {
  back(): void;
  /** Practice in this arena. */
  fight(arenaId: string): void;
}

/** Arena names are capped at 32 characters by the arena file format. */
const ARENA_NAME_MAX_LENGTH = 32;
const NAMES: Record<string, string> = { couch: 'The Living Room', bed: 'The Bedroom', 'dining table': 'The Kitchen', bench: 'The Park', chair: 'The Study' };
const LEDGE_NAMES: Record<string, string> = { couch: 'Sofa', bed: 'Bed', 'dining table': 'Table', bench: 'Bench', chair: 'Chair' };

export function arenaStudioScreen(actions: ArenaStudioActions): Screen {
  const urls: string[] = [];
  let stream: MediaStream | null = null;
  let disposed = false;
  const body = h('div', { class: 'arena-body' });
  const back = press(h('button', { class: 'btn btn-icon', attrs: { 'aria-label': 'Back' } }, svg(ICON.back)), () => actions.back(), { sound: 'back' });
  const header = h('header', { class: 'screen-head' }, back, h('div', null, h('div', { class: 'kicker', text: 'One photo, one arena' }), h('h1', { text: 'Photo arenas' })));
  const el = h('section', { class: 'arena-studio' }, header, body);
  const offList = photoArenas.onChange(() => {
    if (body.dataset.view === 'list') showList();
  });

  function objectUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
  }

  function stopCamera(): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  // Your arenas.

  function showList(): void {
    stopCamera();
    body.dataset.view = 'list';
    const create = press(h('button', { class: 'btn btn-primary' }, svg(ICON.camera), 'New photo arena'), () => chooseSource(), { sound: 'confirm' });
    const intro = h(
      'div',
      { class: 'card arena-intro rise' },
      h('p', { class: 'lede', style: 'margin:0', text: 'Turn one photo of a real place into somewhere to fight. Stand back so plenty of floor shows.' }),
      h('div', { class: 'status-line' }, h('i', { class: 'light is-good' }), 'People are removed and faces, screens and documents blurred before anything else happens.'),
      h('div', { class: 'status-line' }, h('i', { class: 'light is-good' }), 'It stays on this phone unless you share it with a friend. Location and photo details are dropped.'),
      create,
    );
    const cards = photoArenas.list.map((row, i) => arenaCard(row, i));
    const grid = h('div', { class: 'arena-grid' }, intro, ...cards);
    body.replaceChildren(grid);
    stagger(grid);
  }

  function arenaCard(row: StoredArena, i: number): HTMLElement {
    const thumb = h('img', { class: 'arena-thumb', attrs: { src: objectUrl(row.image), alt: '' } });
    const ledges = row.file.ledges.length;
    const drops = [row.file.edges.left, row.file.edges.right].filter((e) => e === 'drop').length;
    const fight = press(h('button', { class: 'btn btn-small btn-primary' }, svg(ICON.play), 'Fight here'), () => {
      updateSettings({ arena: row.file.id });
      actions.fight(row.file.id);
    }, { sound: 'confirm' });
    const share = press(h('button', { class: 'btn btn-small' }, svg(ICON.share), row.shared ? 'Copy link' : 'Share'), async () => {
      share.disabled = true;
      try {
        const link = await photoArenas.share(row.file.id);
        if (navigator.share) {
          await navigator.share({ title: `${row.file.name} · SticXcape`, text: 'Fight me here:', url: link }).catch(() => undefined);
        } else if (await copyText(link)) {
          toast('Link copied. Only friends you send it to can open it.', 'good');
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Couldn’t share it.', 'error', 4200);
      } finally {
        share.disabled = false;
      }
    });
    const remove = h('button', { class: 'btn btn-small btn-ghost', text: 'Delete' });
    let armed = 0;
    press(remove, () => {
      if (!armed) {
        remove.textContent = 'Tap again';
        armed = window.setTimeout(() => {
          armed = 0;
          remove.textContent = 'Delete';
        }, 3000);
        return;
      }
      clearTimeout(armed);
      if (settings.arena === row.file.id) updateSettings({ arena: 'rooftop' });
      void photoArenas.remove(row.file.id);
    }, { sound: 'back' });
    return h(
      'div',
      { class: 'card arena-card rise', style: `--i:${i + 1}` },
      thumb,
      h('div', { class: 'arena-card-body' }, h('b', { text: row.file.name }), h('small', { class: 'muted', text: [`${ledges} ${ledges === 1 ? 'ledge' : 'ledges'}`, drops ? `${drops} drop ${drops === 1 ? 'edge' : 'edges'}` : 'walls', row.shared ? 'shared' : 'private'].join(' · ') })),
      h('div', { class: 'arena-card-actions' }, fight, share, remove),
    );
  }

  // Getting a photo.

  function chooseSource(): void {
    const file = h('input', { type: 'file', attrs: { accept: 'image/*', 'aria-label': 'Photo' }, style: 'display:none' });
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (chosen) {
        sheet.close();
        void run(chosen);
      }
    });
    const sheet = openSheet(
      'New photo arena',
      h('p', { class: 'muted', style: 'margin:0 0 6px;font:600 13px/1.4 var(--ui)', text: 'A landscape photo with plenty of floor works best. Tables, benches and sofas near the front become ledges.' }),
      h(
        'div',
        { class: 'report-reasons' },
        press(h('button', { class: 'btn btn-primary' }, svg(ICON.camera), 'Take a photo'), () => {
          sheet.close();
          void takePhoto();
        }),
        press(h('button', { class: 'btn' }, 'Choose a photo'), () => file.click()),
      ),
      file,
    );
  }

  async function takePhoto(): Promise<void> {
    body.dataset.view = 'camera';
    const video = h('video', { playsInline: true, muted: true, autoplay: true, attrs: { 'aria-label': 'Camera' } });
    const guide = h('div', { class: 'fight-line' }, h('span', { text: 'The fight runs along this line' }));
    const shutter = press(h('button', { class: 'rec', attrs: { 'aria-label': 'Take the photo' } }, svg('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44"/></svg>')), () => {
      if (!video.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      ui.record(false);
      stopCamera();
      void run(canvas);
    }, { sound: 'none', noRipple: true });
    const cancel = press(h('button', { class: 'btn btn-ghost' }, 'Cancel'), () => showList(), { sound: 'back' });
    body.replaceChildren(
      h('div', { class: 'arena-camera' }, video, guide, h('div', { class: 'arena-camera-bar' }, cancel, shutter, h('span', { class: 'muted', text: 'Stand back so plenty of floor shows.' }))),
    );
    try {
      stream = await openCamera('environment');
      if (disposed) return stopCamera();
      video.srcObject = stream;
      await video.play().catch(() => undefined);
    } catch (err) {
      stopCamera();
      toast(err instanceof CameraError ? err.message : 'The camera couldn’t start. Choose a photo instead.', 'error', 4200);
      showList();
    }
  }

  // Making it.

  async function run(source: Blob | HTMLCanvasElement): Promise<void> {
    body.dataset.view = 'working';
    const rows = STEPS.map(({ step, label }) => ({ step, el: h('div', { class: 'status-line step-line' }, h('i', { class: 'light' }), label) }));
    const title = h('h2', { text: 'Making your arena' });
    body.replaceChildren(h('div', { class: 'card arena-working rise' }, h('div', { class: 'kicker', text: 'On this phone' }), title, ...rows.map((r) => r.el)));
    const mark = (current: Step) => {
      let reached = false;
      for (const r of rows) {
        const light = r.el.querySelector('i')!;
        if (r.step === current) {
          reached = true;
          light.className = 'spinner';
        } else {
          light.className = reached ? 'light' : 'light is-good';
        }
      }
    };
    try {
      const draft = await makePhotoArena(source, mark);
      if (disposed) return;
      ui.confirm();
      edit(draft);
    } catch (err) {
      if (disposed) return;
      title.textContent = 'That photo won’t work';
      const reason = err instanceof PhotoRejected ? err.message : 'Something went wrong reading that photo.';
      body.querySelector('.arena-working')!.append(
        h('p', { class: 'muted', style: 'margin:4px 0 0;font:600 13px/1.4 var(--ui)', text: reason }),
        h('div', { class: 'actions' }, press(h('button', { class: 'btn btn-primary', text: 'Try another photo' }), () => chooseSource()), press(h('button', { class: 'btn btn-ghost', text: 'Back' }), () => showList(), { sound: 'back' })),
      );
      ui.back();
    }
  }

  function edit(draft: PhotoDraft): void {
    body.dataset.view = 'edit';
    const id = uuid();
    const main = draft.found.find((f) => f.label in NAMES)?.label;
    let layout: PhotoLayout = { ...draft.layout, ledges: [...draft.layout.ledges] };
    let off = new Set<number>();
    const preview = h('canvas', { class: 'arena-preview' });
    const name = h('input', { class: 'input', value: main ? NAMES[main] : 'My Arena', maxLength: ARENA_NAME_MAX_LENGTH, attrs: { 'aria-label': 'Arena name', spellcheck: 'false' } });
    const ledgeList = h('div', { class: 'ledge-list' });

    const current = (): PhotoLayout => ({ ...layout, ledges: layout.ledges.filter((_, i) => !off.has(i)) });
    const paint = () => paintPreview(preview, photoArenaArt(arenaFileFor(id, name.value || 'My Arena', current(), draft.aspect), draft.art, draft.palette));

    const ledgeName = (i: number) => {
      const ledge = layout.ledges[i];
      const centre = ledge.x + ledge.width / 2;
      // Which piece of furniture it came from, by where it sits.
      const source = draft.found.find((f) => f.label in LEDGE_NAMES && Math.abs(-1 + ((f.x0 + f.x1) / 2) * 12 - centre) < 1.5);
      return source ? LEDGE_NAMES[source.label] : 'Ledge';
    };
    const paintLedges = () => {
      ledgeList.replaceChildren(
        ...(layout.ledges.length
          ? layout.ledges.map((ledge, i) => {
              const on = !off.has(i);
              const sw = h('button', { class: `switch${on ? ' is-on' : ''}`, attrs: { role: 'switch', 'aria-checked': String(on), 'aria-label': `Ledge ${i + 1}` } });
              sw.addEventListener('click', () => {
                if (off.has(i)) off.delete(i);
                else off.add(i);
                sw.classList.toggle('is-on', !off.has(i));
                sw.setAttribute('aria-checked', String(!off.has(i)));
                ui.toggle(!off.has(i));
                paint();
              });
              return h('div', { class: 'setting', style: 'padding:4px 0' }, h('div', { class: 'setting-text' }, h('span', { class: 'setting-title', text: ledgeName(i) }), h('span', { class: 'setting-hint', text: `${ledge.width.toFixed(1)} m wide, ${ledge.y.toFixed(2)} m up` })), sw);
            })
          : [h('span', { class: 'setting-hint', text: 'No furniture near the fight line, so no ledges. Move the line to pick some up.' })]),
      );
    };

    const line = h('input', { class: 'slider', type: 'range', min: '0.5', max: '0.95', step: '0.01', value: String(layout.floorY), attrs: { 'aria-label': 'Fight line' } });
    const fillLine = () => line.style.setProperty('--fill', `${((Number(line.value) - 0.5) / 0.45) * 100}%`);
    fillLine();
    line.addEventListener('input', () => {
      fillLine();
      layout = { ...layout, floorY: Number(line.value), ledges: ledgesFrom(draft.found, Number(line.value)) };
      off = new Set();
      paintLedges();
      paint();
    });
    const edge = (side: 'left' | 'right') =>
      segmented(
        [
          { value: 'wall', label: 'Wall' },
          { value: 'drop', label: 'Drop' },
        ],
        layout.edges[side],
        (value) => {
          layout = { ...layout, edges: { ...layout.edges, [side]: value } };
          paint();
        },
      );
    name.addEventListener('input', () => ui.type());

    const save = press(h('button', { class: 'btn btn-primary' }, svg(ICON.check), 'Save arena'), async () => {
      save.disabled = true;
      const file = arenaFileFor(id, cleanText(name.value, ARENA_NAME_MAX_LENGTH) || 'My Arena', current(), draft.aspect);
      const image = await new Promise<Blob | null>((resolve) => draft.art.toBlob(resolve, 'image/jpeg', 0.88));
      if (!image) {
        save.disabled = false;
        toast('Couldn’t save that photo on this phone.', 'error');
        return;
      }
      await photoArenas.save({ file, image, palette: draft.palette, createdAt: Date.now(), shared: null });
      ui.stamp();
      toast(`${file.name} is ready. Fight here from your arenas.`, 'good');
      showList();
    }, { sound: 'none' });
    const retake = press(h('button', { class: 'btn' }, svg(ICON.redo), 'Another photo'), () => chooseSource());

    const privacy = draft.removed + draft.blurred > 0 ? `Privacy pass: ${draft.removed} ${draft.removed === 1 ? 'person' : 'people'} removed, ${draft.blurred} ${draft.blurred === 1 ? 'thing' : 'things'} blurred.` : 'Privacy pass: no people, faces or screens found.';
    body.replaceChildren(
      h(
        'div',
        { class: 'arena-edit' },
        h('div', { class: 'arena-preview-wrap rise' }, preview),
        h(
          'div',
          { class: 'card arena-controls rise', style: '--i:1' },
          h('div', { class: 'status-line' }, h('i', { class: 'light is-good' }), privacy),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), name),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Fight line' }), line, h('span', { class: 'setting-hint', text: 'Slide it to where the floor meets the furniture.' })),
          h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Ledges' }), ledgeList),
          h('div', { class: 'setting', style: 'padding:4px 0' }, h('span', { class: 'setting-title', text: 'Left edge' }), edge('left')),
          h('div', { class: 'setting', style: 'padding:4px 0' }, h('span', { class: 'setting-title', text: 'Right edge' }), edge('right')),
          h('div', { class: 'actions' }, save, retake),
        ),
      ),
    );
    paintLedges();
    requestAnimationFrame(paint);
  }

  return {
    el,
    enter() {
      showList();
    },
    leave() {
      disposed = true;
      stopCamera();
      offList();
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}

/** The arena with both fighters at their spawns, as the fight's camera will frame it. */
function paintPreview(canvas: HTMLCanvasElement, arena: ArenaArt): void {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cam = new FightCamera();
  cam.resize(rect.width, rect.height);
  cam.arenaWidth = arena.file.width;
  cam.update(0, { x0: arena.file.spawns[0], x1: arena.file.spawns[1], top: 1.8 }, true);
  arena.draw(ctx, cam, 0);
  const pose = createPose();
  stancePose(pose, 0);
  const local = new Float32Array(JOINT_COUNT * 2);
  jointsBetween(pose, pose, 0, local);
  const mine = myInk();
  arena.file.spawns.forEach((x, side) => {
    const facing = side === 0 ? 1 : -1;
    const screen = new Float32Array(JOINT_COUNT * 2);
    for (let j = 0; j < JOINT_COUNT; j++) {
      screen[2 * j] = cam.sx(x + facing * local[2 * j]);
      screen[2 * j + 1] = cam.sy(local[2 * j + 1]);
    }
    drawFigure(ctx, screen, { ink: side === 0 ? mine : contrastInk(mine), scale: cam.ppm, facing });
  });
  arena.drawFront(ctx, cam, 0);
}

