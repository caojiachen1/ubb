// Wave 2-D ("frames"): iframe truth-gathering for the model and the user.
// frames.list  — cheap registry: extension frames, bridge reachability, pairing
// frames.probe — the one-call diagnostic for the live-browser verification
// (contract §10): which frame ops this Edge/Chrome build actually supports.
// Shared helpers come from ./actions.js; nothing here re-declares them.

import {
  cdp,
  bridge,
  targetTab,
  audit,
  redact,
  redactUrl,
  truncate,
  err,
} from './actions.js';
import { flattenFrameTree } from './cdp.js';
import { listExtFrames, matchChildrenToFrames, frameElementBox, frameStepsFor } from './snapshot.js';
import { refs } from './refs.js';

const AX_LIMIT = 400; // frames probed per command — a page with 500 ad frames
// must not wedge the tool

export function register(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  R('frames.list', {
    category: 'diagnostics',
    description: 'Frame registry of the target tab: every extension frame id (the frame[N] numbers used by snapshot/read_page/extract), its URL, parent, bridge reachability, and whether it is reachable as a CDP frame in the page session. Read-only; lists, never touches the page.',
  }, async (p = {}) => {
    const tabId = targetTab(p);
    const ext = await listExtFrames(tabId);
    if (!ext) throw err('FRAMES_UNSUPPORTED', 'chrome.webNavigation.getAllFrames is unavailable here');
    let cdpIds = null;
    try {
      cdpIds = new Set(flattenFrameTree(await cdp.send(tabId, 'Page.getFrameTree')).map((f) => f.frameId));
    } catch { /* attach refused (restricted page) — extension view still answers */ }
    const frames = [];
    for (const f of ext.slice(0, AX_LIMIT)) {
      const info = await bridge(tabId, 'selfInfo', {}, f.frameId).catch(() => null);
      frames.push({
        frame_id: f.frameId,
        parent_frame_id: f.parentFrameId ?? null,
        url: redactUrl(f.url || ''),
        name: f.name || undefined,
        bridge: info ? 'reachable' : 'absent',
        is_frame: info ? !!info.isFrame : undefined,
        viewport: info ? { w: info.innerWidth, h: info.innerHeight } : undefined,
        same_origin_ancestry: info ? !!info.sameOriginAncestry : undefined,
      });
    }
    audit.log({ action: 'frames.list', tabId, frames: frames.length });
    return redact({ tab_id: tabId, frames, cdp_session_known: cdpIds ? cdpIds.size : null });
  });

  R('frames.probe', {
    category: 'diagnostics',
    timeoutMs: 60000,
    description: 'READ-ONLY frame capability diagnostic — nothing is clicked, typed, scrolled or navigated (checks.scroll_y_by_frame / page_state_unchanged prove it per frame; one throwaway isolated world per CDP frame is created to test context availability, and an ambiguous same-url sibling may be transiently stamped and restored within the call — no other page write happens, and no element is scrolled into view). Per CDP frame: Accessibility.getFullAXTree({frameId}) success or error code, Page.createIsolatedWorld({frameId}) success, DOM.getFrameOwner host box; plus the extension-frame ↔ DOM-<iframe> pairing WITH the basis of each pairing (checks.pairing_resolved_by / paired[].resolved_by: url, url+frame-name, stamp:attr, stamp:name, unresolved), the window.name identity handshake result including the full blocking error, devicePixelRatio/viewport, and whether the flattened DOM index reached into child documents. Run this once after reloading the extension on a page with iframes — its output is the truth table for which frame paths THIS browser build supports (Wave 5 verification input). Because nothing is scrolled, a coordinate_path_sample with a negative viewport_box.y means the element is off-screen at the current scroll position, not a wrong measurement.',
  }, async (p = {}) => {
    const tabId = targetTab(p);
    const out = { tab_id: tabId, cdp_frames: [], ext_frames: [], pairing: [], checks: {} };

    // --- extension view: frames + bridge reachability ---
    const ext = await listExtFrames(tabId);
    const selfInfos = new Map();
    for (const f of (ext || []).slice(0, AX_LIMIT)) {
      const info = await bridge(tabId, 'selfInfo', {}, f.frameId).catch(() => null);
      if (info) selfInfos.set(f.frameId, info);
      out.ext_frames.push({
        frame_id: f.frameId,
        parent_frame_id: f.parentFrameId ?? null,
        url: redactUrl(f.url || ''),
        bridge: info ? 'reachable' : 'absent',
      });
    }
    const topInfo = selfInfos.get(0) || (await bridge(tabId, 'selfInfo', {}, 0).catch(() => null));
    out.checks.device_pixel_ratio = topInfo?.dpr ?? null;
    out.checks.top_viewport = topInfo ? { w: topInfo.innerWidth, h: topInfo.innerHeight } : null;

    // --- CDP view (needs the debugger; restricted tabs answer with the gate) ---
    let tree = null;
    try {
      tree = await cdp.send(tabId, 'Page.getFrameTree');
    } catch (e) {
      out.checks.cdp_attach = String(e?.message || e).slice(0, 200);
      audit.log({ action: 'frames.probe', tabId, cdp: false });
      return redact(out);
    }
    const cdpFrames = flattenFrameTree(tree);
    out.checks.cdp_attach = 'attached';
    out.checks.main_frame_id = tree?.frameTree?.frame?.id || null;

    // flattened-document reach: did the shared node index see child documents?
    const flat = await cdp.send(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true }).catch((e) => ({ error: String(e?.message || e) }));
    if (flat?.nodes) {
      const byFrame = new Map();
      for (const n of flat.nodes) {
        const k = n.frameId || '(none)';
        byFrame.set(k, (byFrame.get(k) || 0) + 1);
      }
      out.checks.flattened_document_node_counts = Object.fromEntries([...byFrame].slice(0, 40));
    } else {
      out.checks.flattened_document_node_counts = 'error: ' + String(flat?.error || 'no nodes').slice(0, 160);
    }

    for (const f of cdpFrames.slice(0, AX_LIMIT)) {
      const rec = {
        frame_id: f.frameId,
        parent_frame_id: f.parentId,
        url: redactUrl(f.url || ''),
        name: f.name || undefined,
      };
      // is there a separate TARGET for this frame (= OOPIF in this build)?
      const ax = await cdp.send(tabId, 'Accessibility.getFullAXTree', { frameId: f.frameId }).catch((e) => ({ __error: String(e?.message || e) }));
      rec.getFullAXTree = ax?.__error ? { ok: false, error: ax.__error.slice(0, 160) } : { ok: true, nodes: (ax?.nodes || []).length };
      const world = await cdp.send(tabId, 'Page.createIsolatedWorld', { frameId: f.frameId, worldName: 'ubb-probe' }).catch((e) => ({ __error: String(e?.message || e) }));
      rec.createIsolatedWorld = world?.__error ? { ok: false, error: world.__error.slice(0, 160) } : { ok: true, context_id: world?.executionContextId ?? null };
      if (!f.parentId) rec.getFrameOwner = { ok: false, note: 'main frame has no owner' };
      else {
        const owner = await cdp.send(tabId, 'DOM.getFrameOwner', { frameId: f.frameId }).catch((e) => ({ __error: String(e?.message || e) }));
        if (owner?.__error) rec.getFrameOwner = { ok: false, error: owner.__error.slice(0, 160) };
        else {
          const oid = (await cdp.send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [owner.backendNodeId] }).catch(() => null))?.nodeIds?.[0];
          const model = oid ? await cdp.send(tabId, 'DOM.getBoxModel', { nodeId: oid }).catch(() => null) : null;
          rec.getFrameOwner = { ok: true, backend_node_id: owner.backendNodeId, host_box: model?.model?.content ? truncate(JSON.stringify(model.model.content), 120) : null };
        }
      }
      out.cdp_frames.push(rec);
    }

    // --- pairing: ext frame ↔ parent <iframe> element (the coordinate-path spine) ---
    if (ext) {
      for (const parent of ext.slice(0, AX_LIMIT)) {
        const kids = ext.filter((f) => f.parentFrameId === parent.frameId);
        if (!kids.length) continue;
        const geom = await bridge(tabId, 'childFrameBoxes', {}, parent.frameId).catch(() => null);
        if (!geom) {
          out.pairing.push({ parent_frame_id: parent.frameId, error: 'bridge absent — cannot enumerate child <iframe> elements' });
          continue;
        }
        const { pairs, unresolved } = matchChildrenToFrames(
          kids.map((k) => ({ frameId: k.frameId, url: k.url, name: k.name || '' })),
          geom.frames,
        );
        const rows = pairs.map((x) => ({ frame_id: x.frameId, order: x.order, resolved_by: x.matchedBy || 'url' }));
        const hard = [];
        for (const u of unresolved) {
          const row = {
            frame_id: u.frameId,
            reason: u.reason,
            url: redactUrl(u.url || ''),
            candidate_orders: u.candidateOrders || [],
            resolved_by: 'unresolved',
          };
          if (u.candidateOrders?.length) {
            // ask the ACTION path how it would resolve this edge — same stamp
            // ladder, so "position vs identity channel" is a measurement and not
            // an inference (live-verify §1 could not observe resolvedBy at all)
            try {
              const { meta } = await frameStepsFor(tabId, u.frameId);
              const edge = meta[meta.length - 1];
              row.resolved_by = edge?.resolvedBy || 'unknown';
              row.order = edge?.pairOrder;
            } catch (e) {
              row.stamp_attempt = 'failed: ' + String(e?.message || e);
            }
          }
          hard.push(row);
        }
        out.pairing.push({
          parent_frame_id: parent.frameId,
          dom_children: geom.frames.length,
          ext_children: kids.length,
          paired: rows,
          unresolved: hard,
        });
      }
    }

    // --- window.name handshake truth (cross-origin identity channel) ---
    {
      const crossChild = (ext || []).find((f) => f.parentFrameId === 0 && f.frameId !== 0 && !selfInfos.get(f.frameId)?.sameOriginAncestry && selfInfos.has(f.frameId));
      if (crossChild) {
        const token = 'probe' + Math.random().toString(36).slice(2, 8);
        const parentGeom = await bridge(tabId, 'childFrameBoxes', {}, 0).catch(() => null);
        const order = parentGeom?.frames?.findIndex((d) => d.src && crossChild.url && d.src === crossChild.url);
        if (order != null && order >= 0) {
          const st = await bridge(tabId, 'stampChild', { order, token, via: 'name' }, 0).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          const read = st?.ok ? await bridge(tabId, 'readStamp', {}, crossChild.frameId).catch(() => null) : null;
          if (st?.ok) await bridge(tabId, 'unstampChild', { order, via: 'name', restore: st.restore }, 0).catch(() => {});
          // the FULL error text: it is the evidence for "this build blocks the
          // cross-origin identity channel", and the 120-char cut used to amputate
          // exactly the part that says why (live-verify §1)
          out.checks.window_name_handshake = st?.ok
            ? (read?.name === token ? 'works' : 'set but child read back "' + truncate(String(read?.name), 40) + '"')
            : 'failed: ' + String(st?.error ?? 'unknown');
          out.checks.window_name_handshake_frame_id = crossChild.frameId;
        }
      } else {
        out.checks.window_name_handshake = 'not tested (no cross-origin child frame of the top document reachable via the bridge on this page)';
      }
      const how = new Map();
      for (const row of out.pairing) {
        for (const p of row.paired || []) how.set(p.resolved_by, (how.get(p.resolved_by) || 0) + 1);
        for (const u of row.unresolved || []) how.set(u.resolved_by, (how.get(u.resolved_by) || 0) + 1);
      }
      out.checks.pairing_resolved_by = Object.fromEntries(how);
      if (out.checks.pairing_resolved_by && !out.checks.pairing_resolved_by['stamp:name']) {
        out.checks.pairing_note =
          'no edge was resolved by the window.name stamp handshake' +
          (String(out.checks.window_name_handshake || '').startsWith('failed') ? ' (that channel is blocked on this page — pairing is URL/DOM-order only, so same-url siblings would be refused, not guessed)' : '');
      }
    }

    // --- end-to-end sample: compose the viewport box of one frame element ---
    {
      // MEASUREMENT ONLY: scroll:false, so the probe leaves the page exactly
      // where it found it (live-verify §1: one probe moved scrollY 2520 → 911
      // while advertising itself as READ-ONLY). With no scroll in between, the
      // frame-chain offsets and the element rect are sampled at the same instant.
      const readScrolls = async () => {
        const m = {};
        for (const fid of selfInfos.keys()) {
          const info = await bridge(tabId, 'selfInfo', {}, fid).catch(() => null);
          if (info) m[fid] = info.scroll ? info.scroll.y : null;
        }
        return m;
      };
      const scrollBefore = await readScrolls();
      let sample = null;
      for (const [fid, info] of selfInfos) {
        if (fid === 0 || !info.isFrame) continue;
        const treeR = await bridge(tabId, 'getDomTree', { filter: 'interactive', max_chars: 2000 }, fid).catch(() => null);
        const e0 = treeR?.entries?.[0];
        if (!e0) continue;
        const ref = refs.put(tabId, null, { role: e0.role, name: e0.name, frameId: fid, domRef: e0.ref, epoch: info.epoch });
        try {
          const { box, desc } = await frameElementBox(tabId, refs.get(tabId, ref), { scroll: false });
          const vh = topInfo?.innerHeight ?? null;
          sample = {
            ref,
            frame_id: fid,
            viewport_box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
            // a box outside the top viewport is OFF-SCREEN, not "wrong": the
            // page was deliberately not scrolled for this measurement
            on_screen: vh == null ? null : box.y >= 0 && box.y + box.height <= vh,
            visible_in_frame: desc?.visible ?? null,
            frame_local_box: desc?.local ? { x: Math.round(desc.local.x), y: Math.round(desc.local.y) } : null,
            frame_scroll_y: scrollBefore[fid] ?? null,
          };
        } catch (e) {
          sample = { ref, frame_id: fid, error: truncate(String(e?.message || e), 200) };
        }
        break;
      }
      const scrollAfter = await readScrolls();
      const moved = Object.keys(scrollBefore).filter((k) => scrollBefore[k] !== scrollAfter[k]);
      out.checks.scroll_y_by_frame = { before: scrollBefore, after: scrollAfter };
      out.checks.page_state_unchanged = { scroll_moved_in_frames: moved, unchanged: moved.length === 0 };
      if (sample && moved.length) sample.probe_moved_the_page = true;
      out.checks.coordinate_path_sample = sample || 'no bridge-reachable child frame with elements to measure';
    }

    audit.log({ action: 'frames.probe', tabId, cdp_frames: out.cdp_frames.length, ext_frames: out.ext_frames.length });
    return redact(out);
  });
}
