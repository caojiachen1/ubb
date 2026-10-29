// Aggregated MCP catalog: core (the Wave 0 ubb_* baseline) plus one file per
// feature agent, so Wave 1+ never edits daemon/mcp.mjs or each other's file.
// Order is the tools/list order; core entries keep their original positions.

import { CORE_TOOLS } from './core.mjs';
import { QUICK_TOOLS } from './quick.mjs';
import { REPLAY_TOOLS } from './replay.mjs';
import { DOWNLOADS_TOOLS } from './downloads.mjs';
import { SECRETS_TOOLS } from './secrets.mjs';
import { FRAMES_TOOLS } from './frames.mjs';
import { SITES_TOOLS } from './sites.mjs';

export const TOOLS = [
  ...CORE_TOOLS,
  ...QUICK_TOOLS,
  ...REPLAY_TOOLS,
  ...DOWNLOADS_TOOLS,
  ...SECRETS_TOOLS,
  ...FRAMES_TOOLS,
  ...SITES_TOOLS,
];
