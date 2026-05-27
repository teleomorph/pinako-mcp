// Pinako native chat — Tier 2 EF round driver.
//
// One Pinako AI chat round = one POST to the chat-completion EF + parse
// of the SSE stream until `{type:'done'}`. This module is intentionally
// SINGLE-ROUND so the caller (a test orchestrator, an automation script,
// or a human via chrome-devtools-mcp) owns the multi-round tool-execution
// loop. That separation matters: tool dispatch is intrinsically out-of-
// process (extension SW lives in Chrome; this runner lives in Node), so
// pretending the loop is internal would just hide the actual seam.
//
// USAGE — programmatic:
//   import { postChatRound } from './chat-completion-runner.mjs';
//   const result = await postChatRound({
//     ef: { url, jwt, apikey },
//     model: 'anthropic-haiku-4-5',
//     byoAnthropicToken: 'sk-ant-oat01-...',
//     systemPrompt: 'You are Pinako AI...',
//     treeContext: '{...}',
//     currentDateTime: new Date().toISOString(),
//     messages: [{ role: 'user', content: '...' }],
//     requestId: crypto.randomUUID(),
//   });
//   // result: { ok, finalText, toolCalls:[{id,name,argumentsRaw}],
//   //           usage, envelopes:[...raw...], doneReceived, error? }
//
// USAGE — CLI:
//   node chat-completion-runner.mjs --stdin-json < input.json > result.json
//   Input shape: full args object from above; output shape: full result.
//
// Per `chat-panel-4-2-reference.md` and `chat.js:1869+` (handleStreamEnvelope),
// the EF emits these wire envelopes:
//   token              — assistant text delta
//   tool_call_delta    — incremental tool call (xAI/OpenAI shape, EF
//                        normalizes Anthropic's content_block_delta into
//                        this shape; see chat-completion/index.ts:1377+)
//   usage              — end-of-round token + cost summary
//   error              — upstream or EF-side error
//   budget_exhausted   — Pinako-billed mid-stream abort (4.3 E2)
//   done               — terminal envelope; closes the round
//
// Tool-call accumulation mirrors chat.js:1912-1923 verbatim — key by
// `delta.index`, build `{id, name, argumentsRaw}`, EF guarantees each
// tool call's id+name arrive at least once across the stream and
// arguments are concatenated.

const SSE_PREFIX = 'data:';

export async function postChatRound(args) {
  validateArgs(args);
  const {
    ef,
    model,
    systemPrompt,
    messages,
    treeContext = '',
    currentDateTime = new Date().toISOString(),
    requestId = randomUuid(),
    browserId = null,
    browserBrand = null,
    reasoningEffort = null,
    byoAnthropicToken = null,
    byoOpenAiCompat = null,
    byoGeminiToken = null,
    timeoutMs = 120_000,
    signal: callerSignal = null,
  } = args;

  const reqBody = {
    systemPrompt,
    messages,
    treeContext,
    currentDateTime,
    model,
    requestId,
    browserId,
    browserBrand,
  };
  if (byoAnthropicToken) reqBody.byoAnthropicToken = byoAnthropicToken;
  if (byoOpenAiCompat) reqBody.byoOpenAiCompat = byoOpenAiCompat;
  if (byoGeminiToken) reqBody.byoGeminiToken = byoGeminiToken;
  if (reasoningEffort) reqBody.reasoningEffort = reasoningEffort;

  const ourAbort = new AbortController();
  const onCallerAbort = () => ourAbort.abort();
  if (callerSignal) {
    if (callerSignal.aborted) ourAbort.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => ourAbort.abort(), timeoutMs);

  const result = {
    ok: false,
    finalText: '',
    toolCalls: [],
    usage: null,
    envelopes: [],
    doneReceived: false,
    budgetExhausted: false,
    error: null,
    durationMs: 0,
    requestId,
    model,
  };
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(ef.url, {
      method: 'POST',
      signal: ourAbort.signal,
      headers: {
        'Authorization': `Bearer ${ef.jwt}`,
        'apikey': ef.apikey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    result.error = {
      code: ourAbort.signal.aborted ? 'NETWORK_ABORT' : 'NETWORK_ERROR',
      message: String(err?.message || err),
    };
    result.durationMs = Date.now() - t0;
    return result;
  }

  if (!res.ok) {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    let body = null;
    try { body = await res.json(); } catch (_) {}
    result.error = {
      code: body?.error?.code || `HTTP_${res.status}`,
      message: body?.error?.message || `EF returned ${res.status}`,
      context: body?.error?.context ?? null,
      status: res.status,
    };
    result.durationMs = Date.now() - t0;
    return result;
  }

  // Tool-call accumulators, keyed by delta.index. Mirrors chat.js:1914.
  // `argumentsRaw` is concatenated across deltas; defensively coerced at
  // round-end via parseToolInputSafe (caller can also parse it).
  const pendingToolCalls = new Map();

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Pinako EF emits `data:<json>\n` lines (the shape sent by sseLine()
      // in chat-completion/index.ts:972). Note: this is the wire format
      // FROM the EF — already normalized from each upstream provider's
      // native SSE shape. We only ever see Pinako's canonical envelopes.
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith(SSE_PREFIX)) continue;
        const payload = line.slice(SSE_PREFIX.length).trim();
        if (!payload || payload === '[DONE]') continue;
        let envelope;
        try { envelope = JSON.parse(payload); }
        catch (_) { continue; }
        result.envelopes.push(envelope);
        applyEnvelope(envelope, result, pendingToolCalls);
        if (envelope.type === 'done') {
          result.doneReceived = true;
          break;
        }
      }
      if (result.doneReceived) break;
    }
  } catch (err) {
    if (ourAbort.signal.aborted && !result.doneReceived) {
      result.error = result.error || { code: 'STREAM_ABORT', message: 'Stream read aborted (timeout or caller cancel)' };
    } else if (!result.doneReceived) {
      result.error = result.error || { code: 'STREAM_ERROR', message: String(err?.message || err) };
    }
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }

  // Finalize pendingToolCalls into result.toolCalls — order by delta.index
  // (matches chat.js:2027). EF guarantees an id+name arrived for any tool
  // call whose accumulator was created (per Anthropic content_block_start
  // and xAI's id-bearing first delta); if missing, synthesize an id like
  // chat.js does so the caller can still build a continuation turn.
  const idxs = [...pendingToolCalls.keys()].sort((a, b) => a - b);
  for (const idx of idxs) {
    const acc = pendingToolCalls.get(idx);
    const id = acc.id || `call_${requestId}_${idx}`;
    result.toolCalls.push({
      id,
      index: idx,
      name: acc.name,
      argumentsRaw: acc.argumentsRaw || '{}',
    });
  }

  result.ok = result.doneReceived && !result.error;
  result.durationMs = Date.now() - t0;
  return result;
}

function applyEnvelope(envelope, result, pendingToolCalls) {
  switch (envelope.type) {
    case 'token': {
      if (typeof envelope.delta === 'string') result.finalText += envelope.delta;
      return;
    }
    case 'tool_call_delta': {
      const deltas = Array.isArray(envelope.tool_calls) ? envelope.tool_calls : [];
      for (const d of deltas) {
        if (typeof d?.index !== 'number') continue;
        let acc = pendingToolCalls.get(d.index);
        if (!acc) {
          acc = { id: '', name: '', argumentsRaw: '' };
          pendingToolCalls.set(d.index, acc);
        }
        if (d.id) acc.id = d.id;
        if (d.function?.name) acc.name = d.function.name;
        if (typeof d.function?.arguments === 'string') acc.argumentsRaw += d.function.arguments;
      }
      return;
    }
    case 'usage': {
      result.usage = {
        promptTokens: envelope.promptTokens ?? 0,
        completionTokens: envelope.completionTokens ?? 0,
        model: envelope.model ?? null,
        firstTokenLatencyMs: envelope.firstTokenLatencyMs ?? null,
        costUsdTicks: envelope.costUsdTicks ?? null,
        requestId: envelope.requestId ?? null,
      };
      return;
    }
    case 'budget_exhausted': {
      result.budgetExhausted = true;
      return;
    }
    case 'error': {
      result.error = {
        code: envelope.code || 'UNKNOWN_ERROR',
        message: envelope.message || 'Unspecified error',
        context: envelope.context ?? null,
      };
      return;
    }
    case 'done': {
      return;
    }
    default:
      return;
  }
}

// Defensive JSON.parse for `argumentsRaw`. EF concatenates incremental
// JSON fragments; on a clean stream the result is a valid JSON object,
// but a mid-stream abort can leave it truncated. Caller may want to
// surface this rather than throwing.
export function parseToolInputSafe(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch (e) { return { ok: false, error: String(e?.message || e), raw }; }
}

// Build the next round's `messages` array given the previous round's
// result and the tool-dispatch outcomes. Mirrors chat.js's conversation
// shape after _handleRoundEndWithTools + _handleChatToolResult:
//   prev: [...prior messages..., {role:'user', content:'...'}]
//   roundResult: postChatRound output for the latest round
//   toolResultsById: Map<toolCallId, anyResultObject>
// Returns the new messages array; mutate-safe (returns a copy).
export function buildContinuationMessages(prev, roundResult, toolResultsById) {
  const next = prev.map(m => ({ ...m }));
  const toolCallsArr = roundResult.toolCalls.map(tc => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.argumentsRaw || '{}' },
  }));
  next.push({
    role: 'assistant',
    content: roundResult.finalText || '',
    tool_calls: toolCallsArr,
  });
  // Append tool turns in tool_calls index order (chat.js:2614).
  for (const tc of roundResult.toolCalls) {
    const r = toolResultsById.get(tc.id);
    next.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: typeof r === 'string' ? r : JSON.stringify(r ?? null),
    });
  }
  return next;
}

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('postChatRound: args object required');
  if (!args.ef?.url) throw new Error('postChatRound: ef.url required');
  if (!args.ef?.jwt) throw new Error('postChatRound: ef.jwt required');
  if (!args.ef?.apikey) throw new Error('postChatRound: ef.apikey required');
  if (!args.model || typeof args.model !== 'string') throw new Error('postChatRound: model required');
  if (!args.systemPrompt || typeof args.systemPrompt !== 'string') throw new Error('postChatRound: systemPrompt required');
  if (!Array.isArray(args.messages) || args.messages.length === 0) throw new Error('postChatRound: messages array required');
  if (args.model.startsWith('anthropic-') && !args.byoAnthropicToken) {
    throw new Error('postChatRound: byoAnthropicToken required for anthropic-* models');
  }
  if (args.model.startsWith('gemini-') && !args.byoGeminiToken) {
    throw new Error('postChatRound: byoGeminiToken required for gemini-* models');
  }
  if ((args.model.startsWith('openai-compat-') || args.model.startsWith('openrouter-')) && !args.byoOpenAiCompat) {
    throw new Error('postChatRound: byoOpenAiCompat required for openai-compat-* / openrouter-* models');
  }
}

function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // RFC 4122 v4 fallback for older Node.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// CLI entry — only fires when invoked as `node chat-completion-runner.mjs ...`,
// not on `import`. Reads JSON args from stdin, writes JSON result to stdout.
const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1] || '';
    return url.pathname.endsWith(argv1.replace(/\\/g, '/').split('/').pop());
  } catch (_) { return false; }
})();

if (isMain && process.argv.includes('--stdin-json')) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await postChatRound(input);
  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write('\n');
}
