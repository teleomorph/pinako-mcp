import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpEndpoint } from './endpoint.js';

// ai-todo #67: write tools are refused on a tokenless connection, so the
// suites need the tokened URL. Resolution lives in endpoint.js so this and the
// tier2 harness cannot drift apart.
const DEFAULT_ENDPOINT = mcpEndpoint();

export async function connectPinakoMcp({ endpoint = DEFAULT_ENDPOINT } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client(
    { name: 'pinako-mcp-tests', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    async close() {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
    },
  };
}

export async function callTool(client, name, args = {}) {
  const raw = await client.callTool({ name, arguments: args });
  const text = raw?.content?.[0]?.text;
  let parsed;
  try { parsed = text != null ? JSON.parse(text) : null; }
  catch { parsed = { _rawText: text }; }
  return { raw, parsed, isError: raw?.isError === true };
}

export async function callToolOk(client, name, args = {}) {
  const result = await callTool(client, name, args);
  if (result.isError || result.parsed?.ok === false) {
    const code = result.parsed?.error?.code ?? 'UNKNOWN';
    const msg  = result.parsed?.error?.message ?? JSON.stringify(result.parsed);
    throw new Error(`MCP tool ${name} failed: [${code}] ${msg}`);
  }
  return result.parsed;
}

// Cache-propagation poller. Write tools return ok as soon as the bridge
// dispatches the edit to the extension over native messaging; the extension
// applies the edit and pushes updated data back to the bridge ~1-2s later
// (per the server's FRESHNESS_HINT). Reads that follow a write therefore need
// to poll rather than assume the very next get_* call reflects the change.
export async function waitFor(predicate, { timeout = 8_000, interval = 200, label = 'condition' } = {}) {
  const start = Date.now();
  let lastValue;
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      lastValue = await predicate();
      if (lastValue) return lastValue;
    } catch (err) {
      lastError = err;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  const detail = lastError ? `last error: ${lastError.message}` : `last value: ${JSON.stringify(lastValue)}`;
  throw new Error(`waitFor(${label}) timed out after ${timeout}ms — ${detail}`);
}
