import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts/ui-task-journey-matrix.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
const errors = [];
for (const journey of matrix.journeys) {
  if (!journey.id || !journey.entry || !journey.steps?.length || !journey.worldAssertions?.length || !journey.evidence) {
    errors.push(`${journey.id || '<missing>'}: incomplete journey declaration`);
  }
  if (!['messageInput', 'main.html'].includes(journey.entry) && !ids.has(journey.entry)) errors.push(`${journey.id}: entry not found in main.html: ${journey.entry}`);
  if (!fs.existsSync(path.join(root, journey.evidence))) errors.push(`${journey.id}: evidence file missing: ${journey.evidence}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`UI task journey matrix passed: ${matrix.journeys.length} journeys`);
