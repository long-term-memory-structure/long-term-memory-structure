#!/usr/bin/env node
// test/shapes-validate.mjs: an INDEPENDENT validator of the ltms-shapes/0 closed language, the receiver's check. It
// shares no code with src/shapes.ts (the writer and its --check): it is the S373 prototype's validate.mjs, its code
// unchanged below this header but for the changes listed here. It reads every string and every number in a report and
// asks only: is this token one the language allows where it stands? The fixed words, a bucket, an N.N.N version, a
// vocabulary path (or one .* / [] step past one), a vocabulary value or kind, a name the header's allowed list holds.
//
// Changed since the prototype, each with the rule it follows (S375, after S374's closure read):
//   - isVersion: no part of more than one digit starts with 0 (U3).
//   - kindOk: a sub-kind may also be (none) or (not a string), and a kind whose sub-kind the vocabulary names never
//     stands alone (U14).
//   - The report whole, as --check holds it (S3, U6), each rule written here again from the format, not from the
//     writer's code: the first line's vocabulary entry is the file's (its name, the first 12 hex digits of its sha256,
//     how many paths and values it lists); its floor a whole number from 2 to 2^53 - 1; its allowed list --allow
//     arguments, sorted, each once; each line's fields those of its kind, in the format's order, each holding what its
//     field admits (a bucket where a count stands), and each map's keys those its field admits, in the writer's order; a
//     number only at the floor, the vocabulary's two counts and the end line's count; one first line, line 1; the line
//     kinds in the format's order, and each kind's lines strictly in the writer's order, so none repeats; a path line in
//     at least the floor's files; one end line, the last, counting the lines. language() no longer throws on an allowed
//     entry that is no --allow argument (validate reports it).
//   - validateText: the bytes too, which JSON.parse does not see: no byte-order mark, no blank line, and each line
//     exactly JSON.stringify of what it parses to (a key given twice, a space, an escape, a carriage return or another
//     spelling of a number fails). The command line uses it, so it no longer drops blank lines.
// Changed for 0.3.1, after S375's known issues:
//   - kindOk: a kind is one of the format's four words for a kind, a kind the vocabulary or the allowed list puts at the
//     kind path, or kind:sub, and no other word of the format, at a line's kind field and as the line's own check (k4).
//   - A path line: a first version with a last, and a last with a first; the first not later than the last; n in no
//     lower bucket than files, since each file a path occurs in holds it once at least (k10).
//   node test/shapes-validate.mjs <report.jsonl> <vocabulary.json>...     exit 0 when every token is allowed
import { pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** An --allow argument, by the rules --allow takes: a path of names and [] steps; a value by the label rule, and at the
 *  kind path or a sub-kind's path, one without ':'. */
function isAllowArg(s, KIND) {
  if (typeof s !== 'string') return false;
  const i = s.indexOf('='), p = i < 0 ? s : s.slice(0, i), val = i < 0 ? null : s.slice(i + 1);
  if (!/^(?:\.[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63}|\[\])+$/.test(p)) return false;
  return val === null || (/^[A-Za-z0-9_.:+-]{1,64}$/.test(val) && !(val.includes(':') && [KIND.path, ...KIND.sub.values()].includes(p)));
}

export function language(vocabFiles, allowed) {
  const P = new Set(), VALUES = new Map(), KIND = { path: null, sub: new Map() }, names = new Set(), entries = [];
  for (const f of vocabFiles) {
    const bytes = readFileSync(f), v = JSON.parse(bytes.toString('utf8'));
    names.add(v.name);
    entries.push({ name: v.name, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 12), paths: v.paths.length, values: Object.values(v.values ?? {}).reduce((a, vs) => a + vs.length, 0) });
    v.paths.forEach((p) => P.add(p));
    for (const [p, vs] of Object.entries(v.values ?? {})) { if (!VALUES.has(p)) VALUES.set(p, new Set()); vs.forEach((x) => VALUES.get(p).add(x)); }
    if (v.kinds) { KIND.path = v.kinds.path; for (const [t, s] of Object.entries(v.kinds.sub ?? {})) KIND.sub.set(t, s); }
  }
  for (const s of allowed) {
    if (!isAllowArg(s, KIND)) continue;
    const [p, val] = s.includes('=') ? [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)] : [s, null];
    let acc = ''; for (const g of p.match(/\.[^.[]+|\[\]/g)) { acc += g; P.add(acc); }
    if (val) { if (!VALUES.has(p)) VALUES.set(p, new Set()); VALUES.get(p).add(val); }
  }
  return { P, VALUES, KIND, names, entries };
}
const FIELDS = new Set(['k', 'format', 'vocabulary', 'name', 'sha256', 'paths', 'values', 'floor', 'allowed', 'files', 'read', 'failed', 'lines', 'records', 'blank', 'notJson', 'notObject', 'tooLong', 'v', 'kind', 'versions', 'path', 'n', 'first', 'last', 'types', 'strings', 'numbers', 'booleans', 'lengths', 'names']);
const FIXED = new Set(['shapes', 'version', 'kind', 'path', 'rare', 'end', 'ltms-shapes/0', '(rare)', '(unlisted)', '(none)', '(withheld)', '(not a string)', '(all)', '64+',
  'array', 'boolean', 'null', 'number', 'object', 'string', 'empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'version', 'digits', 'hex', 'label', 'text', 'int', 'float', 'epoch-s', 'epoch-ms', 'true', 'false']);
export const isBucket = (s) => s === '0' || s === '1' || ((m) => !!m && Number(m[1]) >= 2 && Number.isInteger(Math.log2(Number(m[1]))) && Number(m[2]) === 2 * Number(m[1]) - 1)(/^(\d+)-(\d+)$/.exec(s));
const isVersion = (s) => /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(s) && !/(?:^|\.)0\d/.test(s);

// ---- the report whole (S3, U6): the format's fields and orders, as a receiver reads them ----
/** Each line kind's fields, in the format's order; a path line has the first five always. The keys: the line kinds, in
 *  the order a report gives them. */
const LINE = {
  shapes: ['k', 'format', 'vocabulary', 'floor', 'allowed', 'files', 'lines'],
  version: ['k', 'v', 'records', 'files'],
  kind: ['k', 'kind', 'records', 'files', 'versions'],
  path: ['k', 'kind', 'path', 'n', 'files', 'first', 'last', 'types', 'strings', 'numbers', 'booleans', 'lengths', 'values', 'names'],
  rare: ['k', 'kind', 'paths', 'n'],
  end: ['k', 'lines'],
};
const ORDER = Object.keys(LINE);
const CAP = ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];
/** What each of a path line's maps admits as a key, (rare) aside (values: the vocabulary's at its path). */
const GROUP = {
  types: ['array', 'boolean', 'null', 'number', 'object', 'string'],
  strings: ['empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'version', 'digits', 'hex', 'label', 'text'],
  numbers: ['int', 'float', 'epoch-s', 'epoch-ms'],
  booleans: ['false', 'true'],
  lengths: CAP,
};
const str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isVersionToken = (v) => typeof v === 'string' && (isVersion(v) || v === '(none)' || v === '(withheld)');
/** Versions in numeric order, equal numbers by their text; then (none) and (withheld), by their text. */
const vOrder = (a, b) => {
  const va = isVersion(a), vb = isVersion(b);
  if (va && vb) { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || str(a, b); }
  return va !== vb ? (va ? -1 : 1) : str(a, b);
};
/** A map's keys: (rare) last; lengths by their buckets' order; any other by its text. */
const keyOrder = (g) => (a, b) => (a === '(rare)') - (b === '(rare)') || (g === 'lengths' ? CAP.indexOf(a) - CAP.indexOf(b) : str(a, b));
/** Two lines of one kind, by their key: versions by v; kind and rare lines by kind; path lines by kind, then path. */
const lineOrder = (a, b) => (a.k === 'version' ? vOrder(a.v, b.v) : a.k === 'path' ? str(a.kind, b.kind) || str(a.path, b.path) : str(a.kind, b.kind));
/** Keys in this order, as JavaScript lists an object's keys (whole numbers first): the order a writer's map has. */
const asListed = (keys) => Object.keys(Object.fromEntries(keys.map((k) => [k, 0])));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The largest count a bucket stands for, and the least. */
const top = (b) => Number(b.slice(b.indexOf('-') + 1));
const bottom = (b) => Number(b.split('-')[0]);

/** Returns the list of problems (each: the line number and the field), empty when every token is allowed. */
export function validate(lines, vocabFiles) {
  const problems = [];
  const header = lines[0];
  if (!header || header.k !== 'shapes' || !Array.isArray(header.allowed)) return [{ line: 1, at: 'header' }];
  const L = language(vocabFiles, header.allowed);
  // a kind, at a line's kind field (the walk) and as the line's own check: the format's four words for a kind, wherever a
  // kind stands; a kind the vocabulary or the allowed list puts at the kind path, that has no sub-kind's path; or
  // kind:sub, sub being (unlisted), (none), (not a string) or a value at that kind's sub-kind path. No other word of the
  // format (S375's known issue k4)
  const kindOk = (k) => typeof k === 'string' && (['(unlisted)', '(none)', '(not a string)', '(all)'].includes(k) || (!!L.VALUES.get(L.KIND.path)?.has(k) && !L.KIND.sub.has(k)) || (() => { const i = k.indexOf(':'); if (i < 0) return false; const t = k.slice(0, i), s = k.slice(i + 1); const sp = L.KIND.sub.get(t); return !!sp && !!L.VALUES.get(L.KIND.path)?.has(t) && (['(unlisted)', '(none)', '(not a string)'].includes(s) || !!L.VALUES.get(sp)?.has(s)); })());
  const pathOk = (p) => L.P.has(p) || p === '.*' || (p.endsWith('.*') && L.P.has(p.slice(0, -2))) || (p.endsWith('[]') && L.P.has(p.slice(0, -2)));
  const anyValue = (s) => [...L.VALUES.values()].some((set) => set.has(s));
  const floor = Number.isSafeInteger(header.floor) && header.floor >= 2 ? header.floor : null;
  const own = [];   // per line: did it pass its own checks (its place is checked below only then)
  lines.forEach((o, i) => {
    const before = problems.length;
    const bad = (at) => problems.push({ line: i + 1, at });
    const check = (v, key, ctx) => {
      if (typeof v === 'number') {
        // a number stands only at the first line's floor and its vocabulary's counts, and at the end line's count
        const ok = Number.isInteger(v) && ((i === 0 && (key === 'floor' || (ctx === 'vocabulary' && (key === 'paths' || key === 'values')))) || (o.k === 'end' && key === 'lines'));
        if (!ok) bad(key);
        return;
      }
      if (typeof v === 'boolean' || v === null) { bad(key); return; }
      if (typeof v === 'string') {
        // at a line's kind field, a kind and nothing else; anywhere else, any token of the language that may stand there
        const ok = key === 'kind' && ctx === 'kind' ? kindOk(v) : FIXED.has(v) || isBucket(v) || isVersion(v) || (key === 'name' && L.names.has(v)) || (key === 'sha256' && /^[0-9a-f]{12}$/.test(v))
          || (key === 'path' && pathOk(v)) || (ctx === 'allowed' && header.allowed.includes(v)) || key === 'format' && v === 'ltms-shapes/0';
        if (!ok) bad(key);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x) => check(x, key, key)); return; }
      for (const [k, x] of Object.entries(v)) {
        if (!(FIELDS.has(k) || FIXED.has(k) || isBucket(k) || isVersion(k) || (ctx === 'values' && anyValue(k)))) bad('a key');
        check(x, k, ctx === 'versions' || ctx === 'values' || ctx === 'vocabulary' ? ctx : k);
      }
    };
    check(o, 'line', 'line');
    if (!isObj(o)) bad('line');
    else if (Object.hasOwn(LINE, o.k)) {
      // its fields: those of its kind, in the format's order, each holding what it admits
      const order = LINE[o.k], keys = Object.keys(o);
      if (!(o.k === 'path' ? order.slice(0, 5) : order).every((f) => keys.includes(f)) || !sameList(keys, order.filter((f) => keys.includes(f)))) bad('fields');
      const counts = { version: ['records', 'files'], kind: ['records', 'files'], path: ['n', 'files'], rare: ['paths', 'n'] }[o.k] ?? [];
      for (const f of counts) if (!isBucket(o[f])) bad(f);
      if (o.k === 'shapes') {
        if (o.format !== 'ltms-shapes/0') bad('format');
        if (JSON.stringify(o.vocabulary) !== JSON.stringify(L.entries)) bad('vocabulary');
        if (floor === null) bad('floor');
        if (!o.allowed.every((s) => isAllowArg(s, L.KIND)) || !sameList(o.allowed, [...new Set(o.allowed)].sort())) bad('allowed');
        for (const [f, ks] of [['files', ['read', 'failed']], ['lines', ['records', 'blank', 'notJson', 'notObject', 'tooLong']]]) {
          if (!isObj(o[f]) || !sameList(Object.keys(o[f]), ks) || !Object.values(o[f]).every(isBucket)) bad(f);
        }
      }
      if (o.k === 'version' && !isVersionToken(o.v)) bad('v');
      if (['kind', 'path', 'rare'].includes(o.k) && !kindOk(o.kind)) bad('kind');
      if (o.k === 'kind') {
        const ks = isObj(o.versions) ? Object.keys(o.versions) : null;
        if (!ks || !ks.every(isVersionToken) || !Object.values(o.versions).every(isBucket) || !sameList(ks, asListed([...ks].sort(vOrder)))) bad('versions');
      }
      if (o.k === 'path') {
        if (typeof o.path !== 'string' || !pathOk(o.path)) bad('path');
        for (const f of ['first', 'last']) if (Object.hasOwn(o, f) && !isVersion(o[f])) bad(f);
        // what the line says of itself (k10): a first version with a last and a last with a first, the first not later
        // than the last; and n no fewer than files, which the buckets decide when n's is below files'
        if (Object.hasOwn(o, 'first') !== Object.hasOwn(o, 'last')) bad(Object.hasOwn(o, 'first') ? 'first without last' : 'last without first');
        else if (isVersion(o.first) && isVersion(o.last) && vOrder(o.first, o.last) > 0) bad('first after last');
        if (isBucket(o.n) && isBucket(o.files) && top(o.n) < bottom(o.files)) bad('n under files');
        for (const g of [...Object.keys(GROUP), 'values']) {
          if (!Object.hasOwn(o, g)) continue;
          const vs = g === 'values' ? L.VALUES.get(o.path) : null;
          const admits = (k) => k === '(rare)' || (g === 'values' ? !!vs && (k === '(unlisted)' || vs.has(k)) : GROUP[g].includes(k));
          const ks = isObj(o[g]) ? Object.keys(o[g]) : null;
          if (!ks || (g === 'values' && !vs) || !ks.every(admits) || !Object.values(o[g]).every(isBucket) || !sameList(ks, asListed([...ks].sort(keyOrder(g))))) bad(g);
        }
        if (Object.hasOwn(o, 'names') && (typeof o.path !== 'string' || !o.path.endsWith('.*') || !CAP.includes(o.names))) bad('names');
      }
      if (o.k === 'end' && !Number.isInteger(o.lines)) bad('lines');
    } else bad('k');
    own.push(problems.length === before);
  });
  // each line that passed its own checks, in its place
  let prev = null;
  lines.forEach((o, i) => {
    if (!own[i]) return;
    const at = (w) => problems.push({ line: i + 1, at: w });
    if (i === 0) { prev = o; return; }
    if (o.k === 'shapes') return at('a second first line');
    if (o.k === 'end' && i !== lines.length - 1) return at('an end line before the last');
    const d = prev === null ? 1 : ORDER.indexOf(o.k) - ORDER.indexOf(prev.k);
    const c = d === 0 ? lineOrder(prev, o) : 0;
    if (d < 0 || c > 0) return at('order');
    if (d === 0 && c === 0) return at('repeat');
    if (o.k === 'path' && floor !== null && top(o.files) < floor) return at('under the floor');
    prev = o;
  });
  const last = lines[lines.length - 1];
  if (!last || last.k !== 'end' || last.lines !== lines.length) problems.push({ line: lines.length, at: 'end' });
  return problems;
}

/** The report's text: its bytes, then validate(). A line is exactly JSON.stringify of what it parses to, or a problem
 *  (a key given twice, a space, an escape, a carriage return, another spelling of a number); a blank line and a
 *  byte-order mark are problems. */
export function validateText(text, vocabFiles) {
  const problems = [];
  if (text.charCodeAt(0) === 0xfeff) { problems.push({ line: 1, at: 'a byte-order mark' }); text = text.slice(1); }
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const lines = rows.map((r, i) => {
    if (/^\s*$/.test(r)) { problems.push({ line: i + 1, at: 'a blank line' }); return null; }
    let o;
    try { o = JSON.parse(r); } catch { problems.push({ line: i + 1, at: 'not JSON' }); return null; }
    if (JSON.stringify(o) !== r) problems.push({ line: i + 1, at: 'its bytes' });
    return o;
  });
  return [...problems, ...validate(lines, vocabFiles)];
}

// run as a script: the URL of the script's real path, so a folder whose name has a space (%20 in the URL) or a link to
// the script is not taken for an import, which ran nothing and exited 0 (S375, G3's new issue)
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [report, ...vocabs] = process.argv.slice(2);
  const text = readFileSync(report, 'utf8');
  const p = validateText(text, vocabs);
  const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  process.stderr.write(p.length ? `validate: ${p.length} token(s) outside the language; first at line ${p[0].line} (${p[0].at}).\n` : `validate: ${n} lines, every string and number in the language.\n`);
  process.exit(p.length ? 1 : 0);
}
