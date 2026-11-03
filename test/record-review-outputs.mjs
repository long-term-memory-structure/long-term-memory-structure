// Records what ltms prints for each transcript in test/fixtures/review (the probes an independent pre-publish
// review wrote to kill mutants that survived the suite: live-path repairs, channels, request grouping, labels).
// The test compares every later build with this record. Re-record ONLY after reading the diff: a changed output
// is either a fix (say which) or a regression.
//   node test/record-review-outputs.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'review');
const CLI = process.env.LTMS_CLI || join(HERE, '..', 'dist', 'cli.js');
const out = {};
for (const name of readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
  out[name] = {};
  for (const cmd of ['skeleton', 'stats']) {
    const r = spawnSync(process.execPath, [CLI, cmd, join(DIR, name)], { encoding: 'utf8' });
    out[name][cmd] = { code: r.status, out: r.stdout, err: r.stderr.split(DIR).join('<dir>') };
  }
}
writeFileSync(join(DIR, 'expected.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`recorded ${Object.keys(out).length} transcripts`);
