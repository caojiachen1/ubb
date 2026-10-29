// Wave 1-C curated ubb_* definitions for download + audit tooling.
// Shape: { name, description, inputSchema, ubb } — see core.mjs / schema.mjs.
import { s } from './schema.mjs';

export const DOWNLOADS_TOOLS = [
  {
    name: 'ubb_download_list',
    description:
      'List downloads the extension observed (ring of 200, newest first) — including blob:/server-generated ones you never triggered yourself, so after a click that started a download use this instead of guessing. Each item has an absolute path. There is no download.read tool (a service worker has no filesystem): from a terminal `ubb download cat <id>` prints the text ones, and for binaries keep the bytes out of the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: s('number', 'Only downloads that started in this tab. Omit for all tabs (this does not change the session target tab).'),
        state: s('string', 'Filter by state: in_progress | complete | interrupted.'),
        limit: s('number', 'Max items (default 50, cap 200).'),
      },
      additionalProperties: true,
    },
    ubb: 'download.list',
  },
  {
    name: 'ubb_download_wait',
    description:
      'Wait for a download to reach complete|interrupted and get its final record with the absolute path. A DOWNLOAD_PENDING error is not a failure — the transfer is still running; call again with a larger timeout_ms.',
    inputSchema: {
      type: 'object',
      properties: {
        download_id: s('number', 'chrome download id from ubb_download_list or ubb_call download.'),
        timeout_ms: s('number', 'How long to block (default 30000, max 300000).'),
      },
      required: ['download_id'],
      additionalProperties: true,
    },
    ubb: 'download.wait',
  },
  {
    name: 'ubb_download_path',
    description:
      'Filesystem path, state, size and mime of one download (works mid-transfer). text_readable:true means a text-ish file you may open from the terminal; otherwise keep the bytes out of the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        download_id: s('number', 'Download id from ubb_download_list.'),
      },
      required: ['download_id'],
      additionalProperties: true,
    },
    ubb: 'download.path',
  },
  {
    name: 'ubb_audit_tail',
    description:
      'Incremental read of the operation audit ring (500 entries, in the extension only — `ubb audit tail --follow` mirrors it to ~/.ubb/audit/*.jsonl). Pass since_seq = the last seq you saw; entries come back oldest-first with last_seq for the next call.',
    inputSchema: {
      type: 'object',
      properties: {
        since_seq: s('number', 'Return entries with seq greater than this (default 0 = whole ring).'),
        limit: s('number', 'Max entries per call (default 200, cap 500).'),
      },
      additionalProperties: true,
    },
    ubb: 'audit.tail',
  },
  {
    name: 'ubb_audit_stats',
    description:
      'Per-tool call/error counts with avg+max duration (ms), bucketed by day. Check it before retry-looping a tool that keeps failing.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['all'] }],
          description: 'Recent days to summarize (default 7), or "all".',
        },
      },
      additionalProperties: true,
    },
    ubb: 'audit.stats',
  },
];
