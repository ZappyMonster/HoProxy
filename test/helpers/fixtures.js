import { readFile } from 'node:fs/promises';

const fixtureCache = new Map();

function cloneFixture(data) {
  if (typeof structuredClone === 'function') {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data));
}

export async function readFixture(name) {
  if (fixtureCache.has(name)) {
    return cloneFixture(fixtureCache.get(name));
  }

  const url = new URL(`../fixtures/${name}`, import.meta.url);
  const data = JSON.parse(await readFile(url, 'utf8'));
  fixtureCache.set(name, data);
  return cloneFixture(data);
}

export function clearFixtureCache() {
  fixtureCache.clear();
}
