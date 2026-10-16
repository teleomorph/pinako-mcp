// find_duplicates incognito smoke harness.
// Run with: node tests/find-duplicates-incognito.smoke.js   (from pinako-mcp/)
//
// Guards the privacy filter in host.js _findDuplicateUrls and
// _findDuplicateUrlsCrossScope (2026-10-16). The extension sends incognito rows
// to the Bridge on purpose and expects the Bridge to hide them from agents
// (getTree and the other readers do). The duplicate scans walk the raw cached
// tree, so each walk must skip an incognito node together with its subtree, or
// a duplicate set names an incognito tab's URL, title, id and parent path.
//
// Both scans are self-contained pure functions, so their exact source is sliced
// out of host.js (host.js is an ESM native-messaging host with load-time side
// effects and cannot be imported) and evaluated in isolation, the same way
// lite-node-chrome-groups.smoke.js does for liteNode.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = path.join(__dirname, '..', 'host.js');

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
const sigs = ['function _findDuplicateUrls(tree)', 'function _findDuplicateUrlsCrossScope(scopedTrees)'];
const bodies = sigs.map(s => extractFunction(hostSrc, s));
if (bodies.some(b => !b)) {
    console.error('FAIL: could not locate the duplicate scans in host.js — signatures may have changed');
    process.exit(1);
}
const { _findDuplicateUrls, _findDuplicateUrlsCrossScope } =
    new Function(bodies.join('\n') + '\nreturn { _findDuplicateUrls, _findDuplicateUrlsCrossScope };')();

let passed = 0;
let failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (e) { failed++; console.error(`✗ ${name}\n    ${e.message}`); }
}
function assert(cond, label) { if (!cond) throw new Error(label); }
const leaks = (r) => JSON.stringify(r).match(/only-incognito|Secret|Private window|"d[456]"|"dw2"|"i[12]"/i);

// d1 (normal) shares a URL with d4 (incognito); d5+d6 duplicate each other only
// inside incognito; d2+d3 are a plain pair that must still be reported.
const tree = [
    { id: 'dw1', type: 'window', title: 'Work', children: [
        { id: 'd1', type: 'tab', title: 'Shared page', url: 'https://dup.example/shared', chromeId: 11 },
        { id: 'd2', type: 'tab', title: 'Plain A', url: 'https://dup.example/plain', chromeId: 12 },
        { id: 'd3', type: 'tab', title: 'Plain B', url: 'https://dup.example/plain', chromeId: 13 },
    ] },
    { id: 'dw2', type: 'window', title: 'Private window', incognito: true, children: [
        { id: 'd4', type: 'tab', title: 'Shared (private)', url: 'https://dup.example/shared', chromeId: 14, incognito: true },
        { id: 'd5', type: 'tab', title: 'Secret A', url: 'https://only-incognito.example/z', chromeId: 15, incognito: true },
        { id: 'd6', type: 'tab', title: 'Secret B', url: 'https://only-incognito.example/z', chromeId: 16, incognito: true },
    ] },
];
// A library clone that kept the incognito flag (the extension keeps it on purpose).
const library = [
    { id: 'l1', type: 'link', title: 'Shared page', url: 'https://dup.example/shared' },
    { id: 'i1', type: 'link', title: 'Secret clone A', url: 'https://only-incognito.example/z', incognito: true },
    { id: 'i2', type: 'link', title: 'Secret clone B', url: 'https://only-incognito.example/z', incognito: true },
];

check('single-scope scan: the plain pair stays, no incognito row appears', () => {
    const r = _findDuplicateUrls(tree);
    assert(r.duplicateSets.length === 1 && r.duplicateSets[0].url === 'https://dup.example/plain', JSON.stringify(r));
    assert(!leaks(r), 'incognito data leaked: ' + JSON.stringify(r));
    assert(r.totalScannedWithUrl === 3, 'incognito rows must not be counted: ' + r.totalScannedWithUrl);
});

check('single-scope scan: a library clone that kept the incognito flag is skipped', () => {
    const r = _findDuplicateUrls(library);
    assert(r.duplicateSets.length === 0 && !leaks(r), JSON.stringify(r));
});

check('cross-scope scan: shared URL pairs tree+library only, never the incognito copy', () => {
    const r = _findDuplicateUrlsCrossScope([
        { tree, sourceScope: 'tree', sourceLibraryId: null },
        { tree: library, sourceScope: 'library', sourceLibraryId: 'lib1' },
    ]);
    const shared = r.duplicateSets.find(x => x.url === 'https://dup.example/shared');
    assert(shared && shared.count === 2 && shared.nodeIds.join() === 'd1,l1', JSON.stringify(r));
    assert(!leaks(r), 'incognito data leaked: ' + JSON.stringify(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
