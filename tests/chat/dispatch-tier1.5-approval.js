// Tier 1.5 — approval card UX harness.
//
// Validates the inline approval card that gates destructive chat tool
// calls (Phase 4.4-B commits 4 + 5). Native-chat-specific surface; no
// MCP analog. The protocol section 3.5 + 4 of native-chat-testing-protocol.md
// is the canonical design reference.
//
// Runs in the chat panel context (chat.html). Requires the panel to be
// loaded with `?test=1` so chat.js exposes the `window.__chatTest` hook
// (added near IIFE tail in Pinako/chat.js). The hook is gated and adds
// no surface in normal opens.
//
// How to invoke (via chrome-devtools-mcp):
//   1. Reload extension (so any chat.js edits land):
//      `mcp__chrome-devtools__reload_extension` with the Pinako extension id.
//   2. Open the chat panel with the test query param:
//      `mcp__chrome-devtools__new_page` url=chrome-extension://<id>/chat.html?test=1
//   3. `mcp__chrome-devtools__evaluate_script` on that page (NO serviceWorkerId)
//      with `function:` set to an async IIFE that pastes the body of
//      `runTier15Approval` below, then calls `runTier15Approval()`.
//
// Returns `{passed, failed, results}`.
//
// No state mutation. The bundle stubs `chrome.runtime.sendMessage` per-test
// to capture sends without dispatching real chat tool calls. Cleanup
// restores the original `sendMessage` and clears the synthetic activeRequest.

async function runTier15Approval() {
    const H = window.__chatTest;
    if (!H) return { error: 'window.__chatTest not exposed — was chat.html loaded with ?test=1?' };

    const results = [];
    let passed = 0;
    let failed = 0;

    function check(name, fn) {
        try {
            const sample = fn();
            passed++;
            results.push({ name, ok: true, sample });
        } catch (e) {
            failed++;
            results.push({ name, ok: false, error: String(e?.message || e) });
        }
    }

    function expect(cond, label, extra) {
        if (!cond) throw new Error(`${label}${extra ? ': ' + extra : ''}`);
    }

    // ─── isToolCallDestructive contract ─────────────────────────────────────
    check('isToolCallDestructive: delete_library → true', () => {
        expect(H.isToolCallDestructive('delete_library', {}) === true, 'delete_library is destructive');
        return true;
    });
    check('isToolCallDestructive: delete_node → true', () => {
        expect(H.isToolCallDestructive('delete_node', {}) === true, 'delete_node is destructive');
        return true;
    });
    check('isToolCallDestructive: delete_note → true', () => {
        expect(H.isToolCallDestructive('delete_note', {}) === true, 'delete_note is destructive');
        return true;
    });
    check('isToolCallDestructive: delete_live_node → true', () => {
        expect(H.isToolCallDestructive('delete_live_node', {}) === true, 'delete_live_node is destructive');
        return true;
    });
    check('isToolCallDestructive: delete_library_group cascadeMembers:true → true', () => {
        expect(H.isToolCallDestructive('delete_library_group', { cascadeMembers: true }) === true, 'cascade is destructive');
        return true;
    });
    check('isToolCallDestructive: delete_library_group cascadeMembers:false → false', () => {
        // The non-cascade variant only deletes the group itself; member libs
        // dispersed into panelOrder unchanged. Not destructive per chat.js gate.
        expect(H.isToolCallDestructive('delete_library_group', { cascadeMembers: false }) === false, 'non-cascade is NOT destructive');
        return true;
    });
    check('isToolCallDestructive: set_title → false', () => {
        expect(H.isToolCallDestructive('set_title', { title: 'x' }) === false, 'set_title NOT destructive');
        return true;
    });
    check('isToolCallDestructive: bulk_apply with no destructive sub-ops → false', () => {
        const r = H.isToolCallDestructive('bulk_apply', { ops: [{ type: 'set_tags', nodeId: 'n1', tags: [] }] });
        expect(r === false, `expected false, got ${r}`);
        return r;
    });
    check('isToolCallDestructive: bulk_apply with destructive sub-op → true (recursive defense)', () => {
        // Defense-in-depth at chat.js:129-136. Round-end partition handles
        // bulk_apply with its own branch, so this code path is dormant in
        // practice — but kept correct in case partition logic is bypassed.
        const r = H.isToolCallDestructive('bulk_apply', { ops: [
            { type: 'set_tags', nodeId: 'n1', tags: [] },
            { type: 'delete_node', nodeId: 'n2' },
        ]});
        expect(r === true, `expected true, got ${r}`);
        return r;
    });

    // ─── _buildApprovedInputsByParent: confirmedByUser injection ────────────
    check('_buildApprovedInputsByParent top-level: confirmedByUser at root, original NOT mutated', () => {
        const parentTc = { id: 'tc-1', function: { name: 'delete_library', arguments: '{}' } };
        const parentInput = { libraryId: 'lib-x' };
        const items = [{ parentTc, parentInput, subOpIndex: null, displayInput: parentInput, displayName: 'delete_library' }];
        const map = H._buildApprovedInputsByParent(items);
        expect(map.size === 1, 'one parent in result');
        const out = map.get(parentTc);
        expect(out.confirmedByUser === true, 'root confirmedByUser:true');
        expect(out.libraryId === 'lib-x', 'libraryId preserved');
        // Critical: original parentInput must NOT be mutated (deep-clone)
        expect(parentInput.confirmedByUser === undefined, 'original parentInput untouched (deep-clone)');
        return { rootConfirmed: out.confirmedByUser, deepClone: parentInput.confirmedByUser === undefined };
    });

    check('_buildApprovedInputsByParent bulk_apply: confirmedByUser ONLY on destructive sub-op, NOT envelope', () => {
        const parentTc = { id: 'tc-1', function: { name: 'bulk_apply', arguments: '{}' } };
        const parentInput = {
            scope: 'tree',
            ops: [
                { type: 'set_tags', nodeId: 'n1', tags: ['x'] },
                { type: 'delete_node', nodeId: 'n2' },
                { type: 'set_title', nodeId: 'n3', title: 'z' },
            ],
        };
        const items = [{ parentTc, parentInput, subOpIndex: 1, displayInput: parentInput.ops[1], displayName: 'delete_node' }];
        const map = H._buildApprovedInputsByParent(items);
        const out = map.get(parentTc);
        expect(out.confirmedByUser === undefined, 'envelope confirmedByUser NOT set');
        expect(out.ops[0].confirmedByUser === undefined, 'sub-op[0] (non-destructive) untouched');
        expect(out.ops[1].confirmedByUser === true, 'sub-op[1] (destructive) flagged');
        expect(out.ops[2].confirmedByUser === undefined, 'sub-op[2] (non-destructive) untouched');
        expect(parentInput.ops[1].confirmedByUser === undefined, 'original deep-clone preserved');
        return { sub1: out.ops[1].confirmedByUser, envelopeUntouched: out.confirmedByUser === undefined };
    });

    check('_buildApprovedInputsByParent bulk_apply multi-destructive: each destructive sub-op flagged independently', () => {
        const parentTc = { id: 'tc-1', function: { name: 'bulk_apply', arguments: '{}' } };
        const parentInput = {
            scope: 'tree',
            ops: [
                { type: 'delete_node', nodeId: 'n1' },
                { type: 'set_tags', nodeId: 'n2', tags: [] },
                { type: 'delete_node', nodeId: 'n3' },
            ],
        };
        const items = [
            { parentTc, parentInput, subOpIndex: 0, displayInput: parentInput.ops[0], displayName: 'delete_node' },
            { parentTc, parentInput, subOpIndex: 2, displayInput: parentInput.ops[2], displayName: 'delete_node' },
        ];
        const map = H._buildApprovedInputsByParent(items);
        const out = map.get(parentTc);
        expect(out.ops[0].confirmedByUser === true, 'sub-op[0] flagged');
        expect(out.ops[1].confirmedByUser === undefined, 'sub-op[1] (non-destructive) untouched');
        expect(out.ops[2].confirmedByUser === true, 'sub-op[2] flagged');
        return { flagged: [out.ops[0].confirmedByUser, out.ops[2].confirmedByUser] };
    });

    // ─── _renderApprovalCard: DOM correctness ───────────────────────────────
    check('_renderApprovalCard single op: card has Approve/Deny + lists tool name', () => {
        const parentTc = { id: 'tc-1', function: { name: 'delete_library', arguments: '{}' } };
        const items = [{ parentTc, parentInput: { libraryId: 'lib-x' }, subOpIndex: null, displayInput: { libraryId: 'lib-x' }, displayName: 'delete_library' }];
        const card = H._renderApprovalCard(items);
        expect(card instanceof HTMLElement, 'card is HTMLElement');
        expect(card.classList.contains('chat-approval-card'), 'has chat-approval-card class');
        expect(card.classList.contains('awaiting'), 'has awaiting class');
        expect(card.querySelector('.approval-btn-approve') != null, 'Approve button present');
        expect(card.querySelector('.approval-btn-deny') != null, 'Deny button present');
        expect(card.querySelector('.approval-auto-approve-cb') != null, 'auto-approve checkbox present');
        expect(card.textContent.includes('delete_library'), 'tool name visible');
        return { hasButtons: true };
    });

    check('_renderApprovalCard bulk_apply destructive sub-ops: ONE consolidated card lists every sub-op', () => {
        const parentTc = { id: 'tc-1', function: { name: 'bulk_apply', arguments: '{}' } };
        const parentInput = { scope: 'tree', ops: [
            { type: 'delete_node', nodeId: 'n1' },
            { type: 'delete_node', nodeId: 'n2' },
            { type: 'delete_node', nodeId: 'n3' },
        ]};
        const items = [
            { parentTc, parentInput, subOpIndex: 0, displayInput: parentInput.ops[0], displayName: 'delete_node' },
            { parentTc, parentInput, subOpIndex: 1, displayInput: parentInput.ops[1], displayName: 'delete_node' },
            { parentTc, parentInput, subOpIndex: 2, displayInput: parentInput.ops[2], displayName: 'delete_node' },
        ];
        const card = H._renderApprovalCard(items);
        const text = card.textContent;
        expect(text.includes('n1'), 'mentions n1');
        expect(text.includes('n2'), 'mentions n2');
        expect(text.includes('n3'), 'mentions n3');
        expect(card.querySelectorAll('.approval-btn-approve').length === 1, 'ONE Approve button (consolidated)');
        expect(card.querySelectorAll('.approval-btn-deny').length === 1, 'ONE Deny button (consolidated)');
        return { itemCount: items.length };
    });

    // ─── Approve / Deny click flows ─────────────────────────────────────────
    check('Approve click: dispatches chatExecuteTool with confirmedByUser:true; card → .approved', () => {
        const bubbleEl = document.createElement('div');
        bubbleEl.id = 'test-bubble-approve';
        document.body.appendChild(bubbleEl);
        H.setActiveRequest({
            requestId: 'test-req-approve',
            bubbleEl,
            pendingToolCalls: new Map(),
            pendingResults: new Map(),
            accumText: '',
            currentTextEl: null,
        });
        const captured = [];
        const orig = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (msg) => { captured.push(msg); return Promise.resolve(); };
        try {
            const parentTc = { id: 'tc-approve', function: { name: 'delete_library', arguments: '{"libraryId":"lib-x"}' } };
            const items = [{ parentTc, parentInput: { libraryId: 'lib-x' }, subOpIndex: null, displayInput: { libraryId: 'lib-x' }, displayName: 'delete_library' }];
            const card = H._renderApprovalCard(items);
            bubbleEl.appendChild(card);
            card.querySelector('.approval-btn-approve').click();
            expect(card.classList.contains('approved'), 'card transitioned to .approved');
            expect(!card.classList.contains('awaiting'), 'card no longer .awaiting');
            const sent = captured.find(m => m?.action === 'chatExecuteTool');
            expect(sent != null, 'chatExecuteTool message dispatched');
            expect(sent.toolName === 'delete_library', 'toolName preserved');
            expect(sent.toolInput?.confirmedByUser === true, 'confirmedByUser:true injected');
            expect(sent.toolInput?.libraryId === 'lib-x', 'libraryId preserved');
            return { sentToolInput: sent.toolInput };
        } finally {
            chrome.runtime.sendMessage = orig;
            bubbleEl.remove();
            H.setActiveRequest(null);
        }
    });

    check('Deny click: pendingResults gets USER_DENIED; card → .denied; no continuation (size < length)', () => {
        const bubbleEl = document.createElement('div');
        bubbleEl.id = 'test-bubble-deny';
        document.body.appendChild(bubbleEl);
        const pendingResults = new Map();
        H.setActiveRequest({
            requestId: 'test-req-deny',
            bubbleEl,
            pendingToolCalls: new Map(),
            pendingResults,
            accumText: '',
            currentTextEl: null,
        });
        // Add an assistant turn to conversation so _handleChatToolResult can
        // see tool_calls.length > 1; with only 1 result the continuation
        // won't fire (pendingResults.size < tool_calls.length).
        const conv = H.getConversation();
        const convLenBefore = conv.length;
        conv.push({ role: 'assistant', content: null, tool_calls: [
            { id: 'tc-deny', function: { name: 'delete_library', arguments: '{}' } },
            { id: 'tc-other', function: { name: 'noop_other', arguments: '{}' } },
        ]});
        const captured = [];
        const orig = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (msg) => { captured.push(msg); return Promise.resolve(); };
        try {
            const parentTc = { id: 'tc-deny', function: { name: 'delete_library', arguments: '{"libraryId":"lib-x"}' } };
            const items = [{ parentTc, parentInput: { libraryId: 'lib-x' }, subOpIndex: null, displayInput: { libraryId: 'lib-x' }, displayName: 'delete_library' }];
            const card = H._renderApprovalCard(items);
            bubbleEl.appendChild(card);
            card.querySelector('.approval-btn-deny').click();
            expect(card.classList.contains('denied'), 'card transitioned to .denied');
            expect(!card.classList.contains('awaiting'), 'card no longer .awaiting');
            const stored = pendingResults.get('tc-deny');
            expect(stored != null, 'pendingResults entry exists for tc-deny');
            expect(stored.ok === false, 'result.ok=false');
            expect(stored.error?.code === 'USER_DENIED', 'USER_DENIED code');
            expect(captured.find(m => m?.action === 'chatMessage') == null, 'no continuation dispatched (size < length)');
            return { deniedCode: stored.error.code };
        } finally {
            chrome.runtime.sendMessage = orig;
            while (conv.length > convLenBefore) conv.pop();
            bubbleEl.remove();
            H.setActiveRequest(null);
        }
    });

    check('Auto-approve checkbox + Approve → sessionAutoApprove flips to true', () => {
        H.setSessionAutoApprove(false);
        const bubbleEl = document.createElement('div');
        bubbleEl.id = 'test-bubble-autoapp';
        document.body.appendChild(bubbleEl);
        H.setActiveRequest({
            requestId: 'test-req-autoapp',
            bubbleEl,
            pendingToolCalls: new Map(),
            pendingResults: new Map(),
            accumText: '',
            currentTextEl: null,
        });
        const orig = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = () => Promise.resolve();
        try {
            const parentTc = { id: 'tc-aa', function: { name: 'delete_library', arguments: '{}' } };
            const items = [{ parentTc, parentInput: { libraryId: 'lib-x' }, subOpIndex: null, displayInput: { libraryId: 'lib-x' }, displayName: 'delete_library' }];
            const card = H._renderApprovalCard(items);
            bubbleEl.appendChild(card);
            const cb = card.querySelector('.approval-auto-approve-cb');
            expect(cb.checked === false, 'cb initially unchecked');
            cb.checked = true;
            card.querySelector('.approval-btn-approve').click();
            expect(H.getSessionAutoApprove() === true, 'sessionAutoApprove flipped to true');
            return { autoApproved: H.getSessionAutoApprove() };
        } finally {
            chrome.runtime.sendMessage = orig;
            bubbleEl.remove();
            H.setSessionAutoApprove(false);
            H.setActiveRequest(null);
        }
    });

    check('Deny + auto-approve checkbox checked → sessionAutoApprove stays false (intentional)', () => {
        // Per chat.js comment: "Deny + checked is intentionally a no-op —
        // denying suggests the user isn't ready to grant blanket trust."
        H.setSessionAutoApprove(false);
        const bubbleEl = document.createElement('div');
        document.body.appendChild(bubbleEl);
        const pendingResults = new Map();
        H.setActiveRequest({
            requestId: 'test-req-deny-aa',
            bubbleEl,
            pendingToolCalls: new Map(),
            pendingResults,
            accumText: '',
            currentTextEl: null,
        });
        const conv = H.getConversation();
        const convLenBefore = conv.length;
        conv.push({ role: 'assistant', content: null, tool_calls: [
            { id: 'tc-deny-aa', function: { name: 'delete_library', arguments: '{}' } },
            { id: 'tc-other-aa', function: { name: 'noop', arguments: '{}' } },
        ]});
        const orig = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = () => Promise.resolve();
        try {
            const parentTc = { id: 'tc-deny-aa', function: { name: 'delete_library', arguments: '{}' } };
            const items = [{ parentTc, parentInput: { libraryId: 'lib-x' }, subOpIndex: null, displayInput: { libraryId: 'lib-x' }, displayName: 'delete_library' }];
            const card = H._renderApprovalCard(items);
            bubbleEl.appendChild(card);
            card.querySelector('.approval-auto-approve-cb').checked = true;
            card.querySelector('.approval-btn-deny').click();
            expect(H.getSessionAutoApprove() === false, 'sessionAutoApprove unchanged on deny');
            return { stayedFalse: H.getSessionAutoApprove() === false };
        } finally {
            chrome.runtime.sendMessage = orig;
            while (conv.length > convLenBefore) conv.pop();
            bubbleEl.remove();
            H.setSessionAutoApprove(false);
            H.setActiveRequest(null);
        }
    });

    return { passed, failed, results };
}
