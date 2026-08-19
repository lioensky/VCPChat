import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
const askNovaSource = fs.readFileSync(path.join(root, 'modules/ui-system/ask-nova-modal.js'), 'utf8');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'scripts/ui-interaction-inventory.json'), 'utf8'));
const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
const errors = [];
const seen = new Set();
for (const surface of inventory.surfaces) {
  if (!surface.id || seen.has(surface.id)) errors.push(`duplicate or missing surface id: ${surface.id || '<missing>'}`);
  seen.add(surface.id);
  for (const field of ['owner', 'triggerIds', 'focusEntry', 'escape', 'terminal', 'test']) {
    if (!surface[field] || (Array.isArray(surface[field]) && surface[field].length === 0)) errors.push(`${surface.id}: missing ${field}`);
  }
  if (!(surface.rootIds?.length || surface.rootSelectors?.length || surface.dynamicRootIds?.length)) errors.push(`${surface.id}: missing root declaration`);
  for (const selector of surface.rootSelectors || []) {
    if (!selector || !(html.includes(selector.replace(/^\./, '')) || askNovaSource.includes(selector.replace(/^\./, '')))) errors.push(`${surface.id}: dynamic root selector not represented in source: ${selector}`);
  }
  for (const id of [...(surface.triggerIds || []), ...(surface.rootIds || []), surface.focusEntry]) {
    if (!ids.has(id)) errors.push(`${surface.id}: inventory id not found in main.html: ${id}`);
  }
}
for (const match of html.matchAll(/\baria-controls=["']([^"']+)["']/g)) {
  if (!ids.has(match[1])) errors.push(`aria-controls target not found: ${match[1]}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`UI interaction inventory passed: ${inventory.surfaces.length} surfaces, ${ids.size} ids`);
}
