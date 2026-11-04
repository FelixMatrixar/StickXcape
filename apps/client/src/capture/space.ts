/**
 * The clear-space check (safety): before a capture, an object detector looks for furniture,
 * screens, plants and pets within reach of the player, and Move Studio won't record until the
 * space is clear. People are covered by the pose tracker, which already pauses for a second
 * person.
 *
 * One camera has no depth, so "within reach" is judged from the picture: sideways and upward
 * from the player's own size, and in depth from where things meet the floor. Something whose
 * base sits near the player's feet line stands about as far from the camera as they do; a TV on
 * the back wall or a table near the phone does not count.
 */
import { loadVision } from './tracker.ts';

/** A box in image coordinates, 0..1 of the width and height. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SpaceObject extends Box {
  /** COCO label from the detector. */
  label: string;
}

/** What the detector can name that a kick shouldn't meet, as a player would call it. */
export const HAZARDS: Readonly<Record<string, string>> = {
  chair: 'A chair',
  couch: 'A sofa',
  bed: 'A bed',
  'dining table': 'A table',
  bench: 'A bench',
  'potted plant': 'A plant',
  tv: 'A TV',
  laptop: 'A laptop',
  refrigerator: 'A fridge',
  oven: 'An oven',
  microwave: 'A microwave',
  sink: 'A sink',
  toilet: 'A toilet',
  bicycle: 'A bike',
  vase: 'A vase',
  'wine glass': 'A glass',
  bottle: 'A bottle',
  dog: 'A dog',
  cat: 'A cat',
};

/** Reach around the body, in body heights: an arm's length or a kick. */
const REACH = 0.55;
/** How far an object's base may sit from the feet line, in body heights, and still be beside the player. */
const SAME_DEPTH = 0.18;

/** The hazards within reach of the body. `aspect` is the image's width over its height. */
export function withinReach(objects: readonly SpaceObject[], body: Box, aspect: number): SpaceObject[] {
  const height = body.y1 - body.y0;
  if (height <= 0) return [];
  // Sideways distances in units of image height, so they compare with upward ones.
  const reach = REACH * height;
  const left = body.x0 * aspect - reach;
  const right = body.x1 * aspect + reach;
  const top = body.y0 - 0.1 * height;
  return objects.filter((o) => {
    if (!(o.label in HAZARDS)) return false;
    const besideX = o.x1 * aspect > left && o.x0 * aspect < right;
    const besideY = o.y1 > top && o.y0 < body.y1;
    const sameDepth = Math.abs(o.y1 - body.y1) <= SAME_DEPTH * height;
    // Cut off by the bottom of the picture while the feet are clear of it: nearer the phone than the player.
    const nearPhone = o.y1 >= 0.985 && body.y1 < 0.95;
    return besideX && besideY && sameDepth && !nearPhone;
  });
}

/** The player's box from the tracker's 33 landmarks (x, y, z, visibility each), or null. */
export function bodyBox(points: Float32Array): Box | null {
  let x0 = 1;
  let x1 = 0;
  let y0 = 1;
  let y1 = 0;
  let seen = 0;
  for (let i = 0; i < points.length / 4; i++) {
    if (points[i * 4 + 3] < 0.4) continue;
    const x = points[i * 4];
    const y = points[i * 4 + 1];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    seen += 1;
  }
  if (seen < 8 || y1 <= y0) return null;
  // Landmarks stop at the eyes and the ankles: add the top of the head.
  return { x0, y0: y0 - 0.08 * (y1 - y0), x1, y1 };
}

/** Only what showed up in at least 2 of the last 3 looks counts, so one stray detection never blocks. */
export function steady(history: readonly ReadonlySet<string>[], near: readonly SpaceObject[]): SpaceObject[] {
  return near.filter((o) => history.filter((labels) => labels.has(o.label)).length >= 2);
}

interface Detection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories: { categoryName: string; score: number }[];
}

interface ObjectDetector {
  detectForVideo(video: HTMLVideoElement, timestamp: number): { detections: Detection[] };
  close(): void;
}

/** EfficientDet-Lite0 (COCO labels); the photo arena privacy pass uses it too. */
export const OBJECT_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
const MODEL = OBJECT_MODEL;
const LOOK_MS = 500;
const LOAD_TIMEOUT_MS = 10_000;

let detectorPromise: Promise<ObjectDetector> | null = null;

/** EfficientDet-Lite0 (4.6 MB), loaded once, after the pose tracker. Twice a second on the CPU is plenty. */
function loadDetector(): Promise<ObjectDetector> {
  detectorPromise ??= (async () => {
    const { vision, fileset } = await loadVision();
    return (await vision.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      scoreThreshold: 0.35,
      maxResults: 12,
    })) as ObjectDetector;
  })();
  detectorPromise.catch(() => (detectorPromise = null));
  return detectorPromise;
}

/** Looks at the room a couple of times a second while Move Studio is getting ready to record. */
export class SpaceWatch {
  state: 'loading' | 'ready' | 'failed' = 'loading';
  /** Hazards within reach right now. */
  hazards: SpaceObject[] = [];
  private detector: ObjectDetector | null = null;
  private timer = 0;
  private stopped = false;
  private readonly history: Set<string>[] = [];

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly body: () => Box | null,
    private readonly paused: () => boolean,
  ) {}

  start(): void {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS));
    Promise.race([loadDetector(), timeout])
      .then((detector) => {
        if (this.stopped) return;
        this.detector = detector;
        this.state = 'ready';
        this.timer = window.setInterval(() => this.look(), LOOK_MS);
        this.look();
      })
      .catch(() => {
        if (!this.stopped) this.state = 'failed';
      });
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private look(): void {
    if (!this.detector || this.paused() || this.video.readyState < 2) return;
    const body = this.body();
    if (!body) {
      this.history.length = 0;
      this.hazards = [];
      return;
    }
    const vw = this.video.videoWidth || 1;
    const vh = this.video.videoHeight || 1;
    let detections: Detection[];
    try {
      detections = this.detector.detectForVideo(this.video, performance.now()).detections;
    } catch {
      return;
    }
    const objects: SpaceObject[] = [];
    for (const d of detections) {
      const box = d.boundingBox;
      const label = d.categories[0]?.categoryName;
      if (!box || !label) continue;
      objects.push({ label, x0: box.originX / vw, y0: box.originY / vh, x1: (box.originX + box.width) / vw, y1: (box.originY + box.height) / vh });
    }
    const near = withinReach(objects, body, vw / vh);
    this.history.push(new Set(near.map((o) => o.label)));
    if (this.history.length > 3) this.history.shift();
    this.hazards = steady(this.history, near);
  }
}
