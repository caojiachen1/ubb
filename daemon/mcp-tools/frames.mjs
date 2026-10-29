// Wave 2-D ("frames"): curated ubb_* definitions for iframe-scoped tools.
// Shape: { name, description, inputSchema, ubb } — see core.mjs for examples and schema.mjs for s()/TAB_ID.
import { s, TAB_ID } from './schema.mjs';

export const FRAMES_TOOLS = [
  {
    name: 'ubb_frames_probe',
    description: 'READ-ONLY iframe capability diagnostic: per-CDP-frame getFullAXTree/createIsolatedWorld/getFrameOwner results, extension-frame ↔ <iframe> element pairing with the basis of every pairing (paired[].resolved_by: url / url+frame-name / stamp:attr / stamp:name / unresolved), the window.name handshake result with the FULL blocking error text, devicePixelRatio, and a composed viewport box sample. It does not click, type, navigate or scroll — checks.page_state_unchanged reports the per-frame scrollY before/after as proof, and a negative viewport_box.y simply means the element is off-screen at the current scroll position. Run after loading a page with iframes (or after an extension reload) to see what this browser build actually supports before attempting frame actions.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', TAB_ID[1]) }, required: [] },
    ubb: 'frames.probe',
  },
  {
    name: 'ubb_frames_list',
    description: 'List the target tab\u2019s frames with their extension frame ids (the frame[N] used by snapshot sections and read_page/extract frame_id), parent, URL, and bridge reachability. Read-only.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', TAB_ID[1]) }, required: [] },
    ubb: 'frames.list',
  },
];
