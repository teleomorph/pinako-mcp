// liteNode Chrome tab-group mapping smoke harness.
// Run with: node tests/lite-node-chrome-groups.smoke.js   (from pinako-mcp/)
//        or: node pinako-mcp/tests/lite-node-chrome-groups.smoke.js (from repo root)
//
// Guards the fix in host.js liteNode() (~line 2043) that maps Chrome tab-group
// metadata from node.groupSnapshot = {groupId, title, color} onto the output
// fields chromeGroupId / chromeGroupTitle / chromeGroupColor. Rules under test:
//   1. Only for type:'tab' nodes with a truthy groupSnapshot, and only when the
//      include_chrome_tab_groups shape opt is on (defaults ON in lite mode,
//      forced OFF when opts.minimal === true).
//   2. chromeGroupId is emitted only when groupSnapshot.groupId != null AND
//      node.chromeId !== null (ghost tabs keep title/color, drop the stale id).
//   3. Library clones store groupSnapshot.groupId = null → title/color, no id.
//   4. Ungrouped tabs (groupSnapshot null) and non-tab nodes emit none.
//   5. REGRESSION GUARD: the buggy code read node.chromeGroupId etc. directly
//      (fields that never exist on real data), so a grouped LIVE tab silently
//      emitted nothing. The live-grouped fixture below carries ONLY groupSnapshot
//      (no top-level chromeGroup* fields), so if the mapping ever reverts to
//      reading node.chromeGroupId the "all three fields" case fails.
//
// Loading: host.js is an ESM native-messaging host with import statements and
// load-time side effects (it binds :37421 and reads stdin), and liteNode is not
// exported — so it can't be imported or whole-file-loaded via new Function the
// way sessions.js/mutation-engine.js are (those attach their API to a global).
// liteNode is a self-contained PURE function, so we slice its exact source out
// of host.js and eval it in isolation with the same fs.readFileSync + new
// Function machinery the other smoke harnesses use. This exercises the REAL
// host.js source of liteNode (a true regression guard), not a hand-kept mirror.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = path.join(__dirname, '..', 'host.js');
const SIG = 'function liteNode(node, scope, libraryId, opts)';

// Slice a top-level function declaration out of source by brace-matching from
// its signature, skipping braces inside line/block comments and string
// literals. (liteNode contains balanced braces inside a // comment; this keeps
// the extraction robust against unbalanced ones in future edits. liteNode has
// no regex literals, so regex state is intentionally not tracked.)
function extractFunction(src, sig) {
    const start = src.indexOf(sig);
    if (start < 0) return null;
    let i = src.indexOf('{', start);
    if (i < 0) return null;
    let depth = 0;
    let state = 'code'; // code | line | block | sq | dq | tpl
    for (; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (state === 'line')  { if (c === '\n') state = 'code'; continue; }
        if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++; } continue; }
        if (state === 'sq')    { if (c === '\\') i++; else if (c === "'") state = 'code'; continue; }
        if (state === 'dq')    { if (c === '\\') i++; else if (c === '"') state = 'code'; continue; }
        if (state === 'tpl')   { if (c === '\\') i++; else if (c === '`') state = 'code'; continue; }
        // state === 'code'
        if (c === '/' && n === '/') { state = 'line';  i++; continue; }
        if (c === '/' && n === '*') { state = 'block'; i++; continue; }
        if (c === "'") { state = 'sq'; continue; }
        if (c === '"') { state = 'dq'; continue; }
        if (c === '`') { state = 'tpl'; continue; }
        if (c === '{') depth++;
        else if (c === '}') { if (--depth === 0) return src.slice(start, i + 1); }
    }
    return null;
}

const hostSrc = fs.readFileSync(HOST_JS, 'utf8');
const fnSource = extractFunction(hostSrc, SIG);
if (!fnSource) {
    console.error('FAIL: could not locate liteNode() in host.js — signature may have changed:\n  ' + SIG);
    process.exit(1);
}
// Hoisted declaration inside the Function body; return the reference.
const liteNode = new Function(fnSource + '\nreturn liteNode;')();
if (typeof liteNode !== 'function') {
    console.error('FAIL: extracted liteNode is not a function');
    process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`✗ ${name}\n    ${e.message}`);
    }
}
function assertEq(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
function assertAbsent(out, keys, label) {
    for (const k of keys) {
        if (k in out) {
            throw new Error(`${label}: expected key '${k}' to be absent, got ${JSON.stringify(out[k])}`);
        }
    }
}
const GROUP_KEYS = ['chromeGroupId', 'chromeGroupTitle', 'chromeGroupColor'];

// ── (a) live grouped tab → all three fields with correct values ──────────────
check('(a) live grouped tab emits chromeGroupId/Title/Color from groupSnapshot', () => {
    // Fixture carries ONLY groupSnapshot — no top-level chromeGroup* fields — so
    // this doubles as the regression guard for rule #5.
    const node = {
        id: 't1', type: 'tab', title: 'Docs', url: 'https://example.com/',
        chromeId: 4321,
        groupSnapshot: { groupId: 7, title: 'Work', color: 'blue' },
    };
    assertAbsent(node, GROUP_KEYS, 'fixture sanity (no top-level chromeGroup* fields)');
    const out = liteNode(node, 'tree', null, {});
    assertEq(out.chromeGroupId, 7, 'chromeGroupId');
    assertEq(out.chromeGroupTitle, 'Work', 'chromeGroupTitle');
    assertEq(out.chromeGroupColor, 'blue', 'chromeGroupColor');
    assertAbsent(out, ['ghost'], 'live tab is not a ghost');
});

// ── (b) ghost grouped tab (chromeId:null) → title+color, NO chromeGroupId ─────
check('(b) ghost grouped tab keeps title+color but suppresses the stale chromeGroupId', () => {
    const node = {
        id: 't2', type: 'tab', title: 'Docs',
        chromeId: null,
        groupSnapshot: { groupId: 7, title: 'Work', color: 'blue' },
    };
    const out = liteNode(node, 'tree', null, {});
    assertAbsent(out, ['chromeGroupId'], 'ghost suppresses stale live group id');
    assertEq(out.chromeGroupTitle, 'Work', 'chromeGroupTitle');
    assertEq(out.chromeGroupColor, 'blue', 'chromeGroupColor');
    assertEq(out.ghost, true, 'ghost flag');
});

// ── (c) library-clone tab (groupId:null, chromeId:null) → title+color only ────
check('(c) library-clone tab (groupId null) emits title+color, no chromeGroupId', () => {
    const node = {
        id: 't3', type: 'tab', title: 'Docs',
        chromeId: null,
        groupSnapshot: { groupId: null, title: 'Work', color: 'blue' },
    };
    const out = liteNode(node, 'library', 'lib-1', {});
    assertAbsent(out, ['chromeGroupId'], 'null groupId emits no id');
    assertEq(out.chromeGroupTitle, 'Work', 'chromeGroupTitle');
    assertEq(out.chromeGroupColor, 'blue', 'chromeGroupColor');
});

// ── (d) ungrouped live tab (groupSnapshot null) → none of the three ──────────
check('(d) ungrouped live tab (groupSnapshot null) emits none of the group fields', () => {
    const node = {
        id: 't4', type: 'tab', title: 'Docs', url: 'https://example.com/',
        chromeId: 99,
        groupSnapshot: null,
    };
    const out = liteNode(node, 'tree', null, {});
    assertAbsent(out, GROUP_KEYS, 'ungrouped tab');
});

// ── (e) minimal:true → none of the fields even for a grouped live tab ────────
check('(e) minimal:true suppresses all group fields even for a grouped live tab', () => {
    const node = {
        id: 't5', type: 'tab', title: 'Docs',
        chromeId: 4321,
        groupSnapshot: { groupId: 7, title: 'Work', color: 'blue' },
    };
    const out = liteNode(node, 'tree', null, { minimal: true });
    assertAbsent(out, GROUP_KEYS, 'minimal mode forces include_chrome_tab_groups off');
});

// ── (f) non-tab node with a stray groupSnapshot → none of the fields ─────────
check('(f) non-tab node with a stray groupSnapshot emits none of the group fields', () => {
    const node = {
        id: 'w1', type: 'window', title: 'Window',
        groupSnapshot: { groupId: 7, title: 'Work', color: 'blue' },
        children: [],
    };
    const out = liteNode(node, 'tree', null, {});
    assertAbsent(out, GROUP_KEYS, 'group mapping is tab-only');
});

// ── (g) per-field guard: live tab with groupId+title but no color ────────────
// Guards the independent `if (gs.title)` / `if (gs.color)` conditionals: a
// missing color must not synthesize a chromeGroupColor while id+title still emit.
check('(g) partial groupSnapshot (no color) emits id+title, omits chromeGroupColor', () => {
    const node = {
        id: 't6', type: 'tab', title: 'Docs',
        chromeId: 4321,
        groupSnapshot: { groupId: 7, title: 'Work' }, // color absent
    };
    const out = liteNode(node, 'tree', null, {});
    assertEq(out.chromeGroupId, 7, 'chromeGroupId');
    assertEq(out.chromeGroupTitle, 'Work', 'chromeGroupTitle');
    assertAbsent(out, ['chromeGroupColor'], 'absent color emits no field');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
