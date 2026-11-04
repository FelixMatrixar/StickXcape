/**
 * SticXcape game client. The flow from the frontend PRD: open the link, tap to start, pick a
 * nickname, record moves or skip, then home, room, fight and results.
 */
import './styles/main.css';
import { roomCodeFromPath } from '@sticxcape/shared';
import { flow } from './app/flow.ts';
import { initRouter } from './app/router.ts';
import { audio } from './audio/engine.ts';
import { library } from './moves/library.ts';
import { initOverlay } from './ui/overlay.ts';

const root = document.getElementById('app')!;
initRouter(root);
initOverlay(document.body);

// Sound waits for the first tap or key anywhere.
const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock, { capture: true });
window.addEventListener('keydown', unlock, { capture: true });

// Keep pinch and double-tap zoom from fighting the controls on phones.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

const invite = roomCodeFromPath(location.pathname);
void library.ready.then(() => flow.boot(invite));
