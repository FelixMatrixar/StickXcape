/**
 * Results (MP-5): the winner, per-move stats (landed, blocked, parried, missed) and two Meta AI
 * coach tips built from them, then Rematch or Edit moves. Tips never hold up the screen: they
 * type in when they arrive, and quick local tips stand in when the AI is unavailable.
 */
import type { MatchTipsRequest, MoveStats } from '@sticxcape/shared';
import { HttpAiService } from '@sticxcape/netcode';
import type { Screen } from '../app/router.ts';
import { ui } from '../audio/sfx.ts';
import { music } from '../audio/music.ts';
import type { FightResult } from './fight.ts';
import { MovePreview } from '../render/preview.ts';
import { countUp, h, press, sleep, stagger, svg, typewriter } from '../ui/dom.ts';
import { ICON } from '../ui/icons.ts';
import { LOADOUT_KEYS } from '../moves/loadout.ts';

export interface ResultsActions {
  rematch(): void;
  editMoves(): void;
  home(): void;
  rematchLabel?: string;
}

const ai = new HttpAiService();

export function resultsScreen(result: FightResult, actions: ResultsActions): Screen {
  const { sim, config, reason, winnerSide } = result;
  const me = sim.fighters[config.localSide];
  const them = sim.fighters[config.localSide === 0 ? 1 : 0];
  const won = winnerSide === config.localSide;
  const draw = winnerSide === null;
  const verdictText = reason === 'desync' ? 'Desync' : reason === 'disconnect' ? (won ? 'They left' : 'Disconnected') : draw ? 'Draw' : won ? 'Victory' : 'Defeat';
  const winnerIndex = winnerSide ?? config.localSide;

  const heroCanvas = h('canvas');
  const verdict = h(
    'div',
    { class: 'verdict' },
    h('div', { class: 'kicker', style: 'color:rgba(255,255,255,.75)', text: config.mode === 'practice' ? 'Practice match' : 'Online match' }),
    h('h1', { class: won ? 'is-win' : '', text: verdictText }),
    h('div', { class: 'score', text: `${config.names[0]} ${sim.fighters[0].roundsWon} – ${sim.fighters[1].roundsWon} ${config.names[1]}` }),
  );
  const hero = h('div', { class: 'results-hero rise' }, heroCanvas, verdict);

  // Per-move stats for the local player's strikes.
  const rows = me.moves
    .map((move, i) => ({ move, stat: me.stats[i] }))
    .filter(({ move, stat }) => move.hasHitbox || stat.uses > 0)
    .filter(({ move }) => move.slot !== 'victory');
  const most = Math.max(1, ...rows.map((r) => r.stat.uses));
  const statsCard = h(
    'div',
    { class: 'card stats rise', style: '--i:1' },
    h('div', { class: 'stats-head' }, h('span', { text: 'Your moves' }), h('span', { text: 'Landed' }), h('span', { text: 'Blocked' }), h('span', { text: 'Parried' }), h('span', { text: 'Missed' })),
    ...rows.map(({ move, stat }, i) => {
      const cell = (value: number, color: string) => {
        const num = h('b', { text: '0' });
        const bar = h('i', { style: `--w:${Math.round((value / most) * 100)}%;--c:${color};--i:${i}` });
        requestAnimationFrame(() => countUp(num, value, 600));
        return h('span', { class: 'stat-cell' }, num, bar);
      };
      const label = LOADOUT_KEYS.find((k) => k.slot === move.slot)?.label ?? move.slot;
      return h(
        'div',
        { class: 'stat-row' },
        h('span', { class: 'stat-name' }, h('span', { text: move.name }), h('small', { text: `${label} · used ${stat.uses}×` })),
        cell(stat.hits, '#0f9f7c'),
        cell(stat.blocks, '#2f62e6'),
        cell(stat.parries, '#f2b134'),
        cell(stat.misses, '#b5ab9b'),
      );
    }),
  );

  const tipEls = [0, 1].map((i) =>
    h('div', { class: 'card tip rise', style: `--i:${2 + i}` }, h('span', { class: 'num', text: String(i + 1) }), h('div', { class: 'tip-text' }, h('i', { class: 'shimmer', style: 'width:90%' }), h('i', { class: 'shimmer', style: 'width:60%' }))),
  );
  const coachLabel = h('div', { class: 'kicker', style: 'display:flex;align-items:center;gap:8px' }, 'Coach', h('span', { class: 'tag tag-ai', text: 'Meta AI' }));
  const tips = h('div', { class: 'tips' }, coachLabel, ...tipEls);

  const rematch = press(h('button', { class: 'btn btn-primary pulse' }, svg(ICON.redo), actions.rematchLabel ?? 'Rematch'), () => actions.rematch(), { sound: 'confirm' });
  const edit = press(h('button', { class: 'btn' }, svg(ICON.edit), 'Edit moves'), () => actions.editMoves());
  const home = press(h('button', { class: 'btn btn-ghost' }, 'Home'), () => actions.home(), { sound: 'back' });
  const actionRow = h('div', { class: 'actions rise', style: '--i:4' }, rematch, edit, home);
  const side = h('div', { class: 'results-side' }, statsCard, tips, actionRow);
  const el = h('section', { class: 'results' }, hero, side);

  const preview = new MovePreview(heroCanvas, { ink: config.inks[winnerIndex], background: '#24201c', floor: 'rgba(255,255,255,0.12)', span: 3.1, rest: 0.1, outline: 'rgba(255,250,240,0.9)' });
  const victory = sim.fighters[winnerIndex].moves.find((m) => m.slot === 'victory');
  const victoryFile = config.loadouts[winnerIndex].find((m) => m.id === victory?.id) ?? null;
  preview.setMove(victoryFile);

  async function loadTips(): Promise<void> {
    const moves: MoveStats[] = rows.map(({ move, stat }) => ({
      name: move.name,
      slot: move.slot,
      height: (['high', 'mid', 'low'] as const)[move.height],
      uses: stat.uses,
      hits: stat.hits,
      blocks: stat.blocks,
      parries: stat.parries,
      misses: stat.misses,
    }));
    const request: MatchTipsRequest = {
      moves: moves.length > 0 ? moves : [{ name: 'Jab', slot: 'light', uses: 0, hits: 0, blocks: 0, parries: 0, misses: 0 }],
      damageDealt: Math.round(me.damageDealt / 10),
      damageTaken: Math.round(me.damageTaken / 10),
      result: draw ? 'draw' : won ? 'win' : 'loss',
    };
    let list = await ai.getMatchTips(request);
    let fromAi = true;
    if (list.length !== 2) {
      list = localTips(request);
      fromAi = false;
    }
    if (!fromAi) coachLabel.replaceChildren('Quick tips', h('span', { class: 'tag', text: 'Offline' }));
    await sleep(350);
    for (let i = 0; i < 2; i++) {
      const target = tipEls[i].querySelector('.tip-text') as HTMLElement;
      await typewriter(target, list[i] ?? '');
      await sleep(120);
    }
  }

  return {
    el,
    enter() {
      stagger(side);
      preview.play();
      music.play('menu');
      if (won) {
        ui.sparkle();
        confetti(hero, config.inks[winnerIndex].ink);
      }
      void loadTips();
      void them;
    },
    leave() {
      preview.destroy();
    },
  };
}

function confetti(host: HTMLElement, color: string): void {
  const colors = [color, '#f2b134', '#ffffff', '#161514'];
  for (let i = 0; i < 46; i++) {
    const bit = h('i', { class: 'confetti' });
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 260;
    bit.style.left = '50%';
    bit.style.top = '45%';
    bit.style.background = colors[i % colors.length];
    bit.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    bit.style.setProperty('--dy', `${Math.sin(angle) * dist + 140}px`);
    bit.style.setProperty('--r', `${(Math.random() - 0.5) * 900}deg`);
    bit.style.animationDelay = `${Math.random() * 0.25 + 0.3}s`;
    host.append(bit);
    setTimeout(() => bit.remove(), 2400);
  }
}

/** Tips worked out on the phone from the same stats, when the AI can't answer. */
function localTips(request: MatchTipsRequest): string[] {
  const tips: string[] = [];
  const byParries = [...request.moves].sort((a, b) => b.parries - a.parries)[0];
  const byMisses = [...request.moves].sort((a, b) => b.misses - a.misses)[0];
  const byBlocks = [...request.moves].sort((a, b) => b.blocks - a.blocks)[0];
  const best = [...request.moves].sort((a, b) => b.hits - a.hits)[0];
  if (byParries && byParries.parries >= 2) tips.push(`${byParries.name} got parried ${byParries.parries} times. Delay it a beat to bait the tap.`);
  if (byBlocks && byBlocks.blocks >= 3) tips.push(`${byBlocks.name} was blocked ${byBlocks.blocks} times. Mix in a low to open them up.`);
  if (byMisses && byMisses.misses >= 4) tips.push(`${byMisses.name} whiffed ${byMisses.misses} times. Step in closer before you throw it.`);
  if (best && best.hits >= 3) tips.push(`${best.name} landed ${best.hits} times. Cancel it into a heavy for a combo.`);
  tips.push('Tap Block just before a hit lands to parry, then punish with a heavy.');
  tips.push('Mix high, mid and low so they can never guard everything.');
  return tips.slice(0, 2);
}
