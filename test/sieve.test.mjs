// The sieves (search.ts, section 10; sieve-cache.ts; ltms search --cache), S366: the experiment's tests.
//  1. The library: a sieve never rules out a file the search finds a turn in (no false negative), and its counts are
//     the search's, on every fixture, for every word and many substrings of its text, by kind; and each defect class
//     the S366 mutation runs found (the escape-decoded form, a reading joined across a line next to a non-ASCII line,
//     the kinds, the gap letters, records with no text) by a case built for it.
//  2. The command: off unless asked; with --cache the output is the output without it (the time and the closing
//     line's sentence aside), cold and warm; a changed file is read again; a damaged or foreign sieve is passed over;
//     a cache directory others can write to is not used; files named are always read.
// Every string outside ASCII is built from code points, never typed. Synthetic sessions, invented text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
// ltms runs below with the cache off (LTMS_CACHE unset), and any sieve in a directory of this file's own, removed at exit
{ const { mkdtempSync: m, rmSync: r } = await import('node:fs'); const { tmpdir: d } = await import('node:os'); const c = m((await import('node:path')).join(d(), 'ltms-test-cache-')); process.env.XDG_CACHE_HOME = c; delete process.env.LTMS_CACHE; process.on('exit', () => r(c, { recursive: true, force: true })); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'dist', 'cli.js');
const FIX = join(root, 'test', 'fixtures');
const P = await import(join(root, 'dist', 'parser.js'));
const S = await import(join(root, 'dist', 'search.js'));
const SEG = S.checkSearchSupport().segmenter;
const cp = (...c) => String.fromCodePoint(...c);
const BSL = String.fromCharCode(92);
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-sieve-'));
const rm = (d) => rmSync(d, { recursive: true, force: true });

// ---- helpers ------------------------------------------------------------------------------------------------

const uuidN = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A session: [prompt, reply] turns; a reply is a string or a content array; after(k) adds records after turn k. */
function sessionWith(turns, { after = () => [] } = {}) {
  const recs = [];
  let parent = null;
  const stamp = () => ({ timestamp: new Date(Date.parse('2026-05-01T00:00:00.000Z') + 1000 * (recs.length + 1)).toISOString() });
  turns.forEach(([prompt, reply], k) => {
    const u = uuidN(recs.length + 1);
    recs.push({ type: 'user', uuid: u, parentUuid: parent, promptSource: 'typed', ...stamp(), message: { role: 'user', content: prompt } });
    const a = uuidN(recs.length + 1);
    recs.push({ type: 'assistant', uuid: a, parentUuid: u, requestId: `req_${recs.length + 1}`, ...stamp(), message: { role: 'assistant', content: typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply } });
    parent = a;
    for (const r of after(k)) { const id = uuidN(recs.length + 1); recs.push({ uuid: id, parentUuid: parent, ...stamp(), ...r }); parent = id; }
  });
  recs.push({ type: 'last-prompt', leafUuid: parent });
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
/** Every string value under a record, depth first. */
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) stringsOf(v[k], out);
  return out;
}
const ESC = new RegExp(BSL + BSL + '(?:([ntrbf"/' + BSL + BSL + '])|u([0-9A-Fa-f]{4}))', 'g');
const SHORT = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '/': '/', [BSL]: BSL };
const decoded = (s) => s.replace(ESC, (m, a, u) => (a !== undefined ? SHORT[a] : String.fromCharCode(parseInt(u, 16))));
/** The strings of a transcript's records, as written and decoded. */
function textsOf(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    for (const s of stringsOf(r)) { out.push(s); if (s.includes(BSL)) out.push(decoded(s)); }
  }
  return out;
}
const strip = ({ hits, ...rest }) => JSON.stringify(rest);
/** Check one query against one file: no false negative (whole query, and each found term in each hit entry's kind),
 *  and the sieve's counts are the search's, for `kinds`. Returns whether the search found a turn. */
function agree(t, s, q, kinds, where) {
  const r = S.searchTranscript(t, q, { kinds });
  const sr = S.sieveResult(s, q, kinds);
  assert.equal(strip(sr.counts), strip(r.counts), `${where}: counts`);
  assert.deepEqual([sr.last, sr.fileKind], [r.last, r.fileKind], `${where}: last, fileKind`);
  if (!r.turns.length) return false;
  assert.ok(S.sieveMayHold(s, q, kinds), `${where}: a file with ${r.turns.length} matching turns was ruled out`);
  for (const h of r.turns) for (const e of h.entries) for (const w of e.w)
    assert.ok(S.sieveMayHold(s, { ...q, terms: [q.terms[w]] }, [e.kind]), `${where}: term '${q.terms[w].text}' found in ${e.a} (${e.kind}) was ruled out for that kind`);
  return true;
}
const fixtures = () => readdirSync(FIX).filter((f) => f.endsWith('.jsonl')).sort();

// ---- 1. the library ----------------------------------------------------------------------------------------

test('sieve: on every fixture, every word of its strings (as written and decoded) as a query: never ruled out where found, and the counts are the search\'s, in all kinds and in each kind', () => {
  let queries = 0, found = 0;
  for (const name of fixtures()) {
    const text = readFileSync(join(FIX, name), 'utf8');
    const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
    const words = [...new Set(textsOf(text).flatMap((x) => S.tokenizeForSearch(x).map((k) => k.token)))].sort().slice(0, 600);
    for (const w of words) {
      const q = S.parseSearchQuery(w, { segmenter: SEG });
      if (!q.terms.length) continue;
      queries++;
      if (agree(t, s, q, S.SEARCH_KINDS, `${name} '${w}'`)) found++;
    }
    const q = S.parseSearchQuery(words[0] ?? 'x', { segmenter: SEG });
    for (const k of S.SEARCH_KINDS) agree(t, s, q, [k], `${name} kind ${k}`);
    agree(t, s, q, S.SEARCH_DEFAULT_KINDS, `${name} default kinds`);
  }
  assert.ok(queries > 2000 && found > 1000, `the population: ${queries} queries, ${found} found`);
});

test('sieve: on every fixture, substrings of its strings\' readings (1 to 7 code units, across their spaces too) in --substring: never ruled out where found', () => {
  let queries = 0, found = 0;
  for (const name of fixtures()) {
    const text = readFileSync(join(FIX, name), 'utf8');
    const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
    const seen = new Set();
    for (const x of textsOf(text)) {
      const r = S.normalizeForSearch(x);
      for (let i = 0; i < r.length && seen.size < 1500; i += 5) {
        const term = r.slice(i, i + 1 + (i % 7)).trim();
        if (!term || seen.has(term)) continue;
        seen.add(term);
        const q = S.parseSearchQuery(term, { mode: 'substring', segmenter: SEG });
        if (!q.terms.length) continue;
        queries++;
        if (agree(t, s, q, S.SEARCH_KINDS, `${name} --substring '${term}'`)) found++;
      }
    }
  }
  assert.ok(queries > 2000 && found > 1500, `the population: ${queries} queries, ${found} found`);
});

test('sieve: a word that is only in a string\'s escape-decoded form (after a backslash-n, and a backslash-u Hebrew word) is never ruled out [S366 M7]', () => {
  const heb = cp(0x5d6, 0x5e7, 0x5e4, 0x5e6);   // invented
  const esc = [...heb].map((c) => BSL + 'u0' + c.codePointAt(0).toString(16)).join('');
  const text = sessionWith([['look', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `printf x${BSL}nzqvescword and ${esc}` } }]]]);
  const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
  for (const w of ['zqvescword', heb]) {
    const q = S.parseSearchQuery(w, { segmenter: SEG });
    assert.equal(S.searchTranscript(t, q).turns.length, 1, `the search finds '${w}' decoded`);
    assert.ok(agree(t, s, q, S.SEARCH_DEFAULT_KINDS, w));
  }
});

test('sieve: a --substring term across a line break, where the next line holds a non-ASCII letter, is never ruled out [S366 M6]', () => {
  const heb = cp(0x5e9, 0x5dc, 0x5d5, 0x5dd);
  for (const reply of [`zqvlast\n${heb} zqvnext`, `${heb} zqvlast\nzqvnext`, `zqvlast\n${heb}`]) {
    const text = sessionWith([['look', reply]]);
    const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
    const second = S.normalizeForSearch(reply.split('\n')[1]).slice(0, 4);
    // quoted: one term that crosses the line break (unquoted, it would be two terms, and nothing would cross it)
    const q = S.parseSearchQuery(`"last ${second}"`, { mode: 'substring', segmenter: SEG });
    assert.equal(q.terms.length, 1);
    assert.equal(S.searchTranscript(t, q).turns.length, 1, `the search finds 'last ${second}'`);
    assert.ok(agree(t, s, q, S.SEARCH_DEFAULT_KINDS, JSON.stringify(reply)));
  }
});

test('sieve: a word is tagged with its kind: in thinking only, it is ruled out for reply and kept for thinking, as the search finds it', () => {
  const text = sessionWith([['look', [{ type: 'thinking', thinking: 'zqvthinkword here', signature: 's' }, { type: 'text', text: 'nothing' }]]]);
  const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG), q = S.parseSearchQuery('zqvthinkword', { segmenter: SEG });
  assert.equal(S.sieveMayHold(s, q, ['reply']), false);
  assert.equal(S.searchTranscript(t, q, { kinds: ['reply'] }).turns.length, 0);
  assert.equal(S.sieveMayHold(s, q, ['thinking']), true);
  assert.ok(agree(t, s, q, ['thinking'], 'thinking'));
  agree(t, s, q, ['reply'], 'reply');
});

test('sieve: the gap scripts\' letters are counted as the search counts them, in a string with escapes (its decoded form) and by kind [S366 M3]', () => {
  const heb = cp(0x5d1, 0x5d9, 0x5ea), ar = cp(0x643, 0x62a, 0x627, 0x628), han = cp(0x5317, 0x4eac);
  const esc = [...heb].map((c) => BSL + 'u0' + c.codePointAt(0).toString(16)).join('');
  const text = sessionWith([[`${heb} ${ar}`, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `echo ${esc} ${han}` } }, { type: 'text', text: `${heb}${heb}` }]]]);
  const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
  for (const query of [heb, ar, han, `${heb} ${ar}`]) {
    const q = S.parseSearchQuery(query, { segmenter: SEG });
    assert.ok(q.gapScripts.length > 0);
    for (const kinds of [S.SEARCH_DEFAULT_KINDS, ['call'], ['reply'], ['input']]) agree(t, s, q, kinds, `${query} ${kinds}`);
  }
});

test('sieve: records with no text are counted as searched, as the search counts them, whatever the kinds [S366 M4]', () => {
  const text = sessionWith([['hello', 'ok']], { after: () => [{ type: 'attachment', attachment: { type: '', content: '' } }, { type: 'system', subtype: 'turn_duration', durationMs: 5 }] });
  const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG), q = S.parseSearchQuery('zqvabsent', { segmenter: SEG });
  for (const kinds of [S.SEARCH_DEFAULT_KINDS, S.SEARCH_KINDS, ['reply'], ['meta']]) agree(t, s, q, kinds, String(kinds));
  assert.ok(S.sieveTranscript(t, SEG).masks.some(([m]) => m === 0), 'a record with no text is in the set 0');
});

test('sieve: folding (case, full-width letters, a ligature, marks, final sigma) and spaceless scripts: what the search finds is never ruled out', () => {
  const full = cp(0xff31, 0xff35, 0xff2f, 0xff2b, 0xff2b, 0xff21);   // QUOKKA, full width
  const lig = 'zqv' + cp(0xfb01) + 'nd';                               // zqv + fi ligature + nd
  const pointed = cp(0x5e9, 0x5c1, 0x5b8, 0x5dc, 0x5d5, 0x5b9, 0x5dd);   // a pointed Hebrew word
  const sigma = cp(0x3bb, 0x3bf, 0x3b3, 0x3bf, 0x3c2);
  const thai = cp(0xe20, 0xe32, 0xe29, 0xe32, 0xe44, 0xe17, 0xe22), zh = cp(0x5317, 0x4eac, 0x5927, 0x5b66);
  const text = sessionWith([[`${full} ${lig}`, `${pointed} ${sigma.toUpperCase()} ${thai}${zh}`]]);
  const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
  for (const query of ['quokka', 'QUOKKA', 'zqvfind', cp(0x5e9, 0x5dc, 0x5d5, 0x5dd), sigma, thai, zh, cp(0x5317, 0x4eac)]) {
    for (const mode of ['words', 'substring']) {
      const q = S.parseSearchQuery(query, { mode, segmenter: SEG });
      agree(t, s, q, S.SEARCH_DEFAULT_KINDS, `${mode} ${query}`);
    }
  }
  assert.equal(S.searchTranscript(t, S.parseSearchQuery('quokka', { segmenter: SEG })).turns.length, 1, 'the folded word is found');
});

test('sieve: a sieve of another format, or one read with another segmenter (words mode), never rules a file out', () => {
  const text = sessionWith([['hello', 'world']]);
  const t = P.parseTranscript(text), s = S.sieveTranscript(t, SEG);
  const q = S.parseSearchQuery('zqvabsent', { segmenter: SEG });
  assert.equal(S.sieveMayHold(s, q), false);
  assert.equal(S.sieveMayHold({ ...s, format: s.format + 1 }, q), true);
  const other = S.sieveTranscript(t, SEG === 'icu' ? 'no-dictionary' : 'icu');
  assert.equal(S.sieveMayHold(other, q), true, 'words mode, another segmenter');
  assert.equal(S.sieveMayHold(other, S.parseSearchQuery('zqvabsent', { mode: 'substring', segmenter: SEG })), false, '--substring reads no segmenter');
});

// ---- 2. the command ----------------------------------------------------------------------------------------

/** ltms with an environment of its own: the cache in `cache` (XDG_CACHE_HOME), LTMS_CACHE as given; `node`, options
 *  for node itself (a preload). */
function ltms(args, { cache, env = {}, node = [] } = {}) {
  const e = { ...process.env, XDG_CACHE_HOME: cache, ...env };
  if (!('LTMS_CACHE' in env)) delete e.LTMS_CACHE;
  const r = spawnSync(process.execPath, [...node, CLI, ...args], { encoding: 'utf8', timeout: 60000, env: e, maxBuffer: 1 << 26 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** stdout without the coverage line's ms; stderr without the closing line's sentence about the sieves. */
const same = (r) => ({ code: r.code, out: r.out.replace(/,"ms":\d+\}/, '}'), err: r.err.replace(/ The sieves in .*? \(--no-cache opens every file\)\./, '') });
const sieveFiles = (cache) => { try { return readdirSync(join(cache, 'ltms', 'sieves')).filter((f) => f.endsWith('.sieve')); } catch { return []; } };
const answered = (r) => Number((/answered (\d+) of/.exec(r.err) ?? [])[1]);
/** The files of a folder whose sieve rules the query out, by the library alone (no cache): what --cache, warm, must
 *  answer unopened. A Bloom filter's false positive makes a file be read, so this is not always every file. */
function ruledOut(d, query, mode = 'words', kinds = S.SEARCH_DEFAULT_KINDS) {
  const q = S.parseSearchQuery(query, { mode, segmenter: SEG });
  return readdirSync(d).filter((f) => !S.sieveMayHold(S.sieveTranscript(P.parseTranscript(readFileSync(join(d, f), 'utf8')), SEG), q, kinds)).length;
}
/** The files of d given a modification time an hour ago, as the files of sessions that have ended: a file modified in the
 *  last five minutes gets no sieve (S367, G2). */
function settle(d) {
  const past = new Date(Date.now() - 3600e3);
  for (const f of readdirSync(d)) utimesSync(join(d, f), past, past);
  return d;
}
/** A folder of fixture copies (a journal, an empty file, unreadable lines, a cycle, compactions) and two sessions, settled. */
function corpus() {
  const d = tmp();
  for (const f of ['demo.jsonl', 'compacted.jsonl', 'journal.jsonl', 'empty.jsonl', 'errors.jsonl', 'cycle.jsonl', 'labels.jsonl', 'edges.jsonl', 'content.jsonl']) copyFileSync(join(FIX, f), join(d, f));
  writeFileSync(join(d, 'a.jsonl'), sessionWith([['zqvalpha one', 'two'], ['three', `zqvbeta ${cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)}`]]));
  writeFileSync(join(d, 'b.jsonl'), sessionWith([['four', 'zqvalpha five']]));
  return settle(d);
}
const QUERIES = [['zqvalpha'], ['zqvbeta'], ['zqvabsent'], ['--substring', 'qvalph'], ['--kind', 'all', 'the'], ['--kind', 'input', 'zqvalpha'], ['"zqvalpha one"'], [cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)]];

test('command: the cache is off unless asked: no directory is made, and the output is 0.2.0\'s', () => {
  const d = corpus(), cache = tmp();
  try {
    const r = ltms(['search', 'zqvalpha', d], { cache });
    assert.equal(r.code, 0);
    assert.deepEqual(readdirSync(cache), []);
    assert.doesNotMatch(r.err, /The sieves in|no sieve is kept/);
  } finally { rm(d); rm(cache); }
});

test('command: --cache prints what a search without it prints, cold and warm, for every query (the time and the closing sentence aside); warm, the files without a hit are answered unopened', () => {
  const d = corpus(), cache = tmp();
  try {
    for (const q of QUERIES) {
      const args = ['search', '--max', '0', ...q, d];
      const plain = same(ltms(args, { cache }));
      const cold = ltms(['search', '--cache', '--max', '0', ...q, d], { cache });
      const warm = ltms(['search', '--cache', '--max', '0', ...q, d], { cache });
      assert.deepEqual(same(cold), plain, `cold: ${q}`);
      assert.deepEqual(same(warm), plain, `warm: ${q}`);
      assert.match(warm.err, / The sieves in .* answered \d+ of the \d+ files read without opening them, and 0 were kept \(--no-cache opens every file\)\./, `warm: ${q}`);
    }
    const absent = ltms(['search', '--cache', 'zqvabsent', d], { cache });
    const read = JSON.parse(absent.out.split('\n')[0]).files.read;
    assert.equal(read, readdirSync(d).length);
    assert.equal(answered(absent), ruledOut(d, 'zqvabsent'), 'warm, the files whose sieve rules the word out are answered unopened');
    assert.ok(answered(absent) >= read - 1, `a word in no file: ${answered(absent)} of ${read} answered`);
    assert.equal(sieveFiles(cache).length, read, 'one sieve per file');
  } finally { rm(d); rm(cache); }
});

test('command: LTMS_CACHE=1 keeps and uses the sieves as --cache does; --no-cache turns them off for one search; both flags are refused', () => {
  const d = corpus(), cache = tmp();
  try {
    const plain = same(ltms(['search', 'zqvabsent', d], { cache }));
    ltms(['search', 'zqvabsent', d], { cache, env: { LTMS_CACHE: '1' } });
    const files = sieveFiles(cache).length;
    assert.equal(files, readdirSync(d).length);
    const warm = ltms(['search', 'zqvabsent', d], { cache, env: { LTMS_CACHE: '1' } });
    assert.equal(answered(warm), ruledOut(d, 'zqvabsent'));
    assert.deepEqual(same(warm), plain);
    const off = ltms(['search', '--no-cache', 'zqvabsent', d], { cache, env: { LTMS_CACHE: '1' } });
    assert.doesNotMatch(off.err, /The sieves in|no sieve is kept/);
    assert.deepEqual(same(off), plain);
    const both = ltms(['search', '--cache', '--no-cache', 'zqvabsent', d], { cache });
    assert.deepEqual([both.code, both.out, both.err], [2, '', 'ltms search: --cache and --no-cache are both given: give one.\n']);
    const valued = ltms(['search', '--cache=1', 'zqvabsent', d], { cache });
    assert.deepEqual([valued.code, valued.err], [2, "ltms search: --cache takes no value; '--cache=1' gives it one.\n"]);
  } finally { rm(d); rm(cache); }
});

test('command: a file changed after its sieve was kept is read again: a turn appended, and a same-size rewrite with its old times put back', () => {
  const d = corpus(), cache = tmp();
  try {
    const warm = () => ltms(['search', '--cache', 'zqvlater', d], { cache });
    assert.equal(JSON.parse(warm().out.split('\n')[0]).hits.turns, 0);
    appendFileSync(join(d, 'b.jsonl'), sessionWith([['zqvlater six', 'seven']]).replace(/"parentUuid":null/, `"parentUuid":"${uuidN(2)}"`).replaceAll(/0000000000(\d\d)"/g, (m, n) => `00000000099${n}"`));
    const after = warm();
    assert.equal(JSON.parse(after.out.split('\n')[0]).hits.turns, 1, 'the appended turn is found');
    assert.deepEqual(same(after), same(ltms(['search', 'zqvlater', d], { cache })));
    // the same size, the same modification time (whole seconds, put back exactly): only the bytes and ctime differ
    const f = join(d, 'a.jsonl');
    utimesSync(f, 1700000000, 1700000000);
    const before = statSync(f, { bigint: true });
    const text = readFileSync(f, 'utf8');
    assert.ok(text.includes('zqvalpha one'));
    ltms(['search', '--cache', 'zqvlater', d], { cache });
    writeFileSync(f, text.replace('zqvalpha one', 'zqvlater one'));
    utimesSync(f, 1700000000, 1700000000);
    const now = statSync(f, { bigint: true });
    assert.deepEqual([now.size, now.mtimeNs, now.ino], [before.size, before.mtimeNs, before.ino]);
    const again = ltms(['search', '--cache', 'zqvlater', d], { cache });
    assert.equal(JSON.parse(again.out.split('\n')[0]).hits.turns, 2, 'the rewritten file is read, not answered from its old sieve');
  } finally { rm(d); rm(cache); }
});

test('command: a damaged sieve, an empty one, and one of another file are passed over: the file is read, and the output is unchanged', () => {
  const d = corpus(), cache = tmp();
  try {
    const plain = same(ltms(['search', 'zqvalpha', d], { cache }));
    ltms(['search', '--cache', 'zqvalpha', d], { cache });
    const dir = join(cache, 'ltms', 'sieves'), names = sieveFiles(cache).sort();
    assert.ok(names.length >= 3);
    writeFileSync(join(dir, names[0]), 'not a sieve');
    writeFileSync(join(dir, names[1]), '');
    copyFileSync(join(dir, names[3] ?? names[2]), join(dir, names[2]));
    const r = ltms(['search', '--cache', 'zqvalpha', d], { cache });
    assert.deepEqual(same(r), plain);
    assert.match(r.err, /and 3 were kept/, 'the three are rebuilt');
  } finally { rm(d); rm(cache); }
});

/** A kept sieve's head edited, and the file sealed again as SieveCache seals it (format 2: 'ltms-sieve 2 ', the sha256
 *  of the bytes after that line, a new line, then the raw deflate of the head's line and the bits), so that the edit
 *  alone can make it be passed over. */
function resealSieve(file, edit) {
  const buf = readFileSync(file), top = buf.indexOf(10) + 1, z = buf.subarray(top);
  assert.match(buf.subarray(0, top).toString('latin1'), /^ltms-sieve 2 [0-9a-f]{64}\n$/, 'format 2');
  assert.equal(createHash('sha256').update(z).digest('hex'), buf.subarray(top - 65, top - 1).toString('latin1'), 'the seal holds before the edit');
  const body = inflateRawSync(z), nl = body.indexOf(10), head = JSON.parse(body.subarray(0, nl).toString('utf8'));
  edit(head);
  const z2 = deflateRawSync(Buffer.concat([Buffer.from(JSON.stringify(head)), body.subarray(nl)]));
  writeFileSync(file, Buffer.concat([Buffer.from(`ltms-sieve 2 ${createHash('sha256').update(z2).digest('hex')}\n`, 'latin1'), z2]));
}

test('command: a sieve kept by another ltms version, under another runtime, or with the runtime\'s files changed, is passed over and rebuilt; the output is unchanged', () => {
  for (const [what, edit] of [
    ['ltms version', (h) => { assert.match(h.ltms, /^\d+\.\d+\.\d+/); h.ltms = '0.0.0-other'; }],
    ['runtime', (h) => { assert.match(h.sieve.runtime, /^node .*; reading [0-9a-f]{16}$/); h.sieve.runtime = h.sieve.runtime.replace(/reading [0-9a-f]{16}$/, 'reading 0000000000000000'); }],
    ['runtime files', (h) => { assert.match(h.files, /^[0-9a-f]{32}$/); h.files = '0'.repeat(32); }],
  ]) {
    const d = corpus(), cache = tmp();
    try {
      const plain = same(ltms(['search', 'zqvabsent', d], { cache }));
      ltms(['search', '--cache', 'zqvabsent', d], { cache });
      const dir = join(cache, 'ltms', 'sieves'), names = sieveFiles(cache).sort();
      resealSieve(join(dir, names[0]), edit);
      const r = ltms(['search', '--cache', 'zqvabsent', d], { cache });
      assert.deepEqual(same(r), plain, what);
      // a sieve is written only for a file that had none it could use: so the edited one was passed over
      assert.match(r.err, /and 1 was kept/, `${what}: the one sieve is passed over and rebuilt`);
    } finally { rm(d); rm(cache); }
  }
});

test('command: a cache directory others can write to, or one that is a symbolic link, is not used: a notice, every file read, the output unchanged', () => {
  const d = corpus(), cache = tmp();
  try {
    const plain = same(ltms(['search', 'zqvalpha', d], { cache }));
    mkdirSync(join(cache, 'ltms', 'sieves'), { recursive: true, mode: 0o700 });
    chmodSync(join(cache, 'ltms'), 0o777);
    const r = ltms(['search', '--cache', 'zqvalpha', d], { cache });
    assert.match(r.err, /^ltms search: notice: no sieve is kept or used: others can write to .*ltms \(mode 777\)\. Every file is read, as with --no-cache\.$/m);
    assert.deepEqual(sieveFiles(cache), []);
    const lines = r.err.split('\n').filter((l) => !l.includes('notice: no sieve'));
    assert.deepEqual({ ...same(r), err: lines.join('\n') }, plain);
  } finally { rm(d); rm(cache); }
});

test('command: a file named on the command line is read even when a walk kept its sieve: its own warnings print, as without --cache [S366 M14]', () => {
  const d = corpus(), cache = tmp();
  try {
    ltms(['search', '--cache', 'zqvabsent', d], { cache });
    assert.equal(sieveFiles(cache).length, readdirSync(d).length);
    const named = ['errors.jsonl', 'empty.jsonl', 'journal.jsonl', 'a.jsonl'].map((f) => join(d, f));
    const plain = same(ltms(['search', 'zqvabsent', ...named], { cache }));
    assert.match(plain.err, /empty\.jsonl' holds no records/);
    assert.match(plain.err, /journal\.jsonl' is a workflow journal/);
    const r = ltms(['search', '--cache', 'zqvabsent', ...named], { cache });
    assert.deepEqual(same(r), plain);
    assert.match(r.err, /answered 0 of the 4 files read without opening them/);
  } finally { rm(d); rm(cache); }
});

test('command: files named on the command line are always read, and get no sieve', () => {
  const d = corpus(), cache = tmp();
  try {
    const r = ltms(['search', '--cache', 'zqvalpha', join(d, 'a.jsonl'), join(d, 'b.jsonl')], { cache });
    assert.equal(JSON.parse(r.out.split('\n')[0]).hits.turns, 2);
    assert.deepEqual(sieveFiles(cache), []);
    assert.match(r.err, /answered 0 of the 2 files read without opening them, and 0 were kept/);
  } finally { rm(d); rm(cache); }
});

// ---- 3. G1 (S367): the cold review's soundness repairs (REPAIRS.md), each test red on 0937b46 first ------------------
//  A1/B1/C1 a sieve kept under one runtime is never used under another whose reading of text may differ; B12 the
//  Segmenter reads the same in a fresh process as after any other text; B2/C4 a damaged sieve is passed over, or reads
//  back exactly as written; A3 a filter over 2^31 bits is probed at every bit; A2 a long line after a phrase's first
//  word is searched, not stopped by an internal error.

const C = await import(join(root, 'dist', 'sieve-cache.js'));
const KHMER_HELLO = cp(0x179f, 0x17bd, 0x179f, 0x17d2, 0x178f, 0x17b8);
const NO_FLAGS = { problems: false, cycle: false, guessed: false };
/** A preload for ltms's node, written into d, standing for another runtime. `versions`: process.versions reports
 *  another ICU, and nothing else changes. `khmer`: Intl.Segmenter splits any text holding a Khmer letter into one word
 *  per character, as a runtime with other ICU data may split it otherwise, with the same versions. */
function preload(d, kind) {
  const f = join(d, `pre-${kind}.mjs`);
  writeFileSync(f, kind === 'versions'
    ? "Object.defineProperty(process, 'versions', { value: Object.freeze({ ...process.versions, icu: '0.0-another' }), configurable: true, enumerable: true });\n"
    : "const Orig = Intl.Segmenter;\n" +
      "const khmer = (s) => { for (const ch of s) { const c = ch.codePointAt(0); if (c >= 0x1780 && c <= 0x17ff) return true; } return false; };\n" +
      "class PerChar extends Orig { segment(s) { if (!khmer(s)) return super.segment(s); const out = []; let i = 0; for (const ch of s) { out.push({ segment: ch, index: i, input: s, isWordLike: true }); i += ch.length; } return out; } }\n" +
      "Object.defineProperty(Intl, 'Segmenter', { value: PerChar, configurable: true, writable: true });\n");
  return ['--import', pathToFileURL(f).href];
}
const hitTurns = (r) => JSON.parse(r.out.split('\n')[0]).hits.turns;
const kept = (r) => Number((/, and (\d+) (?:was|were) kept/.exec(r.err) ?? [])[1]);

test('sieve G1 [A1 B1 C1]: a sieve names the runtime that read its file; one that names another runtime, or none, never rules a file out', () => {
  const s = S.sieveTranscript(P.parseTranscript(sessionWith([['hello', 'world']])), SEG);
  const q = S.parseSearchQuery('zqvabsent', { segmenter: SEG });
  assert.equal(S.sieveMayHold(s, q), false, 'this runtime\'s own sieve rules the absent word out');
  assert.equal(typeof s.runtime, 'string', 'the sieve names its runtime');
  assert.equal(S.sieveMayHold({ ...s, runtime: 'another runtime' }, q), true, 'another runtime\'s sieve');
  assert.equal(S.sieveMayHold({ ...s, runtime: undefined }, q), true, 'a sieve that names no runtime');
  assert.equal(S.sieveMayHold({ ...s, runtime: 'another runtime' }, S.parseSearchQuery('zqvabsent', { mode: 'substring', segmenter: SEG })), true, '--substring too');
});

test('command G1 [A1 B1 C1]: sieves kept under another ICU version are not used: every file is read, the output is unchanged, and the sieves are kept again', () => {
  const d = corpus(), cache = tmp(), p = tmp();
  try {
    const plain = same(ltms(['search', 'zqvabsent', d], { cache }));
    const other = ltms(['search', '--cache', 'zqvabsent', d], { cache, node: preload(p, 'versions') });
    assert.ok(kept(other) >= 10, `kept under the other runtime: ${kept(other)}`);
    const r = ltms(['search', '--cache', 'zqvabsent', d], { cache });
    assert.deepEqual(same(r), plain);
    assert.equal(answered(r), 0, 'no file is answered from a sieve another runtime kept');
    assert.equal(kept(r), kept(other), 'each is kept again, under this runtime');
    assert.ok(answered(ltms(['search', '--cache', 'zqvabsent', d], { cache })) >= 10, 'and then used');
  } finally { rm(d); rm(cache); rm(p); }
});

test('command G1 [A1 B1 C1]: sieves kept under a runtime that splits Khmer otherwise, with the same versions, never hide a hit: --cache prints what the search prints', () => {
  const d = tmp(), cache = tmp(), p = tmp();
  try {
    writeFileSync(join(d, 'k.jsonl'), sessionWith([['zqvone', `${KHMER_HELLO} zqvtwo`]]));
    writeFileSync(join(d, 'z.jsonl'), sessionWith([['zqvthree', 'zqvfour']]));
    settle(d);
    const other = ltms(['search', '--cache', 'zqvanything', d], { cache, node: preload(p, 'khmer') });
    assert.equal(kept(other), 2, 'both sieves kept under the other reading');
    const plain = same(ltms(['search', KHMER_HELLO, d], { cache }));
    assert.equal(hitTurns(plain), 1, 'the search finds the word');
    const r = ltms(['search', '--cache', KHMER_HELLO, d], { cache });
    assert.deepEqual(same(r), plain);
    assert.deepEqual(same(ltms(['search', '--cache', '--substring', KHMER_HELLO, d], { cache })), same(ltms(['search', '--substring', KHMER_HELLO, d], { cache })), '--substring');
  } finally { rm(d); rm(cache); rm(p); }
});

test('sieve G1 [B12]: a sieve built first in a fresh process, before any other text (ICU cold), reads as the search reads: the hit is not ruled out', { skip: SEG !== 'icu' && 'this runtime\'s Segmenter has no dictionary' }, () => {
  const p = tmp();
  try {
    const word = cp(0x672c, 0x5f53);
    writeFileSync(join(p, 's.jsonl'), sessionWith([['zqvone', `zqvtwo ${cp(0x30fc)}${word}`]]));
    const script = join(p, 'cold.mjs');
    writeFileSync(script, [
      `const S = await import(${JSON.stringify(pathToFileURL(join(root, 'dist', 'search.js')).href)});`,
      `const P = await import(${JSON.stringify(pathToFileURL(join(root, 'dist', 'parser.js')).href)});`,
      `const t = P.parseTranscript((await import('node:fs')).readFileSync(process.argv[2], 'utf8'));`,
      `const sieve = S.sieveTranscript(t, 'icu');`,
      `const q = S.parseSearchQuery(process.argv[3], { segmenter: 'icu' });`,
      `console.log(JSON.stringify({ turns: S.searchTranscript(t, q).turns.length, may: S.sieveMayHold(sieve, q) }));`,
    ].join('\n') + '\n');
    const r = spawnSync(process.execPath, [script, join(p, 's.jsonl'), word], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { turns: 1, may: true });
  } finally { rm(p); }
});

/** A sieve kept by SieveCache itself, for a file of 60 words: the cache, the file's stat, the sieve's path. */
function keptSieve(d, sieveOf = (s) => s) {
  const dir = join(d, 'sieves');
  mkdirSync(dir, { mode: 0o700 });
  const words = Array.from({ length: 60 }, (_, i) => `zqv${i.toString(36)}w`);
  const f = join(d, 's.jsonl');
  writeFileSync(f, sessionWith([[words.slice(0, 30).join(' '), words.slice(30).join(' ')]]));
  const st = statSync(f, { bigint: true });
  const c = new C.SieveCache(dir, '0.0.0-test');
  c.write(st, sieveOf(S.sieveTranscript(P.parseTranscript(readFileSync(f, 'utf8')), SEG)), NO_FLAGS);
  const names = readdirSync(dir).filter((x) => x.endsWith('.sieve'));
  assert.equal(names.length, 1);
  return { c, st, file: join(dir, names[0]), words };
}
const sieveJSON = (k) => (k ? JSON.stringify({ ...k, sieve: { ...k.sieve, words: [...k.sieve.words.bits], grams: [...k.sieve.grams.bits], ascii: [...k.sieve.ascii] } }) : 'null');

test('sieve G1 [B2 C4]: a kept sieve changed by one bit, anywhere in its file, is passed over or reads back exactly as written', () => {
  const d = tmp();
  try {
    const { c, st, file } = keptSieve(d);
    const good = readFileSync(file), ref = sieveJSON(c.read(st));
    assert.notEqual(ref, 'null', 'the undamaged sieve is used');
    const used = [];
    for (let i = 0; i < good.length; i++) {
      const bad = Buffer.from(good);
      bad[i] ^= 1 << (i % 8);
      writeFileSync(file, bad);
      const got = c.read(st);
      if (got && sieveJSON(got) !== ref) used.push(i);
    }
    assert.equal(used.length, 0, `${used.length} of ${good.length} one-bit changes read back as another sieve (first at byte ${used[0]})`);
  } finally { rm(d); }
});

test('sieve G1 [B2]: a sieve whose header gives a filter no bits (m 0) never rules out a word its file holds; such a header, or one with no probes (k 0), is passed over', () => {
  for (const [what, edit] of [['words m 0', (s) => ({ ...s, words: { m: 0, k: 7, bits: new Uint8Array(0) } })], ['grams m 0', (s) => ({ ...s, grams: { m: 0, k: 7, bits: new Uint8Array(0) } })], ['words k 0', (s) => ({ ...s, words: { ...s.words, k: 0 } })]]) {
    const d = tmp();
    try {
      const { c, st, words } = keptSieve(d, edit);
      const got = c.read(st);
      const ruled = got ? words.filter((w) => !S.sieveMayHold(got.sieve, S.parseSearchQuery(w, { segmenter: SEG }))) : [];
      assert.equal(ruled.length, 0, `${what}: ${ruled.length} of ${words.length} words the file holds ruled out`);
      assert.equal(got, null, `${what}: the sieve is used`);
    } finally { rm(d); }
  }
});

test('sieve G1 [A3]: a Bloom filter of more than 2^31 bits is probed at every bit: an all-ones filter rules nothing out', () => {
  const s = S.sieveTranscript(P.parseTranscript(sessionWith([['hello', 'world']])), SEG);
  const m = 3 * 2 ** 30, n = m / 8;
  // an all-ones Uint8Array of n bytes, without the 384 MiB: any index in [0, n) reads 255, any other undefined
  const ones = new Proxy({}, { get: (_, k) => (k === 'length' ? n : typeof k === 'string' && /^(0|[1-9]\d*)$/.test(k) && Number(k) < n ? 255 : undefined) });
  const big = { ...s, words: { m, k: 7, bits: ones }, grams: { m, k: 7, bits: ones } };
  const out = [];
  for (let i = 0; i < 200; i++) {
    const w = `zqv${i.toString(36)}x`, h = cp(0x5d0 + (i % 27), 0x5d0 + ((i * 7) % 27), 0x5d0 + ((i * 11) % 27));
    if (!S.sieveMayHold(big, S.parseSearchQuery(w, { segmenter: SEG }))) out.push(w);
    if (!S.sieveMayHold(big, S.parseSearchQuery(h, { mode: 'substring', segmenter: SEG }))) out.push(`--substring #${i}`);
  }
  assert.equal(out.length, 0, `${out.length} of 400 queries ruled out by an all-ones filter (first: ${out[0]})`);
});

test('search G1 [A2]: a phrase whose first word is followed by a line of 200,000 words is searched, not stopped by an internal error; with --cache too', () => {
  const text = sessionWith([['zqvone', `${cp(0xe9)} zqvhead zqvabsent\n${'x '.repeat(200000)}`]]);
  const t = P.parseTranscript(text);
  let r;
  assert.doesNotThrow(() => { r = S.searchTranscript(t, S.parseSearchQuery('"zqvhead abs"', { segmenter: SEG })); });
  assert.equal(r.turns.length, 0, 'the phrase is not there');
  assert.equal(S.searchTranscript(t, S.parseSearchQuery('"zqvabsent x x"', { segmenter: SEG })).turns.length, 1, 'a phrase across the new line is found');
  const d = tmp(), cache = tmp();
  try {
    writeFileSync(join(d, 's.jsonl'), text);
    settle(d);
    const plain = same(ltms(['search', '"zqvhead abs"', d], { cache }));
    assert.equal(plain.code, 0, plain.err);
    ltms(['search', '--cache', 'zqvhead', d], { cache });
    assert.deepEqual(same(ltms(['search', '--cache', '"zqvhead abs"', d], { cache })), plain);
  } finally { rm(d); rm(cache); }
});

// ---- 4. G2 (S367): performance and accounting (REPAIRS.md), each test red on the G1 build first --------------------

test('command G2 [B4]: a file modified in the last five minutes gets no sieve (it will change again), and one older does; both are searched alike', () => {
  const d = tmp(), cache = tmp();
  try {
    writeFileSync(join(d, 'live.jsonl'), sessionWith([['zqvone', 'zqvtwo']]));
    writeFileSync(join(d, 'ended.jsonl'), sessionWith([['zqvthree', 'zqvfour']]));
    const at = (min) => { const t = new Date(Date.now() - min * 60e3); return [t, t]; };
    utimesSync(join(d, 'ended.jsonl'), ...at(60));
    const plain = same(ltms(['search', 'zqvabsent', d], { cache }));
    const cold = ltms(['search', '--cache', 'zqvabsent', d], { cache });
    assert.deepEqual(same(cold), plain);
    assert.equal(kept(cold), 1, 'the ended session only');
    utimesSync(join(d, 'live.jsonl'), ...at(4));
    assert.equal(kept(ltms(['search', '--cache', 'zqvabsent', d], { cache })), 0, 'four minutes is not five');
    utimesSync(join(d, 'live.jsonl'), ...at(6));
    const r = ltms(['search', '--cache', 'zqvabsent', d], { cache });
    assert.equal(kept(r), 1, 'six minutes is');
    assert.deepEqual(same(r), plain);
  } finally { rm(d); rm(cache); }
});

test('command G2 [B5]: a sieve that could not be written is not counted as kept, and the closing line says one could not be written', { skip: process.getuid?.() === 0 && 'root writes into any directory' }, () => {
  const d = corpus(), cache = tmp(), dir = join(cache, 'ltms', 'sieves');
  try {
    assert.ok(kept(ltms(['search', '--cache', 'zqvabsent', d], { cache })) >= 10, 'the first search keeps them');
    for (const f of sieveFiles(cache)) rmSync(join(dir, f));
    chmodSync(dir, 0o500);
    const r = ltms(['search', '--cache', 'zqvabsent', d], { cache });
    assert.equal(kept(r), 0, 'none could be written');
    assert.match(r.err, / A sieve could not be written \(/);
  } finally { try { chmodSync(dir, 0o700); } catch { /* gone */ } rm(d); rm(cache); }
});
