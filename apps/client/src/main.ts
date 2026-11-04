/**
 * SticXcape game client. The flow from the frontend PRD: open the link, tap to start, pick a
 * nickname, record moves or skip, then home, room, fight and results.
 */
import './styles/main.css';
import { roomCodeFromPath } from '@sticxcape/shared';
import { flow } from './app/flow.ts';
import { initRouter } from './app/router.ts';
import { audio } from './audio/engine.ts';
import { flushReports } from './app/social.ts';
import { photoArenas } from './arenas/store.ts';
import { library } from './moves/library.ts';
import { initOverlay } from './ui/overlay.ts';
import { registerBlockedSettings } from './ui/social-ui.ts';

const root = document.getElementById('app')!;
initRouter(root);
initOverlay(document.body);
registerBlockedSettings();
// Reports that couldn't be sent last time go out now, quietly.
void flushReports();

// Sound waits for the first tap or key anywhere.
const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock, { capture: true });
window.addEventListener('keydown', unlock, { capture: true });

// Keep pinch and double-tap zoom from fighting the controls on phones.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

const invite = roomCodeFromPath(location.pathname);
// A friend's photo arena link: /a/{id}.
const arena = /^\/a\/([a-z0-9-]{1,64})\/?$/.exec(location.pathname)?.[1] ?? null;
void Promise.all([library.ready, photoArenas.ready]).then(() => flow.boot(invite, arena));
