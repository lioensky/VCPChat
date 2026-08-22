import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts/ui-async-state-matrix.json'), 'utf8'));
const required = new Set(matrix.states);
const errors = [];
const seen = new Set();
for (const surface of matrix.surfaces) {
  if (seen.has(surface.id)) errors.push(`duplicate async surface: ${surface.id}`);
  seen.add(surface.id);
  for (const field of ['owner', 'source', 'test']) {
    if (!surface[field]) errors.push(`${surface.id}: missing ${field}`);
  }
  for (const state of required) {
    if (!surface.states?.includes(state)) errors.push(`${surface.id}: missing state ${state}`);
  }
  for (const file of [surface.source, surface.test, surface.serviceTest, surface.unitTest]) {
    if (!file) continue;
    if (!fs.existsSync(path.join(root, file))) errors.push(`${surface.id}: missing evidence file ${file}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`UI async state matrix passed: ${matrix.surfaces.length} surfaces × ${matrix.states.length} states`);
}
