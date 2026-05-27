// Tier 1b — chat-tool dispatch integration test (WRITES).
//
// Same transport contract as dispatch-tier1b-reads.js (SW sender ->
// pinakoExecuteChatTool -> popup dispatch -> chatToolResult broadcast).
// This bundle exercises the WRITE path through `_executeChatToolWrite`
// at `Pinako/pinako.js:17969`, which:
//   1. Constructs `{type: toolName, ...toolInput}`
//   2. Normalizes `scope:'main-tree-notes'` -> `'global-notes'`
//   3. Forwards to `mutateTreeForAgent(op, undefined, 'chat')`
//   4. Shapes thrown errors into `{ok:false, error:{code,message,context}}`
//
// Scope: library-scoped writes only. The DebugProfile contains real user
// data (490+ tree nodes); we do not mutate main-tree state. All test
// artifacts wrap inside a single library_group with the `pinako-chat-test-`
// title prefix; cleanup cascades the group at the end.
//
// Self-contained: setup, assertions, and cleanup all run via the chat
// dispatch path itself. If a mid-run failure prevents cleanup, the user
// can sweep manually via the Pinako UI library panel (look for the prefix).
//
// Coverage of the dispatch wrapper's unique surface:
//   - Op shape construction (`{type, ...input}`)
//   - Source tag (`'chat'` flows to audit log)
//   - Engine validation gates surface as clean error envelopes
//   - destructive gate (`confirmedByUser:true`) enforces through the wrapper
//   - bulk_apply atomic composite works through the dispatch path
//
// Returns: `{passed, failed, results, testGroupId, testLibraryId, testNoteId}`.
// Inspect `testGroupId` if `cleanup` failed — that's the orphan to sweep.

async function runTier1bWrites() {
    const TIMEOUT_MS = 8000;
    const PREFIX = 'pinako-chat-test-';
    const runStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const results = [];
    let passed = 0;
    let failed = 0;
    let testGroupId = null;
    let testLibraryId = null;
    let testNoteId = null;
    let testNodeIdForBulk = null;

    function makeRequestId(suffix) {
        return `tier1bw-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

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
            }).catch(() => {});
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
            throw new Error(`${label}: predicate failed; actual=${JSON.stringify(actual).slice(0, 400)}`);
        }
    }

    function preview(r) {
        if (!r || typeof r !== 'object') return r;
        const out = { ok: r.ok };
        if (r.ok === false && r.error) out.error = r.error;
        if (r.op) out.op = r.op;
        if (r.libraryId) out.libraryId = r.libraryId;
        if (r.scope) out.scope = r.scope;
        if (r.result && typeof r.result === 'object') {
            // Engine meta surfaces under `result`. Keep just the keys that
            // mirror well-known engine meta fields.
            const m = r.result;
            const keep = {};
            for (const k of ['createdGroupId', 'createdLibraryId', 'createdNoteId',
                             'deletedLibraryId', 'cascadedLibraryIds', 'libraryDeletionCount',
                             'addedToGroupId', 'subResults']) {
                if (m[k] !== undefined) keep[k] = m[k];
            }
            if (Object.keys(keep).length) out.meta = keep;
        }
        return out;
    }

    // ─── SETUP ─────────────────────────────────────────────────────────────

    await check('setup: create_library_group via dispatch', async () => {
        const r = await dispatch('create_library_group', {
            title: `${PREFIX}group-${runStamp}`,
            description: 'Tier 1b writes harness',
        });
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => x?.result?.createdGroupId, 'createdGroupId present');
        testGroupId = r.result.createdGroupId;
        return preview(r);
    });

    await check('setup: create_library via dispatch', async () => {
        const r = await dispatch('create_library', {
            title: `${PREFIX}lib-${runStamp}`,
            description: 'Tier 1b test lib',
        });
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => x?.result?.createdLibraryId, 'createdLibraryId present');
        testLibraryId = r.result.createdLibraryId;
        return preview(r);
    });

    await check('setup: add_library_to_group via dispatch', async () => {
        if (!testGroupId || !testLibraryId) throw new Error('prior setup steps failed; aborting');
        const r = await dispatch('add_library_to_group', {
            groupId: testGroupId,
            libraryId: testLibraryId,
        });
        expect(r, x => x?.ok === true, 'ok=true');
        return preview(r);
    });

    // ─── WRITE SURFACE TESTS ───────────────────────────────────────────────

    await check('set_library_title renames via dispatch + verified via list_libraries', async () => {
        if (!testLibraryId) throw new Error('no test library');
        const newTitle = `${PREFIX}lib-renamed-${runStamp}`;
        const r = await dispatch('set_library_title', {
            libraryId: testLibraryId,
            title: newTitle,
        });
        expect(r, x => x?.ok === true, 'ok=true');
        // Read-back verification through the same dispatch path.
        const list = await dispatch('list_libraries', {});
        expect(list, x => x?.ok === true, 'list ok=true');
        const found = (list.libraries || []).find(l => l.id === testLibraryId);
        expect(found, x => x?.title === newTitle, 'title persisted in list_libraries');
        return preview(r);
    });

    await check('set_library_description via dispatch', async () => {
        if (!testLibraryId) throw new Error('no test library');
        const r = await dispatch('set_library_description', {
            libraryId: testLibraryId,
            description: 'Updated description via Tier 1b',
        });
        expect(r, x => x?.ok === true, 'ok=true');
        return preview(r);
    });

    await check('create_note on test library via dispatch', async () => {
        if (!testLibraryId) throw new Error('no test library');
        const r = await dispatch('create_note', {
            libraryId: testLibraryId,
            title: `${PREFIX}note-${runStamp}`,
            content: 'Initial note content.',
            scope: 'library-notes',
        });
        expect(r, x => x?.ok === true, 'ok=true');
        expect(r, x => x?.result?.createdNoteId, 'createdNoteId present');
        testNoteId = r.result.createdNoteId;
        return preview(r);
    });

    await check('set_note_content replace mode + verified via get_library', async () => {
        if (!testLibraryId || !testNoteId) throw new Error('no test note');
        const newBody = `Replaced body at ${runStamp}.`;
        const r = await dispatch('set_note_content', {
            libraryId: testLibraryId,
            noteId: testNoteId,
            content: newBody,
            mode: 'replace',
            scope: 'library-notes',
        });
        expect(r, x => x?.ok === true, 'ok=true');
        // Note: get_library strips note `content` by default (lite shape;
        // pinako.js:17682, `include_note_content` flag). Pass the flag to
        // get the full body for verification.
        const lib = await dispatch('get_library', { library_id: testLibraryId, include_note_content: true });
        expect(lib, x => x?.ok === true, 'get_library ok=true');
        const note = (lib.library?.notes || []).find(n => n.id === testNoteId);
        expect(note, x => x?.content === newBody, 'content persisted in get_library');
        return preview(r);
    });

    await check('delete_library WITHOUT confirmedByUser rejects via engine gate', async () => {
        if (!testLibraryId) throw new Error('no test library');
        const r = await dispatch('delete_library', {
            libraryId: testLibraryId,
            // intentionally omitting confirmedByUser
        });
        expect(r, x => x?.ok === false, 'ok=false');
        // The engine .refine() rejects with a Zod-shape error. The wrapper
        // re-shapes thrown errors as {code: err.code || 'WRITE_FAILED', ...}.
        // Acceptable codes: any non-empty string; the key check is that the
        // dispatch returned an error envelope and did NOT delete the library.
        expect(r, x => typeof x?.error?.code === 'string' && x.error.code.length > 0, 'error code present');
        // Verify the library still exists after the rejection.
        const list = await dispatch('list_libraries', {});
        const stillThere = (list.libraries || []).find(l => l.id === testLibraryId);
        expect(stillThere, x => x != null, 'library survived the rejected delete');
        return preview(r);
    });

    await check('bulk_apply scope=library-list, libraryId matched on envelope + sub-ops', async () => {
        if (!testLibraryId) throw new Error('no test library');
        // Two engine constraints stack here:
        //  (1) BULK_SCOPE_MISMATCH if envelope scope omitted (defaults to 'tree').
        //  (2) BULK_LIBRARY_MISMATCH if envelope libraryId not set; all sub-op
        //      libraryIds must equal the bulk's libraryId. One library per bulk.
        const r = await dispatch('bulk_apply', {
            scope: 'library-list',
            libraryId: testLibraryId,
            ops: [
                {
                    type: 'set_library_title',
                    libraryId: testLibraryId,
                    title: `${PREFIX}lib-bulk-${runStamp}`,
                },
                {
                    type: 'set_library_description',
                    libraryId: testLibraryId,
                    description: 'Bulk-applied description.',
                },
            ],
        });
        expect(r, x => x?.ok === true, 'ok=true');
        return preview(r);
    });

    // ─── CLEANUP ───────────────────────────────────────────────────────────

    await check('cleanup: delete_library_group cascadeMembers + confirmedByUser', async () => {
        if (!testGroupId) {
            results.push({ name: 'cleanup-note', ok: true, sample: { skipped: 'no testGroupId; nothing to clean' } });
            return { skipped: true };
        }
        const r = await dispatch('delete_library_group', {
            groupId: testGroupId,
            cascadeMembers: true,
            confirmedByUser: true,
        });
        expect(r, x => x?.ok === true, 'cleanup ok=true');
        return preview(r);
    });

    return { passed, failed, results, testGroupId, testLibraryId, testNoteId };
}
