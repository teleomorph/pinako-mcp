// Incognito readers smoke harness.
// Run with: node tests/incognito-readers.smoke.js   (from pinako-mcp/)
//
// Guards the privacy filter added 2026-10-18. The extension pushes its whole
// in-memory tree and libraries to the Bridge, incognito rows included, and
// relies on the Bridge to keep them from agents. Four readers handed out raw
// cached nodes: the pinako://tree and pinako://libraries resources, get_library
// and list_libraries (tabCount and include_tabs). They now go through
// _withoutIncognito / _libraryWithoutIncognito first.
//
// The two helpers are pure, so their exact source is sliced out of host.js
// (host.js binds a port and reads stdin on load, so it cannot be imported) and
// run in isolation, as lite-node-chrome-groups.smoke.js does. The readers live
// inside the server setup and cannot be sliced, so the last check only confirms
// each one routes through a helper.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8').replace(/\r\n/g, '\n');

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

const bodies = ['function _withoutIncognito(nodes)', 'function _libraryWithoutIncognito(lib)'].map(s => extractFunction(hostSrc, s));
if (bodies.some(b => !b)) {
    console.error('FAIL: could not locate _withoutIncognito / _libraryWithoutIncognito in host.js');
    process.exit(1);
}
const { _withoutIncognito, _libraryWithoutIncognito } =
    new Function(bodies.join('\n') + '\nreturn { _withoutIncognito, _libraryWithoutIncognito };')();

let passed = 0;
let failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (e) { failed++; console.error(`✗ ${name}\n    ${e.message}`); }
}
function assert(cond, label) { if (!cond) throw new Error(label); }
const leaks = (x) => /secret|"w2"|"t[34]"|"i[12]"/i.test(JSON.stringify(x));

const tree = [
    { id: 'w1', type: 'window', title: 'Work', children: [
        { id: 't1', type: 'tab', title: 'Docs', url: 'https://example.com/', chromeId: 1, favIconUrl: 'data:x', memo: 'keep me' },
        // Defensive: a flagged row below the root is dropped too.
        { id: 't4', type: 'tab', title: 'Secret nested', url: 'https://secret.example/n', chromeId: 4, incognito: true },
    ] },
    { id: 'w2', type: 'window', title: 'Private', incognito: true, children: [
        { id: 't3', type: 'tab', title: 'Secret', url: 'https://secret.example/x', chromeId: 3, incognito: true },
    ] },
];
const library = {
    id: 'lib1', title: 'Reading', description: 'd', notes: [{ id: 'n1', title: 'Note' }],
    children: [
        { id: 'l1', type: 'tab', title: 'Article', url: 'https://example.com/a', chromeId: null },
        { id: 'i1', type: 'tab', title: 'Secret clone', url: 'https://secret.example/c', chromeId: null, incognito: true },
        { id: 'f1', type: 'library-folder', title: 'Folder', children: [
            { id: 'i2', type: 'tab', title: 'Secret clone 2', url: 'https://secret.example/d', chromeId: null, incognito: true },
        ] },
    ],
};

check('tree: incognito window, its tabs and a nested flagged tab are dropped', () => {
    const before = JSON.stringify(tree);
    const out = _withoutIncognito(tree);
    assert(!leaks(out), 'incognito data leaked: ' + JSON.stringify(out));
    assert(out.length === 1 && out[0].children.length === 1 && out[0].children[0].id === 't1', JSON.stringify(out));
    assert(JSON.stringify(out[0].children[0]) === JSON.stringify(tree[0].children[0]), 'a normal row must stay exactly as cached');
    assert(JSON.stringify(tree) === before, 'the cached tree must not be mutated');
});

check('library: legacy incognito clones are dropped at any depth, the rest kept', () => {
    const out = _libraryWithoutIncognito(library);
    assert(!leaks(out), 'incognito data leaked: ' + JSON.stringify(out));
    assert(out.id === 'lib1' && out.notes.length === 1 && out.children.length === 2, JSON.stringify(out));
    assert(out.children[1].children.length === 0, 'folder keeps no flagged child');
    assert(library.children.length === 3, 'the cached library must not be mutated');
    assert(_libraryWithoutIncognito(undefined) === undefined, 'a missing library stays missing (Library not found path)');
});

check('every raw reader routes through the filter', () => {
    const wants = [
        ['pinako://tree resource', 'tree:      _withoutIncognito(r.data.tree || []),'],
        ['pinako://libraries resource', 'libraries:   (r.data.libraries || []).map(_libraryWithoutIncognito),'],
        ['list_libraries', 'const libs = (r.data.libraries || []).map(_libraryWithoutIncognito).map(lib => {'],
        ['get_library', 'const lib = _libraryWithoutIncognito((r.data.libraries || []).find(l => l.id === library_id));'],
    ];
    const missing = wants.filter(([, code]) => !hostSrc.includes(code)).map(([name]) => name);
    assert(missing.length === 0, 'not filtered: ' + missing.join(', '));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
