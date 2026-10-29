// Wave 3-F/6 ("sites"): curated ubb_* definitions for the site-rule tools.
// Shape: { name, description, inputSchema, ubb } — see core.mjs and schema.mjs.
// Only the two read-only ones get a curated entry; site.rules.reload,
// site.rules.add, site.rules.remove and site.rules.clear (confirm-gated, they
// write chrome.storage.local) stay on ubb_call. The two curated descriptions
// still have to NAME the undo pair, because "added and cannot revoke" was the
// real-machine finding (LIVE-RESULTS-3B §F4). fix13 kept that choice (contract
// §2: a new tool does not have to be curated; ubb_call reaches both, and the
// list tool points at them) and pinned it: daemon/test-sites.mjs [8] fails if
// the pair is curated silently or if the list description stops naming them.
import { s } from './schema.mjs';

const RULE_SCHEMA = 'A rule is data only: {id, match:{host_pattern, path_pattern?, test_selector?}, extract:[block…], join?, referer?, normalize?, reject?}. ' +
  'block = {op:"text"|"join_texts"|"images"|"videos"|"group"|"repeat"|"reset", select?/attempts?, within?, item?, prefix?, suffix?, then?/max?/min_chars?, when?{selector_found|selector_absent|parts_below}}. ' +
  'Any executable key (eval, script, function, on*, html, url, href…) is refused.';

export const SITES_TOOLS = [
  {
    name: 'ubb_site_rules_list',
    description:
      'Every site rule read_site can match, in match order: {id, source: builtin|user, removable: bool, match, blocks}. Packaged content/site-rules.json plus user overrides from extension storage — a user rule comes first, shadows the builtin with the same id, and is the ONLY kind this side can revoke: undo one with ubb_call site.rules.remove {"id":…,"confirm":true}, the whole user layer with ubb_call site.rules.clear {"confirm":true} (builtins are packaged and stay). Read-only, no tab needed. Check a draft first with ubb_site_rules_validate.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    ubb: 'site.rules.list',
  },
  {
    name: 'ubb_site_rules_validate',
    description:
      `Dry-run site rules: schema/op whitelist, selector syntax, regex fields, duplicate ids and a hard refusal of executable fields — nothing is stored, nothing runs. Returns {ok, issues:[{rule, path, kind, message}], warnings}. ${RULE_SCHEMA} Always validate before site.rules.add; with tab_id it also parses every selector against that live document (dom_probe).`,
    inputSchema: {
      type: 'object',
      properties: {
        rules: { type: 'array', description: 'Candidate rules to check (max a handful — this only reports, it never saves).', items: { type: 'object' } },
        tab_id: s('number', 'Optional session tab used to parse selectors against a real document. Omit for the static check only.'),
      },
      required: ['rules'],
      additionalProperties: true,
    },
    ubb: 'site.rules.validate',
  },
];
