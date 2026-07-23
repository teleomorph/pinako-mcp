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
//      EXCEPT type:'tabgroup' container nodes — see rules 6-8 below.
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
//
// N5 (Tab Group nodes, tab-group-node-plan.md) added the containment world:
//   6. A type:'tabgroup' node stamps {chromeGroupId, title, color} onto a
//      DERIVED opts object, and every tab in its branch (at ANY depth)
//      derives chromeGroupId/Title/Color from it — member tabs post-migration
//      carry no groupSnapshot of their own. Same suppression rules apply
//      (a ghost member drops the live id, keeps title/color).
//   7. The tabgroup node ITSELF emits chromeGroupId (live only) +
//      chromeGroupColor. No chromeGroupTitle — its `title` IS the group name.
//   8. The ancestor stamp WINS over a tab's own groupSnapshot when both are
//      present (containment is the structural truth), and must not leak to
//      nodes outside the tabgroup branch.
// The derivation is inlined inside liteNode (no helper calls) precisely so
// this single-function extraction keeps working.
//
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

// ── (f) non-tab, non-tabgroup node with a stray groupSnapshot → none ─────────
// (Window Groups and windows never carry group fields. The tabgroup node is
// the deliberate exception — cases (i)+ below.)
check('(f) non-tab node with a stray groupSnapshot emits none of the group fields', () => {
    const node = {
        id: 'w1', type: 'window', title: 'Window',
        groupSnapshot: { groupId: 7, title: 'Work', color: 'blue' },
        children: [],
    };
    const out = liteNode(node, 'tree', null, {});
    assertAbsent(out, GROUP_KEYS, 'group mapping is tab-only outside tabgroup nodes');
});

check('(f2) a Window Group node (type=group) emits no group fields', () => {
    const node = { id: 'g1', type: 'group', title: 'Research', color: 'blue', chromeGroupId: 7, children: [] };
    const out = liteNode(node, 'tree', null, {});
    assertAbsent(out, GROUP_KEYS, 'type=group is a Window Group, not a browser Tab Group');
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

// ═══ CONTAINMENT WORLD (N5): tabgroup container nodes ═══════════════════════

// A live tabgroup node holding: a live member, a ghost member, and a tab
// nested UNDER a live member (also a member — DFS descendants all inherit).
function liveTabGroupFixture() {
    return {
        id: 'tg1', type: 'tabgroup', title: 'Work', color: 'blue',
        chromeGroupId: 7,
        children: [
            { id: 'm1', type: 'tab', title: 'Docs', url: 'https://example.com/', chromeId: 100,
              children: [
                  { id: 'm1a', type: 'tab', title: 'Nested', url: 'https://example.com/n', chromeId: 101 },
              ] },
            { id: 'm2', type: 'tab', title: 'Closed', chromeId: null },
        ],
    };
}

// ── (h) tabgroup node itself → chromeGroupId + Color, NO chromeGroupTitle ────
check('(h) tabgroup node emits chromeGroupId + chromeGroupColor, no chromeGroupTitle', () => {
    const out = liteNode(liveTabGroupFixture(), 'tree', null, {});
    assertEq(out.type, 'tabgroup', 'type passes through verbatim');
    assertEq(out.title, 'Work', 'title is the group name');
    assertEq(out.chromeGroupId, 7, 'chromeGroupId');
    assertEq(out.chromeGroupColor, 'blue', 'chromeGroupColor');
    assertAbsent(out, ['chromeGroupTitle'], 'title already carries the group name');
});

// ── (i) live member derives all three fields from the ancestor ───────────────
check('(i) live member tab (no groupSnapshot) derives all three fields from the tabgroup ancestor', () => {
    const fixture = liveTabGroupFixture();
    assertAbsent(fixture.children[0], ['groupSnapshot'], 'fixture sanity: member carries no snapshot');
    const out = liteNode(fixture, 'tree', null, {});
    const m1 = out.children[0];
    assertEq(m1.chromeGroupId, 7, 'chromeGroupId');
    assertEq(m1.chromeGroupTitle, 'Work', 'chromeGroupTitle');
    assertEq(m1.chromeGroupColor, 'blue', 'chromeGroupColor');
});

// ── (j) inheritance reaches nested tabs at any depth ─────────────────────────
check('(j) tab nested under a member inherits the group fields too', () => {
    const out = liteNode(liveTabGroupFixture(), 'tree', null, {});
    const nested = out.children[0].children[0];
    assertEq(nested.chromeGroupId, 7, 'chromeGroupId at depth 2');
    assertEq(nested.chromeGroupTitle, 'Work', 'chromeGroupTitle at depth 2');
    assertEq(nested.chromeGroupColor, 'blue', 'chromeGroupColor at depth 2');
});

// ── (k) ghost member: same suppression rule as snapshot world ────────────────
check('(k) ghost member keeps title+color, suppresses the live chromeGroupId', () => {
    const out = liteNode(liveTabGroupFixture(), 'tree', null, {});
    const m2 = out.children[1];
    assertEq(m2.ghost, true, 'ghost flag');
    assertAbsent(m2, ['chromeGroupId'], 'ghost suppresses the live id');
    assertEq(m2.chromeGroupTitle, 'Work', 'chromeGroupTitle');
    assertEq(m2.chromeGroupColor, 'blue', 'chromeGroupColor');
});

// ── (l) library clone (chromeGroupId null) → title+color only, everywhere ────
check('(l) library-clone tabgroup (chromeGroupId null) emits color only; members get title+color', () => {
    const node = {
        id: 'tg2', type: 'tabgroup', title: 'Work', color: 'blue', chromeGroupId: null,
        children: [{ id: 'm3', type: 'tab', title: 'Docs', chromeId: null }],
    };
    const out = liteNode(node, 'library', 'lib-1', {});
    assertAbsent(out, ['chromeGroupId'], 'null gid emits no id on the node');
    assertEq(out.chromeGroupColor, 'blue', 'node chromeGroupColor');
    const m3 = out.children[0];
    assertAbsent(m3, ['chromeGroupId'], 'null gid emits no id on members');
    assertEq(m3.chromeGroupTitle, 'Work', 'member chromeGroupTitle');
    assertEq(m3.chromeGroupColor, 'blue', 'member chromeGroupColor');
});

// ── (m) the ancestor stamp must not leak to siblings outside the branch ──────
check('(m) tabgroup identity does not leak to tabs outside the branch', () => {
    const win = {
        id: 'w2', type: 'window', title: 'Window', children: [
            liveTabGroupFixture(),
            { id: 'loose', type: 'tab', title: 'Ungrouped', url: 'https://x.test/', chromeId: 200 },
        ],
    };
    const out = liteNode(win, 'tree', null, {});
    assertEq(out.children[0].children[0].chromeGroupId, 7, 'in-branch member still derives');
    assertAbsent(out.children[1], GROUP_KEYS, 'sibling after the tabgroup stays clean');
});

// ── (n) ancestor wins over a stale per-tab groupSnapshot ────────────────────
check('(n) tabgroup ancestor overrides a member stale groupSnapshot', () => {
    const node = {
        id: 'tg3', type: 'tabgroup', title: 'Work', color: 'blue', chromeGroupId: 7,
        children: [{ id: 'm4', type: 'tab', title: 'Docs', chromeId: 100,
                     groupSnapshot: { groupId: 99, title: 'Stale', color: 'red' } }],
    };
    const out = liteNode(node, 'tree', null, {});
    const m4 = out.children[0];
    assertEq(m4.chromeGroupId, 7, 'containment id wins');
    assertEq(m4.chromeGroupTitle, 'Work', 'containment title wins');
    assertEq(m4.chromeGroupColor, 'blue', 'containment color wins');
});

// ── (o) minimal:true suppresses the containment fields too ──────────────────
check('(o) minimal:true suppresses group fields on both the tabgroup node and its members', () => {
    const out = liteNode(liveTabGroupFixture(), 'tree', null, { minimal: true });
    assertAbsent(out, GROUP_KEYS, 'tabgroup node in minimal mode');
    assertAbsent(out.children[0], GROUP_KEYS, 'member in minimal mode');
});

// ── (p) include_chrome_tab_groups:false suppresses the containment fields ────
check('(p) include_chrome_tab_groups:false suppresses group fields in the containment world', () => {
    const out = liteNode(liveTabGroupFixture(), 'tree', null, { include_chrome_tab_groups: false });
    assertAbsent(out, GROUP_KEYS, 'tabgroup node with the flag off');
    assertAbsent(out.children[0], GROUP_KEYS, 'member with the flag off');
});

// ── (q) untitled group ('' title is legal) → no chromeGroupTitle ─────────────
check('(q) untitled tabgroup emits id+color, and members get id+color but no title', () => {
    const node = {
        id: 'tg4', type: 'tabgroup', title: '', color: 'grey', chromeGroupId: 12,
        children: [{ id: 'm5', type: 'tab', title: 'Docs', chromeId: 100 }],
    };
    const out = liteNode(node, 'tree', null, {});
    assertEq(out.chromeGroupId, 12, 'node chromeGroupId');
    assertEq(out.chromeGroupColor, 'grey', 'node chromeGroupColor');
    const m5 = out.children[0];
    assertEq(m5.chromeGroupId, 12, 'member chromeGroupId');
    assertAbsent(m5, ['chromeGroupTitle'], 'empty group title emits no field');
    assertEq(m5.chromeGroupColor, 'grey', 'member chromeGroupColor');
});

// ═══ search_tabs flat hits carry the same stamp (N5 regression guard) ═══════
//
// searchInTree pushes DETACHED copies, so liteNode's own children-recursion
// inheritance can't reach them; the walk records an index-parallel `stamps`
// array that the search_tabs handler folds into opts._tgAncestor. This was a
// real miss caught in review — get_tree emitted the fields while an
// equivalent search_tabs hit silently emitted none. `sanitizeNode` is stubbed
// (shallow copy) since only the stamp threading is under test here.
const SEARCH_SIG = 'function searchInTree(nodes, query, includeGhost, results = [], stamps = [], tgAncestor = null)';
const searchSrc = extractFunction(hostSrc, SEARCH_SIG);
check('(r) searchInTree records a tabgroup stamp per hit, and only for in-branch hits', () => {
    if (!searchSrc) throw new Error('could not locate searchInTree() in host.js — signature may have changed:\n  ' + SEARCH_SIG);
    const searchInTree = new Function(
        'sanitizeNode',
        searchSrc + '\nreturn searchInTree;'
    )(n => ({ ...n }));

    const tree = [{
        id: 'w', type: 'window', title: 'Win', children: [
            { id: 'tg', type: 'tabgroup', title: 'Work', color: 'blue', chromeGroupId: 7, children: [
                { id: 'm1', type: 'tab', title: 'Docs alpha', url: 'https://e.test/1', chromeId: 100,
                  children: [{ id: 'm1a', type: 'tab', title: 'Docs nested', url: 'https://e.test/2', chromeId: 101 }] },
            ] },
            { id: 'loose', type: 'tab', title: 'Docs loose', url: 'https://e.test/3', chromeId: 102 },
        ],
    }];
    const stamps = [];
    const results = searchInTree(tree, 'Docs', true, [], stamps);
    assertEq(results.length, 3, 'hit count');
    assertEq(stamps.length, 3, 'stamps stay index-parallel to results');

    const byId = Object.fromEntries(results.map((r, i) => [r.id, stamps[i]]));
    assertEq(byId.m1?.groupId, 7, 'member stamp groupId');
    assertEq(byId.m1?.title, 'Work', 'member stamp title');
    assertEq(byId.m1?.color, 'blue', 'member stamp color');
    assertEq(byId.m1a?.groupId, 7, 'nested member inherits the stamp');
    assertEq(byId.loose, null, 'out-of-branch hit carries no stamp');

    // And the stamp, folded into opts the way the handler does, reproduces the
    // exact field set a nested get_tree read would emit.
    const memberHit = results.find(r => r.id === 'm1');
    const shaped = liteNode(memberHit, 'tree', null, { _tgAncestor: byId.m1 });
    assertEq(shaped.chromeGroupId, 7, 'shaped hit chromeGroupId');
    assertEq(shaped.chromeGroupTitle, 'Work', 'shaped hit chromeGroupTitle');
    assertEq(shaped.chromeGroupColor, 'blue', 'shaped hit chromeGroupColor');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
