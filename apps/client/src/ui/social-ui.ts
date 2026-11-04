/** Report and block on screen: the row under an online result, and the blocked list in Settings. */
import { block, isBlocked, report, REPORT_REASONS, unblock } from '../app/social.ts';
import { settings } from '../app/settings.ts';
import { h, press, toast } from './dom.ts';
import { addSettingsSection } from './overlay.ts';
import { openSheet } from './sheet.ts';

/** "Report" and "Block" for the player you just fought. */
export function trustRow(nickname: string, room: string | null): HTMLElement {
  const reportButton = press(h('button', { class: 'btn btn-small btn-ghost', text: 'Report' }), () => openReport(nickname, room, reportButton));
  const blockButton = press(h('button', { class: 'btn btn-small btn-ghost', text: isBlocked(nickname) ? 'Blocked' : 'Block' }), () => {
    block(nickname);
    blockButton.textContent = 'Blocked';
    blockButton.disabled = true;
    toast(`Blocked ${nickname}. You won’t fight them again; unblock in Settings.`, 'good', 3600);
  }, { sound: 'back' });
  blockButton.disabled = isBlocked(nickname);
  return h('div', { class: 'trust-row' }, h('span', { class: 'muted', text: `Problem with ${nickname}?` }), reportButton, blockButton);
}

function openReport(nickname: string, room: string | null, button: HTMLButtonElement): void {
  const sheet = openSheet(
    `Report ${nickname}`,
    h('p', { class: 'muted', style: 'margin:0 0 6px;font:600 13px/1.4 var(--ui)', text: 'What happened? Reports go to the SticXcape team; they never tell the player who sent them.' }),
    h(
      'div',
      { class: 'report-reasons' },
      ...REPORT_REASONS.map((reason) =>
        press(h('button', { class: 'btn', text: reason.label }), async () => {
          sheet.close();
          button.disabled = true;
          button.textContent = 'Reported';
          const how = await report(nickname, reason.value, room);
          toast(how === 'sent' ? 'Thanks. We’ll take a look.' : 'Thanks. It’ll send when the game server can take it.', 'good');
        }, { sound: 'confirm' }),
      ),
    ),
  );
}

/** The blocked list in Settings, each with Unblock. */
export function registerBlockedSettings(): void {
  addSettingsSection(() => {
    const list = h('div', { class: 'blocked-list' });
    const paint = () => {
      list.replaceChildren(
        ...(settings.blocked.length
          ? settings.blocked.map((name) =>
              h(
                'div',
                { class: 'setting', style: 'padding:6px 0' },
                h('span', { class: 'setting-title', text: name }),
                press(h('button', { class: 'btn btn-small', text: 'Unblock' }), () => {
                  unblock(name);
                  paint();
                }),
              ),
            )
          : [h('span', { class: 'setting-hint', text: 'Nobody. Block a player from the results after an online match.' })]),
      );
    };
    paint();
    return h('div', null, h('div', { class: 'kicker', style: 'margin-top:16px', text: 'Blocked players' }), list);
  });
}
