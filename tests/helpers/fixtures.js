const TEST_PREFIX = 'pinako-mcp-test';

export function testLabel(suffix = '') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  const tail = suffix ? `-${suffix}` : '';
  return `${TEST_PREFIX}-${ts}-${rand}${tail}`;
}

export function isTestArtifact(title) {
  return typeof title === 'string' && title.startsWith(TEST_PREFIX);
}

export const TEST_PREFIX_VALUE = TEST_PREFIX;
