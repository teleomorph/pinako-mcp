import { callToolOk } from './mcp-client.js';

const DEFAULT_BROWSER = process.env.PINAKO_TEST_BROWSER || 'Chrome';

export async function resolveTargetBrowser(client) {
  const { browsers } = await callToolOk(client, 'list_browsers', {});
  if (!Array.isArray(browsers) || browsers.length === 0) {
    throw new Error(
      'No Pinako browsers connected to host.js. Open the Pinako extension popup in ' +
      `${DEFAULT_BROWSER} to re-establish native-messaging.`,
    );
  }
  const wanted = DEFAULT_BROWSER.toLowerCase();
  // Pick the FRESHEST matching browser (lowest dataAge in ms). Multiple
  // popups of the same brand can register simultaneously (open + closed
  // but not yet evicted from cache); test routing to a stale entry leads
  // to "engine doesn't know op X" failures because the actual receiving
  // popup is gone. Sort by dataAge ascending and take the first.
  const matches = browsers
    .filter(b => (b.browserBrand || '').toLowerCase() === wanted)
    .sort((a, b) => (a.dataAge ?? Infinity) - (b.dataAge ?? Infinity));
  if (matches.length === 0) {
    const available = browsers.map(b => b.browserBrand).join(', ');
    throw new Error(
      `PINAKO_TEST_BROWSER="${DEFAULT_BROWSER}" not found in connected browsers (${available}). ` +
      `Open the Pinako popup in ${DEFAULT_BROWSER}, or set PINAKO_TEST_BROWSER to one of: ${available}.`,
    );
  }
  // Return the SPECIFIC browserId of the freshest match, not just the
  // brand. The host.js selectBrowser() does cachedData.has(arg) first,
  // so passing a browserId routes deterministically to that exact
  // device. Passing just the brand name would re-trigger the
  // multi-device ambiguity at dispatch time (selectBrowser picks the
  // first Map entry whose brand matches, not the freshest).
  return matches[0].browserId;
}
