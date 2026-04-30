/**
 * setup/configure.js
 *
 * Writes Pinako MCP config entries into each AI client's config file.
 * Each client gets a deep-merge: existing config is preserved, only
 * the pinako entry is added/updated.
 */

import fs from 'node:fs';
import path from 'node:path';

const MCP_URL = 'http://localhost:37421/mcp';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// Deep-merge src into dst (one level for mcpServers, not recursive)
function mergeConfig(dst, src) {
  for (const [key, val] of Object.entries(src)) {
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        dst[key] && typeof dst[key] === 'object') {
      dst[key] = { ...dst[key], ...val };
    } else {
      dst[key] = val;
    }
  }
  return dst;
}

// ─── Per-client config writers ────────────────────────────────────────────────

const writers = {

  'claude-code'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { type: 'http', url: MCP_URL };
    writeJson(configPath, config);
  },

  'claude-desktop'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    // Claude Desktop only supports stdio MCP servers (command + args).
    // mcp-remote is the official Anthropic-recommended bridge from stdio to HTTP.
    config.mcpServers.pinako = {
      command: 'npx',
      args: ['-y', 'mcp-remote', MCP_URL],
    };
    writeJson(configPath, config);
  },

  'cursor'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { url: MCP_URL };
    writeJson(configPath, config);
  },

  'windsurf'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { url: MCP_URL };
    writeJson(configPath, config);
  },

  'cline'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = {
      url: MCP_URL,
      disabled: false,
      autoApprove: [],
    };
    writeJson(configPath, config);
  },

  'roo-code'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = {
      url: MCP_URL,
      disabled: false,
      autoApprove: [],
    };
    writeJson(configPath, config);
  },

  'continue'(configPath) {
    const config = readJson(configPath);
    config.experimental = config.experimental || {};
    config.experimental.modelContextProtocolServers =
      config.experimental.modelContextProtocolServers || [];

    const servers = config.experimental.modelContextProtocolServers;
    // Remove any existing pinako entry to avoid duplicates
    const filtered = servers.filter(s => s?.transport?.url !== MCP_URL);
    filtered.push({ transport: { type: 'streamableHttp', url: MCP_URL } });
    config.experimental.modelContextProtocolServers = filtered;
    writeJson(configPath, config);
  },

};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Configure a single client by id.
 * Returns { ok: true } or { ok: false, error: string }
 */
export function configureClient(client) {
  const writer = writers[client.id];
  if (!writer) {
    return { ok: false, error: `No writer defined for client: ${client.id}` };
  }
  try {
    writer(client.configPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Configure multiple clients. Returns array of { client, ok, error? }.
 */
export function configureClients(clients) {
  return clients.map(client => ({
    client,
    ...configureClient(client),
  }));
}
