/**
 * The photo arena pipeline (AR-4, AR-5, LS-11): read the photo, privacy pass, find the floor and
 * ledges, redraw it in ink, check there's room to fight. At launch the services do the
 * understanding and the restyle with SAM 3.1 and Muse Image; until then all of it runs on the
 * phone, so the photo never leaves it.
 *
 * The privacy pass can't be skipped: people are smeared out, and faces, screens and documents
 * pixelated, before anything else looks at the photo. If its detectors can't load, the photo is
 * turned down rather than used without it.
 */
import { OBJECT_MODEL } from '../capture/space.ts';
import { loadVision } from '../capture/tracker.ts';
import { average, brightness, inkWash, muted, type Rgb } from './ink.ts';
import { checkPhoto, layoutFor, type FoundBox, type PhotoLayout } from './layout.ts';

export type Step = 'read' | 'privacy' | 'floor' | 'ink' | 'check';

export const STEPS: readonly { step: Step; label: string }[] = [
  { step: 'read', label: 'Reading the photo' },
  { step: 'privacy', label: 'Privacy pass: people out, faces and screens blurred' },
  { step: 'floor', label: 'Finding the floor and ledges' },
  { step: 'ink', label: 'Redrawing it in ink' },
  { step: 'check', label: 'Checking there’s room to fight' },
];

/** Colours sampled from the photo, muted to sit behind the fighters. */
export interface Palette {
  sky: string;
  skyLow: string;
  floorTop: string;
  floorBottom: string;
  ledge: string;
  ledgeTop: string;
}

export interface PhotoDraft {
  /** The restyled backdrop. */
  art: HTMLCanvasElement;
  aspect: number;
  found: FoundBox[];
  layout: PhotoLayout;
  palette: Palette;
  /** How many people were removed and how many faces, screens or documents blurred. */
  removed: number;
  blurred: number;
}

/** A photo that won't make a playable arena, with a reason a player can act on. */
export class PhotoRejected extends Error {}

const MAX_WIDTH = 1280;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
/** Things to blur: screens and documents (COCO has no plates indoors to speak of). */
const BLUR_LABELS = new Set(['tv', 'laptop', 'cell phone', 'book']);

interface Detection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories: { categoryName: string; score: number }[];
}
interface ImageDetector {
  detect(image: HTMLCanvasElement): { detections: Detection[] };
}

let objects: Promise<ImageDetector> | null = null;
let faces: Promise<ImageDetector> | null = null;

function objectDetector(): Promise<ImageDetector> {
  objects ??= loadVision().then(({ vision, fileset }) =>
    vision.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: OBJECT_MODEL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      scoreThreshold: 0.3,
      maxResults: 40,
    }),
  ) as Promise<ImageDetector>;
  objects.catch(() => (objects = null));
  return objects;
}

function faceDetector(): Promise<ImageDetector> {
  faces ??= loadVision().then(({ vision, fileset }) =>
    vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.4,
    }),
  ) as Promise<ImageDetector>;
  faces.catch(() => (faces = null));
  return faces;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** Runs every step on the phone. `onStep` hears each step as it starts. */
export async function makePhotoArena(source: Blob | HTMLCanvasElement, onStep: (step: Step) => void): Promise<PhotoDraft> {
  onStep('read');
  await tick();
  const photo = await readPhoto(source);
  const { width: w, height: h } = photo;
  const ctx = photo.getContext('2d', { willReadFrequently: true })!;

  onStep('privacy');
  await tick();
  let detected: Detection[];
  let faceBoxes: Detection[];
  try {
    const [objectModel, faceModel] = await Promise.all([objectDetector(), faceDetector()]);
    detected = objectModel.detect(photo).detections;
    faceBoxes = faceModel.detect(photo).detections;
  } catch {
    throw new PhotoRejected('The privacy check couldn’t run, so the photo wasn’t used. Check your connection and try again.');
  }
  const box = (d: Detection) => d.boundingBox ?? { originX: 0, originY: 0, width: 0, height: 0 };
  const label = (d: Detection) => d.categories[0]?.categoryName ?? '';
  let removed = 0;
  let blurred = 0;
  for (const d of detected) {
    const b = box(d);
    if (label(d) === 'person') {
      smear(ctx, photo, b.originX, b.originY, b.width, b.height);
      removed += 1;
    } else if (BLUR_LABELS.has(label(d))) {
      pixelate(ctx, photo, b.originX, b.originY, b.width, b.height);
      blurred += 1;
    }
  }
  for (const d of faceBoxes) {
    const b = box(d);
    pixelate(ctx, photo, b.originX, b.originY, b.width, b.height, 6);
    blurred += 1;
  }

  onStep('floor');
  await tick();
  const found: FoundBox[] = detected
    .filter((d) => label(d) !== 'person')
    .map((d) => {
      const b = box(d);
      return { label: label(d), x0: b.originX / w, y0: b.originY / h, x1: (b.originX + b.width) / w, y1: (b.originY + b.height) / h };
    });
  const layout = layoutFor(found);

  onStep('ink');
  await tick();
  const pixels = ctx.getImageData(0, 0, w, h);
  const washed = inkWash({ width: w, height: h, data: pixels.data });
  const art = document.createElement('canvas');
  art.width = w;
  art.height = h;
  art.getContext('2d')!.putImageData(new ImageData(washed.data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);

  onStep('check');
  await tick();
  const cleaned = { width: w, height: h, data: pixels.data };
  const light = brightness(average(cleaned, 0, 0, 1, 1));
  const problem = checkPhoto(w, h, layout.floorY, light);
  if (problem) throw new PhotoRejected(problem);

  return { art, aspect: w / h, found, layout, palette: paletteFor(cleaned, layout, found), removed, blurred };
}

/** The photo, upright, at most 1280 wide. Drawing it again drops its GPS and other metadata. */
async function readPhoto(source: Blob | HTMLCanvasElement): Promise<HTMLCanvasElement> {
  let image: CanvasImageSource;
  let w: number;
  let h: number;
  if (source instanceof Blob) {
    try {
      const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
      image = bitmap;
      w = bitmap.width;
      h = bitmap.height;
    } catch {
      throw new PhotoRejected('That file isn’t a photo this phone can read. Try a JPEG or PNG.');
    }
  } else {
    image = source;
    w = source.width;
    h = source.height;
  }
  const scale = Math.min(1, MAX_WIDTH / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Shrinks the area to a few pixels and stretches it back: the person is gone, their surroundings' colours stay. */
function smear(ctx: CanvasRenderingContext2D, photo: HTMLCanvasElement, x: number, y: number, w: number, h: number): void {
  const pad = 0.08;
  const ax = Math.max(0, x - w * pad);
  const ay = Math.max(0, y - h * pad);
  const bw = Math.min(photo.width - ax, w * (1 + 2 * pad));
  const bh = Math.min(photo.height - ay, h * (1 + 2 * pad));
  if (bw < 2 || bh < 2) return;
  const tiny = document.createElement('canvas');
  tiny.width = 4;
  tiny.height = 4;
  const t = tiny.getContext('2d')!;
  t.drawImage(photo, ax, ay, bw, bh, 0, 0, 4, 4);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tiny, 0, 0, 4, 4, ax, ay, bw, bh);
  ctx.restore();
}

/** Big blocks: nothing readable or recognisable survives. */
function pixelate(ctx: CanvasRenderingContext2D, photo: HTMLCanvasElement, x: number, y: number, w: number, h: number, cells = 10): void {
  const ax = Math.max(0, x);
  const ay = Math.max(0, y);
  const bw = Math.min(photo.width - ax, w);
  const bh = Math.min(photo.height - ay, h);
  if (bw < 2 || bh < 2) return;
  const cw = Math.max(1, Math.round(cells * (bw / Math.max(bw, bh))));
  const ch = Math.max(1, Math.round(cells * (bh / Math.max(bw, bh))));
  const tiny = document.createElement('canvas');
  tiny.width = cw;
  tiny.height = ch;
  tiny.getContext('2d')!.drawImage(photo, ax, ay, bw, bh, 0, 0, cw, ch);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, cw, ch, ax, ay, bw, bh);
  ctx.restore();
}

function paletteFor(source: { width: number; height: number; data: Uint8ClampedArray }, layout: PhotoLayout, found: FoundBox[]): Palette {
  const sky = average(source, 0, 0, 1, 0.18);
  const wall = average(source, 0, 0.3, 1, layout.floorY - 0.05);
  const floor = average(source, 0, layout.floorY, 1, 1);
  const biggest = [...found].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  const ledge: Rgb = biggest ? average(source, biggest.x0, biggest.y0, biggest.x1, biggest.y1) : floor;
  return {
    sky: muted(sky),
    skyLow: muted(wall, 0.15),
    floorTop: muted(floor, 0.12),
    floorBottom: muted(floor, 0.45),
    ledge: muted(ledge, 0.25),
    ledgeTop: muted(ledge, 0.05),
  };
}
