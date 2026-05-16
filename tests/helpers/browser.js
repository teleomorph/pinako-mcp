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
  const match = browsers.find(b => (b.browserBrand || '').toLowerCase() === wanted);
  if (!match) {
    const available = browsers.map(b => b.browserBrand).join(', ');
    throw new Error(
      `PINAKO_TEST_BROWSER="${DEFAULT_BROWSER}" not found in connected browsers (${available}). ` +
      `Open the Pinako popup in ${DEFAULT_BROWSER}, or set PINAKO_TEST_BROWSER to one of: ${available}.`,
    );
  }
  return match.browserBrand;
}
