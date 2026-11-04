/**
 * Camera and body tracking (MS-1, MS-2): MediaPipe Pose Landmarker running in the browser. The
 * model loads only when Move Studio opens, so fights start fast; video never leaves the phone.
 */

/** One tracked frame: 33 landmarks as x, y (0..1 of the image), z and visibility. */
export interface PoseFrame {
  t: number;
  points: Float32Array;
  /** How many people the tracker saw (Move Studio pauses for a second person). */
  people: number;
}

interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

interface PoseLandmarkerResult {
  landmarks: Landmark[][];
}

interface PoseLandmarker {
  detectForVideo(video: HTMLVideoElement, timestamp: number): PoseLandmarkerResult;
  close(): void;
}

/** The parts of MediaPipe Tasks Vision the game uses. */
export interface VisionModule {
  FilesetResolver: { forVisionTasks(base: string): Promise<unknown> };
  PoseLandmarker: { createFromOptions(fileset: unknown, options: unknown): Promise<PoseLandmarker> };
  ObjectDetector: { createFromOptions(fileset: unknown, options: unknown): Promise<unknown> };
  FaceDetector: { createFromOptions(fileset: unknown, options: unknown): Promise<unknown> };
}

const VERSION = '0.10.21';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export const LANDMARKS = 33;

let visionPromise: Promise<{ vision: VisionModule; fileset: unknown }> | null = null;

/** MediaPipe's runtime, loaded once from the CDN and shared by the tracker and the space check. */
export function loadVision(): Promise<{ vision: VisionModule; fileset: unknown }> {
  visionPromise ??= (async () => {
    const vision = (await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`)) as VisionModule;
    const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    return { vision, fileset };
  })();
  visionPromise.catch(() => (visionPromise = null));
  return visionPromise;
}

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/** Loads the tracker once; GPU when the phone allows, otherwise CPU. */
export function loadTracker(): Promise<PoseLandmarker> {
  landmarkerPromise ??= (async () => {
    const { vision, fileset } = await loadVision();
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 2,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      return await vision.PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      return await vision.PoseLandmarker.createFromOptions(fileset, options('CPU'));
    }
  })();
  landmarkerPromise.catch(() => (landmarkerPromise = null));
  return landmarkerPromise;
}

export type CameraFacing = 'user' | 'environment';

export class CameraError extends Error {
  readonly reason: 'insecure' | 'denied' | 'missing' | 'other';
  constructor(reason: CameraError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Opens the camera in landscape, asking for 60 fps where the phone can do it. */
export async function openCamera(facing: CameraFacing): Promise<MediaStream> {
  if (!window.isSecureContext) throw new CameraError('insecure', 'The camera needs HTTPS. Open the game through an https link.');
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('missing', 'This browser can’t open a camera.');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } },
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', 'Camera permission was turned down. Allow it in the browser’s site settings.');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('missing', 'No camera was found on this device.');
    throw new CameraError('other', 'The camera couldn’t start.');
  }
}

/** Runs the tracker on each new video frame. */
export class Tracking {
  private raf = 0;
  private lastTime = -1;
  running = false;

  constructor(
    private readonly landmarker: PoseLandmarker,
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (frame: PoseFrame | null) => void,
  ) {}

  start(): void {
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      if (this.video.readyState < 2) return;
      const now = performance.now();
      if (this.video.currentTime === this.lastTime) return;
      this.lastTime = this.video.currentTime;
      try {
        const result = this.landmarker.detectForVideo(this.video, now);
        const pose = result.landmarks[0];
        if (!pose) return this.onFrame(null);
        const points = new Float32Array(LANDMARKS * 4);
        for (let i = 0; i < LANDMARKS; i++) {
          const p = pose[i];
          points[i * 4] = p.x;
          points[i * 4 + 1] = p.y;
          points[i * 4 + 2] = p.z;
          points[i * 4 + 3] = p.visibility ?? 1;
        }
        this.onFrame({ t: now, points, people: result.landmarks.length });
      } catch {
        this.onFrame(null);
      }
    };
    tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
