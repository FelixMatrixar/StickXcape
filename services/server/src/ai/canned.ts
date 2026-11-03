import type { MatchTipsRequest, MatchTipsResponse, MoveNameRequest, MoveNameResponse, MoveSlot, MoveStats } from '@sticxcape/shared';
import { jointWords } from './prompts.ts';

/**
 * Canned answers for when no Meta API key is set (local work, CI, staging before a key),
 * so every flow still runs. Tips come from simple rules over the same stats Meta AI reads.
 */

const NAMES: Record<MoveSlot, readonly string[]> = {
  light: ['Quick Jab', 'Snap Kick', 'Flick Punch', 'Pocket Jab'],
  heavy: ['Thunder Fist', 'Haymaker', 'Spinning Backfist', 'Brick Breaker'],
  low: ['Leg Sweep', 'Ankle Biter', 'Shin Snap'],
  special: ['Flying Kick', 'Cartwheel Strike', 'Comet Drop'],
  defense: ['Slip Away', 'Shoulder Roll', 'Iron Wall'],
  taunt: ['Come At Me', 'Shadow Boxer'],
  victory: ['Champion Pose', 'Mic Drop'],
};

const STRIKE_WORDS: Partial<Record<MoveSlot, string>> = { light: 'jab', heavy: 'blow', low: 'sweep', special: 'showstopper' };

export function cannedMoveName(request: MoveNameRequest): MoveNameResponse {
  const names = NAMES[request.slot];
  const name = names[(Math.round(request.peakSpeed * 10) + request.limb.length + request.height.length) % names.length]!;
  const strike = STRIKE_WORDS[request.slot];
  const description = strike
    ? `A ${request.height} ${strike} led by the ${jointWords(request.limb)}.`
    : request.slot === 'defense'
      ? 'A quick dodge that leaves them swinging at air.'
      : request.slot === 'taunt'
        ? 'Rubs it in. No damage included.'
        : "The pose for the winner's photo.";
  return { name, description };
}

const COMBAT_SLOTS = new Set<MoveSlot>(['light', 'heavy', 'low', 'special']);

export function cannedMatchTips(request: MatchTipsRequest): MatchTipsResponse {
  const tips: string[] = [];
  const most = (key: 'parries' | 'blocks' | 'misses'): MoveStats | undefined =>
    request.moves.reduce<MoveStats | undefined>((best, move) => (move[key] > (best?.[key] ?? 0) ? move : best), undefined);

  const parried = most('parries');
  if (parried && parried.parries >= 2) tips.push(`${parried.name} was parried ${parried.parries} times; delay it a beat or feint first.`);
  const blocked = most('blocks');
  if (blocked && blocked.blocks >= 3) tips.push(`${blocked.name} was blocked ${blocked.blocks} times; mix in a low to break their guard.`);
  const missed = most('misses');
  if (missed && missed.misses >= 3) tips.push(`${missed.name} whiffed ${missed.misses} times; step in closer before you throw it.`);
  const best = request.moves.filter((move) => move.uses >= 2 && move.hits > 0).sort((a, b) => b.hits / b.uses - a.hits / a.uses)[0];
  if (best) tips.push(`${best.name} landed ${best.hits} of ${best.uses}; lean on it more next match.`);
  const unused = request.moves.find((move) => move.uses === 0 && COMBAT_SLOTS.has(move.slot));
  if (unused) tips.push(`You never used ${unused.name}; throw it in to keep them guessing.`);
  tips.push('Tap Block just before a hit lands to parry and earn a free counter.', 'Mix high, mid and low moves so they cannot guard everything.');

  const [first, second] = [...new Set(tips)];
  return { tips: [first!, second!] };
}
