#!/usr/bin/env node
// test/shapes-recompute.mjs: a SECOND implementation of the ltms-shapes/0 report, written from the design's rules and
// not from the code of src/shapes.ts (it shares none): whole-file reads, a recursive walk, Sets of file numbers for the
// file counts, its own bucket arithmetic and class tests. It is the S373 prototype's recompute.mjs, its code unchanged
// below this header but for the changes listed here. It exists to check every field ltms shapes prints: both outputs,
// each line with its keys sorted, must be equal (test/shapes.test.mjs).
//
// Changed since the prototype, each with the rule it follows (S375, after S374's closure read):
//   - vOrder: versions equal as numbers (1.2.3, 01.2.3) are ordered by their text, not by where they were met (S4).
//   - isVersion: no part of more than one digit starts with 0 (U3); the class version follows it, as before.
//   - kindOf: a sub-kind gives (none) when the record has none there, (not a string) for another type (U14).
//
//   node test/shapes-recompute.mjs --vocabulary <v.json>... [--floor <n>] [--allow <spec>]... [--max-line <bytes>] <file>...
//   node test/shapes-recompute.mjs --canon <report.jsonl>      the same report, each line's keys sorted (to compare with)
import { readFileSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = { vocab: [], allow: [], floor: 3, maxLine: 64 * 1024 * 1024, files: [], canon: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--vocabulary') opt.vocab.push(args[++i]);
  else if (a === '--allow') opt.allow.push(args[++i]);
  else if (a === '--floor') opt.floor = Number(args[++i]);
  else if (a === '--max-line') opt.maxLine = Number(args[++i]);
  else if (a === '--canon') opt.canon = args[++i];
  else opt.files.push(a);
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
if (opt.canon) {
  for (const l of readFileSync(opt.canon, 'utf8').split('\n')) if (l) process.stdout.write(canonical(JSON.parse(l)) + '\n');
  process.exit(0);
}

// ---- the spec's rules, written again ----
const isPlainObject = (v) => Object.prototype.toString.call(v) === '[object Object]';
const fieldName = (k) => /^[$@]?[A-Za-z_][A-Za-z0-9_:+-]*$/.test(k) && k.length <= 64 + (/^[$@]/.test(k) ? 1 : 0);
const isLabel = (s) => s.length >= 1 && s.length <= 64 && /^[A-Za-z0-9_.:+-]+$/.test(s);
const isVersion = (s) => { const p = s.split('.'); return p.length === 3 && p.every((x, i) => /^[0-9]+$/.test(x) && x.length <= [4, 4, 6][i] && (x.length === 1 || x[0] !== '0')); };
function bucketOf(n) { if (n === 0) return '0'; if (n === 1) return '1'; const k = Math.floor(Math.log2(n)); const lo = 2 ** k; return lo + '-' + (2 * lo - 1); }
const cap = (n) => (n < 64 ? bucketOf(n) : '64+');
function strClass(s) {
  if (s.length === 0) return 'empty';
  const hex = (x) => /^[0-9A-Fa-f]+$/.test(x);
  const parts = s.split('-');
  if (parts.length === 5 && [8, 4, 4, 4, 12].every((len, i) => parts[i].length === len && hex(parts[i]))) return 'uuid';
  const dt = /^(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (dt) { if (dt[4] === 'Z' && dt[2] === 'T') return 'iso8601-utc'; if (dt[4] && dt[2] === 'T') return 'iso8601-offset'; if (!dt[4]) return 'iso8601-local'; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  if (isVersion(s)) return 'version';
  if (/^[0-9]+$/.test(s)) return 'digits';
  if (s.length >= 8 && hex(s)) return 'hex';
  if (isLabel(s)) return 'label';
  return 'text';
}
function numClass(x) {
  if (Math.floor(x) !== x) return 'float';
  if (x >= 946684800 && x < 4102444800) return 'epoch-s';
  if (x >= 946684800 * 1000 && x < 4102444800 * 1000) return 'epoch-ms';
  return 'int';
}
const jsonType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// ---- vocabulary ----
const P = new Set(), VALUES = {}, SUB = {}, VERSIONS = [], VLIST = [];
let KIND = null;
import { createHash } from 'node:crypto';
for (const f of opt.vocab) {
  const text = readFileSync(f, 'utf8'), v = JSON.parse(text);
  (v.paths || []).forEach((p) => P.add(p));
  let nv = 0;
  for (const p of Object.keys(v.values || {})) { VALUES[p] = VALUES[p] || new Set(); for (const x of v.values[p]) { VALUES[p].add(x); nv++; } }
  if (v.kinds) { KIND = v.kinds.path; Object.assign(SUB, v.kinds.sub || {}); }
  for (const p of v.versions || []) if (!VERSIONS.includes(p)) VERSIONS.push(p);
  VLIST.push({ name: v.name, sha256: createHash('sha256').update(text).digest('hex').slice(0, 12), paths: (v.paths || []).length, values: nv });
}
VLIST.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const allowed = [];
for (const s of opt.allow) {
  const [p, val] = s.includes('=') ? [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)] : [s, null];
  const segs = p.match(/\.[^.[]+|\[\]/g); let acc = '';
  for (const g of segs) { acc += g; P.add(acc); }
  if (val !== null) { VALUES[p] = VALUES[p] || new Set(); VALUES[p].add(val); }
  if (!allowed.includes(s)) allowed.push(s);
}
allowed.sort();
const getAt = (rec, path) => { let x = rec; for (const k of path.split('.').slice(1)) { if (!isPlainObject(x) || !Object.prototype.hasOwnProperty.call(x, k)) return undefined; x = x[k]; } return x; };

// ---- census ----
const files = [...new Set(opt.files)].sort();
let read = 0, failed = 0, records = 0, blank = 0, notJson = 0, notObject = 0, tooLong = 0;
const versions = {}, kinds = {}, lines = {};
const fset = (o, k, fi) => { o[k] = o[k] || { n: 0, files: new Set() }; o[k].n++; o[k].files.add(fi); return o[k]; };
function rec(kind, path, v, fi, ver, values) {
  const key = kind + '|' + path;
  const L = lines[key] || (lines[key] = { kind, path, n: 0, files: new Set(), vers: new Set(), groups: {}, names: null });
  L.n++; L.files.add(fi); L.vers.add(ver);
  const t = jsonType(v);
  const g = (name, label) => { L.groups[name] = L.groups[name] || {}; fset(L.groups[name], label, fi); };
  g('types', t);
  if (t === 'string') { g('strings', strClass(v)); if (values) g('values', values.has(v) ? v : '(unlisted)'); }
  if (t === 'number') g('numbers', numClass(v));
  if (t === 'boolean') g('booleans', v ? 'true' : 'false');
  if (t === 'array') g('lengths', cap(v.length));
  return L;
}
function visit(node, path, kind, fi, ver) {
  if (Array.isArray(node)) {
    const cp = path + '[]', named = P.has(cp);
    for (const el of node) { rec(kind, cp, el, fi, ver, named ? VALUES[cp] : null); if (named && el !== null && typeof el === 'object') visit(el, cp, kind, fi, ver); }
    return;
  }
  for (const k of Object.keys(node)) {
    const cp = path + '.' + k, v = node[k];
    if (fieldName(k) && P.has(cp)) { rec(kind, cp, v, fi, ver, VALUES[cp] || null); if (v !== null && typeof v === 'object') visit(v, cp, kind, fi, ver); }
    else { const L = rec(kind, path + '.*', v, fi, ver, null); L.names = L.names || new Set(); L.names.add(k); }
  }
}
function kindOf(r) {
  if (!KIND) return '(all)';
  const t = getAt(r, KIND);
  if (t === undefined) return '(none)';
  if (typeof t !== 'string') return '(not a string)';
  if (!(VALUES[KIND] && VALUES[KIND].has(t))) return '(unlisted)';
  if (!Object.prototype.hasOwnProperty.call(SUB, t)) return t;
  const s = getAt(r, SUB[t]);
  if (s === undefined) return t + ':(none)';
  if (typeof s !== 'string') return t + ':(not a string)';
  return VALUES[SUB[t]] && VALUES[SUB[t]].has(s) ? t + ':' + s : t + ':(unlisted)';
}
files.forEach((file, fi) => {
  let buf;
  try { buf = readFileSync(file); } catch { failed++; return; }
  read++;
  let ver = '(none)';
  const pieces = [];
  let s = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { pieces.push([s, i]); s = i + 1; }
  if (s < buf.length) pieces.push([s, buf.length]);
  for (const [a, b] of pieces) {
    if (b - a > opt.maxLine) { tooLong++; continue; }
    const text = buf.toString('utf8', a, b);
    if (text.trim() === '' && /^\s*$/.test(text)) { blank++; continue; }
    let r;
    try { r = JSON.parse(text); } catch { notJson++; continue; }
    if (!isPlainObject(r)) { notObject++; continue; }
    records++;
    for (const vp of VERSIONS) { const x = getAt(r, vp); if (x !== undefined) { ver = typeof x === 'string' && isVersion(x) ? x : '(withheld)'; break; } }
    const kind = kindOf(r);
    const K = kinds[kind] || (kinds[kind] = { n: 0, files: new Set(), vers: {} });
    K.n++; K.files.add(fi); K.vers[ver] = (K.vers[ver] || 0) + 1;
    fset(versions, ver, fi);
    visit(r, '', kind, fi, ver);
  }
});

// ---- the report ----
const F = opt.floor, out = [];
const vOrder = (a, b) => {
  const va = isVersion(a), vb = isVersion(b);
  if (va && vb) { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a < b ? -1 : a > b ? 1 : 0); }
  if (va !== vb) return va ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
out.push({ k: 'shapes', format: 'ltms-shapes/0', vocabulary: VLIST, floor: F, allowed, files: { read: bucketOf(read), failed: bucketOf(failed) }, lines: { records: bucketOf(records), blank: bucketOf(blank), notJson: bucketOf(notJson), notObject: bucketOf(notObject), tooLong: bucketOf(tooLong) } });
for (const v of Object.keys(versions).sort(vOrder)) out.push({ k: 'version', v, records: bucketOf(versions[v].n), files: bucketOf(versions[v].files.size) });
for (const kind of Object.keys(kinds).sort(str)) {
  const K = kinds[kind], vs = {};
  for (const v of Object.keys(K.vers).sort(vOrder)) vs[v] = bucketOf(K.vers[v]);
  out.push({ k: 'kind', kind, records: bucketOf(K.n), files: bucketOf(K.files.size), versions: vs });
}
const rare = {};
const ORDER_LEN = ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];
for (const L of Object.values(lines).sort((a, b) => str(a.kind, b.kind) || str(a.path, b.path))) {
  if (L.files.size < F) { rare[L.kind] = rare[L.kind] || { paths: 0, n: 0 }; rare[L.kind].paths++; rare[L.kind].n += L.n; continue; }
  const o = { k: 'path', kind: L.kind, path: L.path, n: bucketOf(L.n), files: bucketOf(L.files.size) };
  const vs = [...L.vers].filter(isVersion).sort(vOrder);
  if (vs.length) { o.first = vs[0]; o.last = vs[vs.length - 1]; }
  for (const gname of ['types', 'strings', 'numbers', 'booleans', 'lengths', 'values']) {
    const grp = L.groups[gname]; if (!grp) continue;
    const m = {}; let rareN = 0;
    for (const [label, c] of Object.entries(grp)) { if (c.files.size >= F) m[label] = c.n; else rareN += c.n; }
    const keys = Object.keys(m).sort(gname === 'lengths' ? (a, b) => ORDER_LEN.indexOf(a) - ORDER_LEN.indexOf(b) : str);
    const res = {}; for (const k of keys) res[k] = bucketOf(m[k]);
    if (rareN) res['(rare)'] = bucketOf(rareN);
    o[gname] = res;
  }
  if (L.names) o.names = cap(L.names.size);
  out.push(o);
}
for (const kind of Object.keys(rare).sort(str)) out.push({ k: 'rare', kind, paths: bucketOf(rare[kind].paths), n: bucketOf(rare[kind].n) });
out.push({ k: 'end', lines: out.length + 1 });
for (const o of out) process.stdout.write(canonical(o) + '\n');
