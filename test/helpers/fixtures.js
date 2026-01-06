import { readFile } from 'node:fs/promises';

export async function readFixture(name) {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  const data = await readFile(url, 'utf8');
  return JSON.parse(data);
}
