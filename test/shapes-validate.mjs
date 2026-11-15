#!/usr/bin/env node
// test/shapes-validate.mjs: an INDEPENDENT validator of the ltms-shapes/0 closed language, the receiver's check. It
// shares no code with src/shapes.ts (the writer and its --check): it is the S373 prototype's validate.mjs, its code
// unchanged below this header but for the changes listed here. It reads every string and every number in a report and
// asks only: is this token one the language allows where it stands? The fixed words, a bucket, an N.N.N version, a
// vocabulary path (or one .* / [] step past one), a vocabulary value or kind, a name the header's allowed list holds.
//
// Changed since the prototype, each with the rule it follows (S375, after S374's closure read):
//   - isVersion: no part of more than one digit starts with 0 (U3).
//   node test/shapes-validate.mjs <report.jsonl> <vocabulary.json>...     exit 0 when every token is allowed
import { readFileSync } from 'node:fs';

export function language(vocabFiles, allowed) {
  const P = new Set(), VALUES = new Map(), KIND = { path: null, sub: new Map() }, names = new Set();
  for (const f of vocabFiles) {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    names.add(v.name);
    v.paths.forEach((p) => P.add(p));
    for (const [p, vs] of Object.entries(v.values ?? {})) { if (!VALUES.has(p)) VALUES.set(p, new Set()); vs.forEach((x) => VALUES.get(p).add(x)); }
    if (v.kinds) { KIND.path = v.kinds.path; for (const [t, s] of Object.entries(v.kinds.sub ?? {})) KIND.sub.set(t, s); }
  }
  for (const s of allowed) {
    const [p, val] = s.includes('=') ? s.split('=') : [s, null];
    let acc = ''; for (const g of p.match(/\.[^.[]+|\[\]/g)) { acc += g; P.add(acc); }
    if (val) { if (!VALUES.has(p)) VALUES.set(p, new Set()); VALUES.get(p).add(val); }
  }
  return { P, VALUES, KIND, names };
}
const FIELDS = new Set(['k', 'format', 'vocabulary', 'name', 'sha256', 'paths', 'values', 'floor', 'allowed', 'files', 'read', 'failed', 'lines', 'records', 'blank', 'notJson', 'notObject', 'tooLong', 'v', 'kind', 'versions', 'path', 'n', 'first', 'last', 'types', 'strings', 'numbers', 'booleans', 'lengths', 'names']);
const FIXED = new Set(['shapes', 'version', 'kind', 'path', 'rare', 'end', 'ltms-shapes/0', '(rare)', '(unlisted)', '(none)', '(withheld)', '(not a string)', '(all)', '64+',
  'array', 'boolean', 'null', 'number', 'object', 'string', 'empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'version', 'digits', 'hex', 'label', 'text', 'int', 'float', 'epoch-s', 'epoch-ms', 'true', 'false']);
export const isBucket = (s) => s === '0' || s === '1' || ((m) => !!m && Number(m[1]) >= 2 && Number.isInteger(Math.log2(Number(m[1]))) && Number(m[2]) === 2 * Number(m[1]) - 1)(/^(\d+)-(\d+)$/.exec(s));
const isVersion = (s) => /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(s) && !/(?:^|\.)0\d/.test(s);

/** Returns the list of problems (each: the line number and the field), empty when every token is allowed. */
export function validate(lines, vocabFiles) {
  const problems = [];
  const header = lines[0];
  if (!header || header.k !== 'shapes' || !Array.isArray(header.allowed)) return [{ line: 1, at: 'header' }];
  const L = language(vocabFiles, header.allowed);
  const kindOk = (k) => FIXED.has(k) || (L.VALUES.get(L.KIND.path)?.has(k)) || (() => { const i = k.indexOf(':'); if (i < 0) return false; const t = k.slice(0, i), s = k.slice(i + 1); const sp = L.KIND.sub.get(t); return !!sp && !!L.VALUES.get(L.KIND.path)?.has(t) && (s === '(unlisted)' || !!L.VALUES.get(sp)?.has(s)); })();
  const pathOk = (p) => L.P.has(p) || p === '.*' || (p.endsWith('.*') && L.P.has(p.slice(0, -2))) || (p.endsWith('[]') && L.P.has(p.slice(0, -2)));
  const anyValue = (s) => [...L.VALUES.values()].some((set) => set.has(s));
  lines.forEach((o, i) => {
    const bad = (at) => problems.push({ line: i + 1, at });
    const check = (v, key, ctx) => {
      if (typeof v === 'number') { if (!(['floor', 'paths', 'values', 'lines'].includes(key) && Number.isInteger(v))) bad(key); return; }
      if (typeof v === 'boolean' || v === null) { bad(key); return; }
      if (typeof v === 'string') {
        const ok = FIXED.has(v) || isBucket(v) || isVersion(v) || (key === 'name' && L.names.has(v)) || (key === 'sha256' && /^[0-9a-f]{12}$/.test(v))
          || (key === 'path' && pathOk(v)) || (key === 'kind' && kindOk(v)) || (ctx === 'allowed' && header.allowed.includes(v)) || key === 'format' && v === 'ltms-shapes/0';
        if (!ok) bad(key);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x) => check(x, key, key)); return; }
      for (const [k, x] of Object.entries(v)) {
        if (!(FIELDS.has(k) || FIXED.has(k) || isBucket(k) || isVersion(k) || (ctx === 'values' && anyValue(k)))) bad('a key');
        check(x, k, ctx === 'versions' || ctx === 'values' ? ctx : k);
      }
    };
    check(o, 'line', 'line');
  });
  const last = lines[lines.length - 1];
  if (!last || last.k !== 'end' || last.lines !== lines.length) problems.push({ line: lines.length, at: 'end' });
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [report, ...vocabs] = process.argv.slice(2);
  const lines = readFileSync(report, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const p = validate(lines, vocabs);
  process.stderr.write(p.length ? `validate: ${p.length} token(s) outside the language; first at line ${p[0].line} (${p[0].at}).\n` : `validate: ${lines.length} lines, every string and number in the language.\n`);
  process.exit(p.length ? 1 : 0);
}
