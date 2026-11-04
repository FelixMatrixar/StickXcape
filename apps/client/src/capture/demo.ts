/**
 * A demo take for when there's no camera (desktop, denied permission, testing): a default move
 * replayed as if MediaPipe had tracked it, at 30 fps with jitter, a dropped joint now and then,
 * a little standing around before and after, and either facing. It goes through exactly the
 * same cleanup as a real take.
 */
import type { MoveFile } from '@sticxcape/shared';
import { compileMove, sampleMove } from '../engine/moves.ts';
import { builtinPose, P } from '../engine/poses.ts';
import { createPose, J, JOINT_COUNT } from '../engine/skeleton.ts';
import { jointsBetween } from '../render/pose.ts';
import { LANDMARKS, type PoseFrame } from './tracker.ts';

const ASPECT = 16 / 9;

function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 0.8;
}

/** Joint for each MediaPipe landmark, with a small forward/up offset in metres. */
const LANDMARK_JOINT: [number, number, number][] = [
  [J.head, 0.09, 0.0], // 0 nose
  [J.head, 0.06, 0.03],
  [J.head, 0.06, 0.03],
  [J.head, 0.06, 0.03],
  [J.head, 0.06, 0.03],
  [J.head, 0.06, 0.03],
  [J.head, 0.06, 0.03],
  [J.head, -0.02, 0.01], // 7 left ear
  [J.head, -0.02, 0.01], // 8 right ear
  [J.head, 0.07, -0.05],
  [J.head, 0.07, -0.05],
  [J.lShoulder, 0, 0], // 11
  [J.rShoulder, 0, 0],
  [J.lElbow, 0, 0],
  [J.rElbow, 0, 0],
  [J.lWrist, 0, 0], // 15
  [J.rWrist, 0, 0],
  [J.lWrist, 0.04, 0],
  [J.rWrist, 0.04, 0],
  [J.lWrist, 0.05, 0],
  [J.rWrist, 0.05, 0],
  [J.lWrist, 0.03, 0.02],
  [J.rWrist, 0.03, 0.02],
  [J.lHip, 0, 0], // 23
  [J.rHip, 0, 0],
  [J.lKnee, 0, 0],
  [J.rKnee, 0, 0],
  [J.lAnkle, 0, 0], // 27
  [J.rAnkle, 0, 0],
  [J.lAnkle, -0.05, -0.02],
  [J.rAnkle, -0.05, -0.02],
  [J.lToe, 0, 0], // 31
  [J.rToe, 0, 0],
];

export function demoTake(move: MoveFile): PoseFrame[] {
  const compiled = compileMove(move, 0);
  const facing = Math.random() < 0.5 ? 1 : -1;
  const pose = createPose();
  const joints = new Float32Array(JOINT_COUNT * 2);
  const frames: PoseFrame[] = [];
  const idleBefore = 24 + Math.floor(Math.random() * 12);
  const idleAfter = 30;
  const total = idleBefore + compiled.frameCount + idleAfter;
  const scale = 0.4; // image heights per metre
  const baseX = 0.5 + (Math.random() - 0.5) * 0.15;
  const sway = Math.random() * 6;
  let t = performance.now();
  for (let f = 0; f < total; f += 2) {
    const into = f - idleBefore;
    let rootX = 0;
    if (into >= 0 && into < compiled.frameCount) {
      sampleMove(compiled, into * 65536, pose);
      rootX = pose[0] / 65536;
    } else {
      builtinPose(pose, P.stance, f);
      if (into >= compiled.frameCount) {
        sampleMove(compiled, (compiled.frameCount - 1) * 65536, createPose());
        rootX = compiled.frames[(compiled.frameCount - 1) * 19] / 65536;
      }
    }
    pose[0] = 0;
    jointsBetween(pose, pose, 0, joints);
    const points = new Float32Array(LANDMARKS * 4);
    for (let i = 0; i < LANDMARKS; i++) {
      const [joint, fwd, up] = LANDMARK_JOINT[i];
      const mx = joints[2 * joint] + fwd + rootX + Math.sin(f * 0.05 + sway) * 0.01;
      const my = joints[2 * joint + 1] + up;
      const noise = joint === J.lWrist || joint === J.rWrist || joint === J.lToe || joint === J.rToe ? 0.006 : 0.004;
      points[i * 4] = baseX + (facing * mx * scale) / ASPECT + gauss() * noise;
      points[i * 4 + 1] = 0.9 - my * scale + gauss() * noise;
      points[i * 4 + 2] = 0;
      // Now and then a limb hides behind the body.
      points[i * 4 + 3] = Math.random() < 0.03 ? 0.15 : 0.92;
    }
    frames.push({ t, points, people: 1 });
    t += 1000 / 30;
  }
  return frames;
}

export const DEMO_ASPECT = ASPECT;
