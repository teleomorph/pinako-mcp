// Tool-dispatch helper for Tier 2 — paste body into chrome-devtools-mcp
// `evaluate_script` against the Pinako extension SW (DebugProfile).
//
// Mirrors the dispatch fn in `dispatch-tier1b-reads.js:51-79` but takes
// caller-provided requestId/toolCallId so the Tier 2 orchestrator can
// pass the model's actual ids through verbatim — that's important when
// later asserting on the assistant turn's tool_call_id ↔ tool result
// pairing.
//
// Contract:
//   - Sends `{action:'pinakoExecuteChatTool', requestId, toolCallId,
//             toolName, toolInput}` from the SW to the popup.
//   - Listens for the popup's broadcast `{action:'chatToolResult',
//             requestId, toolCallId, result}`.
//   - Resolves with the `result` envelope: `{ok:true, ...}` or
//             `{ok:false, error:{code, message}}`.
//   - Timeout: 12000ms (chat tools may run reads against 500-node trees,
//     destructive ops re-render the popup, etc. — generous but bounded).
//
// IMPORTANT: chrome.runtime.sendMessage does NOT deliver back to the
// sender. This helper MUST run in the SW context (or any non-popup
// extension page). Tier 1b's dispatch fn enforces this implicitly by
// running from the SW; Tier 2 inherits that constraint.

async function dispatchChatTool({ requestId, toolCallId, toolName, toolInput, timeoutMs }) {
    const TIMEOUT_MS = typeof timeoutMs === 'number' ? timeoutMs : 12000;
    if (!requestId) throw new Error('dispatchChatTool: requestId required');
    if (!toolCallId) throw new Error('dispatchChatTool: toolCallId required');
    if (!toolName) throw new Error('dispatchChatTool: toolName required');

    return new Promise((resolve) => {
        let settled = false;
        function listener(msg) {
            if (msg?.action === 'chatToolResult'
                && msg.requestId === requestId
                && msg.toolCallId === toolCallId) {
                settled = true;
                chrome.runtime.onMessage.removeListener(listener);
                resolve(msg.result);
            }
        }
        chrome.runtime.onMessage.addListener(listener);
        chrome.runtime.sendMessage({
            action: 'pinakoExecuteChatTool',
            requestId,
            toolCallId,
            toolName,
            toolInput: toolInput || {},
        }).catch(() => {
            // The popup will broadcast even if the send-side reports a
            // glitch; don't resolve early on send-side errors.
        });
        setTimeout(() => {
            if (!settled) {
                chrome.runtime.onMessage.removeListener(listener);
                resolve({
                    ok: false,
                    error: {
                        code: 'DISPATCH_TIMEOUT',
                        message: `No chatToolResult within ${TIMEOUT_MS}ms for ${toolName}`,
                    },
                });
            }
        }, TIMEOUT_MS);
    });
}

// When pasted into evaluate_script, the trailing identifier is what the
// outer eval returns. The orchestrator wraps with `async () => { ...;
// return await dispatchChatTool({...}); }`.
dispatchChatTool;
