// Wave 0 offline registry self-check (contract §6.2) — no browser, no daemon:
//   node daemon/test-foundation.mjs
// Wave 1+ copy this file for their own module; lib/testharness.mjs does the stubbing.

import { collectRegistry } from '../lib/testharness.mjs';

const MIN_TOOLS = 83;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const { names, metas, call } = await collectRegistry();

ok(`registry has >= ${MIN_TOOLS} tools`, names.length >= MIN_TOOLS, `got ${names.length}`);

const noCategory = names.filter((n) => !metas[n]?.category);
ok('every tool declares a category', noCategory.length === 0, noCategory.join(', '));

// a tab_id outside any session must stop in targetTab(), not crash on chrome
let code = null;
let thrown = null;
try {
  await call('snapshot', { tab_id: 99999 });
} catch (e) {
  thrown = e;
  code = e?.code ?? null;
}
ok('snapshot without a session throws NO_SESSION', code === 'NO_SESSION',
  thrown ? `got ${code || 'plain throw'}: ${thrown?.message || thrown}` : 'it returned instead of throwing');

// the chrome stub is load-bearing: a chrome-backed tool must run through it
const listed = await call('tab.list', { scope: 'session' });
ok('tab.list runs against the chrome stub', Array.isArray(listed?.tabs), JSON.stringify(listed));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
