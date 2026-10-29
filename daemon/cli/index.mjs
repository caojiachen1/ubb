// Aggregated `ubb <subcommand>` table. Feature agents add commands by editing
// their own file in this directory — never daemon/ubb.mjs (see
// _scratch/AGENT-CONTRACT.md §3). A command is { name, describe, run(argv) }.

import { SECRET_COMMANDS } from './secret.mjs';
import { AUDIT_COMMANDS } from './audit.mjs';
import { LIVEVIEW_COMMANDS } from './liveview.mjs';
import { DOWNLOAD_COMMANDS } from './download.mjs';

export const CLI_COMMANDS = [...SECRET_COMMANDS, ...AUDIT_COMMANDS, ...LIVEVIEW_COMMANDS, ...DOWNLOAD_COMMANDS];

/**
 * Run a contributed subcommand when `cmd` names one; returns whether it ran.
 * A command may declare `takes(argv)` when it only owns SOME shapes of its own
 * name — returning false here means "not mine", so ubb.mjs falls through to the
 * tool dispatch. Without `takes` the table behaves exactly as before.
 */
export async function runCliCommand(cmd, argv) {
  const c = CLI_COMMANDS.find((x) => x.name === cmd);
  if (!c) return false;
  if (c.takes && !c.takes(argv)) return false;
  await c.run(argv);
  return true;
}

/** `ubb help` lines for the contributed commands (empty table → empty string). */
export function cliHelpLines() {
  return CLI_COMMANDS.map((c) => `  ubb ${c.name} — ${c.describe}`).join('\n');
}
