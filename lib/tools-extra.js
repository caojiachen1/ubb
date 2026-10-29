// Second registration site: every tool module added after Wave 0 plugs in here,
// so parallel agents never have to edit lib/tools.js or background.js.
// One line per module, in load order; each module owns only its own file.

import { register as registerQuick } from './tools-quick.js';
import { register as registerReplay } from './tools-replay.js';
import { register as registerDownloads } from './tools-downloads.js';
import { register as registerSecrets } from './tools-secrets.js';
import { register as registerFrames } from './tools-frames.js';
import { register as registerSites } from './tools-sites.js';

export function registerExtras(dispatcher) {
  registerQuick(dispatcher);
  registerReplay(dispatcher);
  registerDownloads(dispatcher);
  registerSecrets(dispatcher);
  registerFrames(dispatcher);
  registerSites(dispatcher);
}
