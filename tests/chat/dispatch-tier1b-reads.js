// Tier 1b — chat-tool dispatch integration test (READS only).
//
// Validates the native chat surface's IPC contract end-to-end against a
// real running Pinako extension:
//
//     SW (sender)
//       → `chrome.runtime.sendMessage({action:'pinakoExecuteChatTool',...})`
//       → popup receives, dispatches to `_executeChatTool*` helper
//       → popup broadcasts `{action:'chatToolResult', requestId, result}`
//       → SW (sender) receives the broadcast, resolves the Promise.
//
// `chrome.runtime.sendMessage` does NOT deliver back to the sender, so the
// test runner cannot live in the popup itself — it must run in another
// extension context (here: the service worker).
//
// How to invoke (via chrome-devtools-mcp):
//   1. List pages: `mcp__chrome-devtools__list_pages`
//   2. If no Extension Pages line for `pinako.html`, trigger the action:
//      `mcp__chrome-devtools__trigger_extension_action` with the Pinako
//      extension id.
//   3. If no Service Worker line, wake it: select page = pinako.html, then
//      evaluate `chrome.runtime.sendMessage({action:'__wake_sw'})`. Re-list.
//   4. evaluate_script with `serviceWorkerId: <sw-id>` and `function:`
//      = the contents of this file's `runTier1bReads` definition followed
//      by `runTier1bReads()` (or paste the whole file body wrapped as a
//      single async IIFE — see runbook.md).
//
// Returns: `{passed, failed, results: [{name, ok, error?, sample?}]}`.
//
// No state mutation: every tool exercised here is a read. Cleanup
// not required; safe to run against the user's real data (any browser
// profile with the extension installed).
//
// Phase 1, Tier 1b. Phase 4.4-B native chat surface, commit 2-3 read
// catalog. Pairs with `Pinako/tests/mutation-engine.smoke.js` (Tier 0)
// for the no-LLM baseline.

async function runTier1bReads() {
    const TIMEOUT_MS = 5000;
    const results = [];
    let passed = 0;
    let failed = 0;

    function makeRequestId(suffix) {
        return `tier1b-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    // Send a `pinakoExecuteChatTool` message and wait for the matching
    // `chatToolResult` broadcast. Caller passes a unique suffix for the
    // requestId so concurrent runs don't collide.
    function dispatch(toolName, toolInput, suffix) {
        return new Promise((resolve) => {
            const requestId = makeRequestId(suffix || toolName);
            const toolCallId = `call-${requestId}`;
            let settled = false;
            function listener(msg) {
                if (msg?.action === 'chatToolResult' && msg.requestId === requestId) {
                    settled = true;
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(msg.result);
                }
            }
            chrome.runtime.onMessage.addListener(listener);
            chrome.runtime.sendMessage({
                action: 'pinakoExecuteChatTool',
                requestId, toolCallId, toolName,
                toolInput: toolInput || {},
            }).catch((e) => {
                // The popup is fine; the sender's own send-error is harmless.
                // Don't resolve here — wait for the broadcast.
            });
            setTimeout(() => {
                if (!settled) {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve({ ok: false, error: { code: 'TEST_TIMEOUT', message: `no chatToolResult within ${TIMEOUT_MS}ms` } });
                }
            }, TIMEOUT_MS);
        });
    }

    async function check(name, fn) {
        try {
            const sample = await fn();
            passed++;
            results.push({ name, ok: true, sample });
        } catch (e) {
            failed++;
            results.push({ name, ok: false, error: String(e?.message || e) });
        }
    }

    function expect(actual, predicate, label) {
        if (!predicate(actual)) {
            throw new Error(`${label}: predicate failed; actual=${JSON.stringify(actual).slice(0, 300)}`);
        }
    }

    // Compact preview for the results blob (full envelopes balloon the
    // chrome-devtools-mcp JSON serialization budget).
    function preview(r) {
        if (!r || typeof r !== 'object') return r;
        const out = { ok: r.ok };
        if (r.ok === false && r.error) out.error = r.error;
        if (r.count != null) out.count = r.count;
        if (Array.isArray(r.results)) out.resultsLength = r.results.length;
        if (Array.isArray(r.tree)) out.treeLength = r.tree.length;
        if (Array.isArray(r.libraries)) out.librariesLength = r.libraries.length;
        if (Array.isArray(r.notes)) out.notesLength = r.notes.length;
        if (Array.isArray(r.mainTreeNotes)) out.mainTreeNotesLength = r.mainTreeNotes.length;
        if (Array.isArray(r.duplicateGroups)) out.duplicateGroupsLength = r.duplicateGroups.length;
        if (r.counts) out.counts = r.counts;
        if (r.truncated != null) out.truncated = r.truncated;
        return out;
    }

    // ─── 10 read tools ─────────────────────────────────────────────────────

    await check('get_tree returns ok envelope with tree array', async () => {
        const r = await dispatch('get_tree', {});
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => Array.isArray(x?.tree), 'tree is array');
        return preview(r);
    });

    await check('get_tree_summary returns counts + depth + topDomains', async () => {
        const r = await dispatch('get_tree_summary', {});
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => typeof x?.counts?.nodes === 'number', 'counts.nodes is number');
        expect(r, x => x?.depth?.max != null, 'depth.max present');
        expect(r, x => Array.isArray(x?.topDomains), 'topDomains is array');
        return preview(r);
    });

    await check('list_libraries returns libraries array', async () => {
        const r = await dispatch('list_libraries', {});
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => Array.isArray(x?.libraries), 'libraries is array');
        return preview(r);
    });

    await check('get_main_tree_notes returns mainTreeNotes array', async () => {
        // Native chat envelope uses `mainTreeNotes` key (not `notes`). The
        // internal scope is still 'main-tree-notes' but the response field
        // is `mainTreeNotes` per pinako.js `_executeChatToolGetMainTreeNotes`.
        const r = await dispatch('get_main_tree_notes', {});
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => Array.isArray(x?.mainTreeNotes), 'mainTreeNotes is array');
        return preview(r);
    });

    await check('get_bookmarks returns ok envelope', async () => {
        const r = await dispatch('get_bookmarks', {});
        expect(r, x => x?.ok === true, 'ok=true');
        return preview(r);
    });

    await check('search_tabs returns results array', async () => {
        const r = await dispatch('search_tabs', { query: 'http' });
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => Array.isArray(x?.results), 'results is array');
        return preview(r);
    });

    await check('find_duplicates with scope=tree returns ok envelope', async () => {
        // `scope` is required (not optional). Valid values: tree | bookmarks
        // | library | cross-scope. Empty input rejects with INVALID_SCOPE.
        const r = await dispatch('find_duplicates', { scope: 'tree' });
        expect(r, x => x?.ok === true, 'ok=true');
        return preview(r);
    });

    await check('find_duplicates without scope rejects with INVALID_SCOPE', async () => {
        const r = await dispatch('find_duplicates', {});
        expect(r, x => x?.ok === false, 'ok=false');
        expect(r, x => x?.error?.code === 'INVALID_SCOPE', 'INVALID_SCOPE code');
        return preview(r);
    });

    await check('search_pinako tree scope returns ok + results array', async () => {
        const r = await dispatch('search_pinako', { query: 'pinako', scope: 'tree' });
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => Array.isArray(x?.results), 'results is array');
        return preview(r);
    });

    await check('search_pinako empty query rejects with EMPTY_QUERY', async () => {
        const r = await dispatch('search_pinako', { query: '' });
        expect(r, x => x?.ok === false, 'ok=false');
        expect(r, x => x?.error?.code === 'EMPTY_QUERY', 'EMPTY_QUERY code');
        return preview(r);
    });

    await check('search_pinako library scope without library_id rejects with LIBRARY_ID_REQUIRED', async () => {
        const r = await dispatch('search_pinako', { query: 'x', scope: 'library' });
        expect(r, x => x?.ok === false, 'ok=false');
        expect(r, x => x?.error?.code === 'LIBRARY_ID_REQUIRED', 'LIBRARY_ID_REQUIRED code');
        return preview(r);
    });

    await check('search_pinako library scope with bogus library_id rejects', async () => {
        const r = await dispatch('search_pinako', { query: 'x', scope: 'library', library_id: 'definitely-not-a-real-id' });
        expect(r, x => x?.ok === false, 'ok=false');
        expect(r, x => x?.error?.code === 'LIBRARY_NOT_FOUND', 'LIBRARY_NOT_FOUND code');
        return preview(r);
    });

    await check('get_library unknown id returns error envelope', async () => {
        const r = await dispatch('get_library', { library_id: 'definitely-not-a-real-id' });
        expect(r, x => x?.ok === false, 'ok=false');
        return preview(r);
    });

    await check('search_docs returns envelope with ok boolean (either polarity)', async () => {
        const r = await dispatch('search_docs', { query: 'getting started' });
        expect(r, x => typeof x?.ok === 'boolean', 'envelope has ok flag');
        return preview(r);
    });

    // ─── Negative dispatcher paths ─────────────────────────────────────────

    await check('unknown tool returns UNKNOWN_TOOL error envelope', async () => {
        const r = await dispatch('this_tool_does_not_exist', {});
        expect(r, x => x?.ok === false, 'ok=false');
        expect(r, x => x?.error?.code === 'UNKNOWN_TOOL', 'UNKNOWN_TOOL code');
        return preview(r);
    });

    return { passed, failed, results };
}
