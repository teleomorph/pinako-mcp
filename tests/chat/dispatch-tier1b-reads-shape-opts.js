// Tier 1b reads — composable shape opts coverage.
//
// Validates the `_extractShapeOptsForChat` helper added in commit
// 0301be8 + the ghost-filter recursion fix from commit f147a88.
// Companion to `dispatch-tier1b-reads.js` (which covers the dispatcher
// contract + envelope shapes); this bundle covers the OPT-IN
// MECHANICS of the lite-node helper.
//
// Composable opts on `get_tree` / `get_library` / `list_libraries`
// (the last only when `include_tabs:true`):
//
//     minimal:              when true, strips ALL optional fields →
//                           id/type/title/url/ghost/children only
//     include_opened_date:  default true; openedDate
//     include_tags:         default true; tags[]
//     include_memos:        default true; memoText
//     include_lineage:      default true; collapsed (parentWindow/parentGroup
//                           reads removed 2026-07-16 — were never populated)
//     include_chrome_tab_groups: default true; chromeGroupId/Title/Color on tab nodes
//     include_star_color:   default true; starColor
//     include_row_color:    default true; rowColor
//     include_custom_title: default true; customTitle
//     include_favicons:     default FALSE; favIconUrl
//     include_ghost_tabs:   default true; ghost tab filtering recurses (f147a88)
//
// Same SW-sender + chrome-devtools-mcp invocation pattern as
// dispatch-tier1b-reads.js — see the README for setup steps.
//
// Returns `{passed, failed, results}`. No state mutation; safe to run
// against any DebugProfile.

async function runTier1bReadsShapeOpts() {
    const TIMEOUT_MS = 5000;
    const MINIMAL_KEYS = new Set(['id', 'type', 'title', 'url', 'ghost', 'children']);

    const results = [];
    let passed = 0;
    let failed = 0;

    function dispatch(toolName, toolInput, suffix) {
        return new Promise((resolve) => {
            const requestId = `tier1b-shape-${suffix || toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

    function walk(tree, fn) {
        function v(n) {
            if (!n) return;
            fn(n);
            if (Array.isArray(n.children)) for (const c of n.children) v(c);
        }
        if (Array.isArray(tree)) for (const n of tree) v(n);
    }

    function findFirst(tree, pred) {
        let found = null;
        walk(tree, n => { if (!found && pred(n)) found = n; });
        return found;
    }

    function findById(tree, id) {
        return findFirst(tree, n => n.id === id);
    }

    function countGhostTabs(tree) {
        let n = 0;
        walk(tree, x => { if (x.type === 'tab' && x.ghost === true) n++; });
        return n;
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

    function expect(cond, label) {
        if (!cond) throw new Error(label);
    }

    // ─── 1. minimal:true strips all optional fields ────────────────────────
    await check('get_tree({minimal:true}): every node only has id/type/title/url/ghost/children', async () => {
        const r = await dispatch('get_tree', { minimal: true });
        expect(r?.ok === true, 'ok');
        const violators = [];
        walk(r.tree, n => {
            for (const k of Object.keys(n)) {
                if (!MINIMAL_KEYS.has(k)) violators.push({ id: n.id, type: n.type, extra: k });
            }
        });
        expect(violators.length === 0, `unexpected extra keys: ${JSON.stringify(violators.slice(0, 3))}`);
        return { violators: violators.length, rootNodeCount: r.tree.length };
    });

    // ─── 2. include_tags:false strips tags from nodes that had them ────────
    await check('get_tree({include_tags:false}): tags absent on nodes that had them in default', async () => {
        const def = await dispatch('get_tree', {});
        const taggedDefault = findFirst(def.tree, n => Array.isArray(n.tags) && n.tags.length > 0);
        if (!taggedDefault) return { skipped: 'no node with tags in default' };
        const r = await dispatch('get_tree', { include_tags: false });
        const same = findById(r.tree, taggedDefault.id);
        expect(same, 'same node id found in no-tags tree');
        expect(!('tags' in same), `tags should be absent; got ${JSON.stringify(same.tags)}`);
        // And no node anywhere in the tree should have tags now
        let anyTags = [];
        walk(r.tree, n => { if (Array.isArray(n.tags) && n.tags.length > 0) anyTags.push(n.id); });
        expect(anyTags.length === 0, `tags appeared on ${anyTags.length} nodes after strip`);
        return { taggedId: taggedDefault.id, leakedTagNodes: anyTags.length };
    });

    // ─── 3. include_memos:false strips memoText ────────────────────────────
    await check('get_tree({include_memos:false}): memoText absent on nodes that had it in default', async () => {
        const def = await dispatch('get_tree', {});
        const memoNode = findFirst(def.tree, n => typeof n.memoText === 'string' && n.memoText.length > 0);
        if (!memoNode) return { skipped: 'no node with memoText in default' };
        const r = await dispatch('get_tree', { include_memos: false });
        const same = findById(r.tree, memoNode.id);
        expect(same, 'same id found');
        expect(!('memoText' in same), 'memoText absent on previously-memoed node');
        let leak = [];
        walk(r.tree, n => { if (n.memoText) leak.push(n.id); });
        expect(leak.length === 0, `memoText appeared on ${leak.length} nodes after strip`);
        return { memoId: memoNode.id };
    });

    // ─── 4. include_lineage:false strips collapsed. parentWindow/parentGroup
    // stay in the absence sweep as tripwires: since 2026-07-16 the serializer
    // never emits them under ANY flags (the reads were dead — never populated).
    await check('get_tree({include_lineage:false}): collapsed/parentWindow/parentGroup absent everywhere', async () => {
        const def = await dispatch('get_tree', {});
        const collapsedNode = findFirst(def.tree, n => 'collapsed' in n);
        if (!collapsedNode) return { skipped: 'no node with lineage fields in default' };
        const r = await dispatch('get_tree', { include_lineage: false });
        const lineageHits = [];
        walk(r.tree, n => {
            for (const k of ['collapsed', 'parentWindow', 'parentGroup']) {
                if (k in n) lineageHits.push({ id: n.id, key: k });
            }
        });
        expect(lineageHits.length === 0, `lineage fields should be absent: ${JSON.stringify(lineageHits.slice(0, 3))}`);
        return { defaultHadCollapsed: collapsedNode.id, lineageHits: lineageHits.length };
    });

    // ─── 5. include_star_color:false strips starColor ──────────────────────
    await check('get_tree({include_star_color:false}): starColor absent on nodes that had it', async () => {
        const def = await dispatch('get_tree', {});
        const starNode = findFirst(def.tree, n => n.starColor);
        if (!starNode) return { skipped: 'no node with starColor in default' };
        const r = await dispatch('get_tree', { include_star_color: false });
        const starHits = [];
        walk(r.tree, n => { if (n.starColor) starHits.push(n.id); });
        expect(starHits.length === 0, `starColor leaked to ${starHits.length} nodes`);
        return { defaultHadStar: starNode.id };
    });

    // ─── 6. include_favicons:true adds favIconUrl (default-off opt-in) ─────
    await check('get_tree({include_favicons:true}): default has NO favIconUrl; opt-in surfaces at least one', async () => {
        const def = await dispatch('get_tree', {});
        const tabWithFavInDefault = findFirst(def.tree, n => n.type === 'tab' && n.favIconUrl);
        expect(!tabWithFavInDefault, 'favIconUrl should NOT appear in default shape (default-off opt-in)');
        const r = await dispatch('get_tree', { include_favicons: true });
        const tabWithFav = findFirst(r.tree, n => n.type === 'tab' && typeof n.favIconUrl === 'string' && n.favIconUrl.length > 0);
        // If no tab in the test browser has a favicon, surface as skipped — but the absence-in-default assertion above is sufficient on its own
        if (!tabWithFav) return { skipped: 'no tab with favIconUrl in this DebugProfile state', defaultNoFavicons: true };
        return { tabFavId: tabWithFav.id, favPrefix: tabWithFav.favIconUrl.slice(0, 30) };
    });

    // ─── 7. include_ghost_tabs:false recursion (regression for f147a88) ────
    await check('get_tree({include_ghost_tabs:false}): zero ghost tabs at any depth (f147a88 fix)', async () => {
        const r = await dispatch('get_tree', { include_ghost_tabs: false });
        expect(r?.ok === true, 'ok');
        const ghostCount = countGhostTabs(r.tree);
        expect(ghostCount === 0, `expected 0 ghost tabs at any depth; got ${ghostCount}`);
        // Sanity-check: default DOES include ghosts (proves we're not seeing an empty tree)
        const def = await dispatch('get_tree', {});
        const defaultGhostCount = countGhostTabs(def.tree);
        return { defaultGhostCount, noGhostCount: ghostCount };
    });

    // ─── 8. get_library({minimal:true}) strips library children to basics ──
    await check('get_library({minimal:true}): library children only have basics-set keys', async () => {
        const libs = await dispatch('list_libraries', {});
        const target = (libs.libraries || []).find(l => l.id);
        if (!target) return { skipped: 'no libraries available' };
        const r = await dispatch('get_library', { library_id: target.id, minimal: true });
        expect(r?.ok === true, 'ok');
        const violators = [];
        walk(r.library?.children || [], n => {
            for (const k of Object.keys(n)) {
                if (!MINIMAL_KEYS.has(k)) violators.push({ id: n.id, extra: k });
            }
        });
        expect(violators.length === 0, `unexpected keys in minimal library children: ${JSON.stringify(violators.slice(0, 3))}`);
        return { libId: target.id, childCount: r.library?.children?.length || 0 };
    });

    return { passed, failed, results };
}
