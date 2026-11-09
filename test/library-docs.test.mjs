// Tests for docs/library.md, the documentation of every field the library exports, against the BUILT declarations
// (build first). Every symbol each entry point exports (package.json's "exports", each entry's "types" file) has a
// section, under its entry point's heading; every member of an exported interface, and every member of an object type
// literal anywhere in an exported declaration (a type alias, a function's return or parameter type, a member's type),
// has a row there; and the doc has no section or row for anything the declarations do not have. The declarations are
// read through the typescript package (its parser, and its type checker for what `export *` brings in), never with a
// regex. Also: the member comments of the source reach the declarations (tsc keeps a /** */ comment and drops any
// other); a row's "when absent" cell agrees with its member's declared type; the doc's opening, its count sentence and its
// closing section say what the built files have; and the doc's and the README's recipe are the one ltms uses. The tests
// that read declarations are skipped, saying why, when typescript cannot be imported.
//
// The doc's shape, as read here:
//   - a "## " heading whose first code span is an entry point's import name (`long-term-memory-structure`, or
//     `long-term-memory-structure/pin`) opens that entry point's section; any other "#" or "##" heading closes it;
//   - a heading of level 3 to 6 that opens with a code span starting with a symbol's name opens that symbol's section
//     (#### `parseLines(text, opts?)` is parseLines'); a heading without one closes it when it is of the symbol's level
//     or above (a group heading such as "### The functions"), and not when it is below it;
//   - under a symbol's heading, each table row whose first cell is a code span is the row of the member it names:
//     `name`; `outer.inner` for a member of a literal in a member's type; `[k: string]` for an index signature;
//     `param.name` for a member of a literal in a function's parameter type;
//   - nothing inside a ``` fence is read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DOC = join(root, 'docs', 'library.md');
const README = join(root, 'README.md');
const rel = (f) => relative(root, f).split(sep).join('/');

let ts = null, noTs = false;
try { ts = createRequire(import.meta.url)('typescript'); }
catch (e) { noTs = `the typescript package cannot be imported from ${root} (${e?.code ?? e?.name}): npm install installs it, as a devDependency`; }

/** The 47 symbols src/parser.ts exports in 0.0.5 (the scouts' inventory), listed by hand: "." must export each. */
const PARSER_SYMBOLS = ['Uuid', 'Open', 'RecordType', 'Envelope', 'BlockType', 'TextBlock', 'ThinkingBlock', 'RedactedBlock',
  'ToolUseBlock', 'ToolResultBlock', 'ImageBlock', 'ContentBlock', 'Usage', 'Message', 'AssistantRecord', 'UserRecord',
  'AttachmentRecord', 'SystemRecord', 'SidecarRecord', 'CCRecord', 'LineProblem', 'TreeNode', 'ApiRequest', 'ToolCall',
  'FileKind', 'Transcript', 'TranscriptStats', 'hasEnvelope', 'blocksOf', 'isToolResultRecord', 'inputChannel', 'isInputTurn',
  'NOT_A_STRING', 'ParseOptions', 'RecordPosition', 'parseLines', 'replayMask', 'parseTranscript', 'pathTo', 'livePath',
  'Bridge', 'Splice', 'Extension', 'CompactionJoin', 'repairedLivePath', 'Turn', 'turnsOf'];

/** The entry points: each "exports" entry with a "types" file, by the name a consumer imports. */
function entryPoints() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.entries(pkg.exports ?? {}).flatMap(([key, target]) =>
    target !== null && typeof target === 'object' && typeof target.types === 'string'
      ? [{ key, name: key === '.' ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, '')}`, file: join(root, target.types) }]
      : []);
}

/** What the entry points declare: name -> { entries, target, members: Map(member path -> 'file:line') }, read through
 *  the type checker (so `export *` is followed as a consumer's compiler follows it), and what could not be read. */
function declared(entries) {
  const program = ts.createProgram(entries.map((e) => e.file), {
    noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
  });
  const checker = program.getTypeChecker();
  const symbols = new Map(), problems = [];
  for (const e of entries) {
    const sf = program.getSourceFile(e.file);
    const mod = sf && checker.getSymbolAtLocation(sf);
    if (!mod) { problems.push(`${rel(e.file)}, the types of ${e.name}, is not a module the typescript package reads`); continue; }
    for (const exported of checker.getExportsOfModule(mod)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const have = symbols.get(exported.name);
      if (have) {
        if (have.target === target) have.entries.push(e.name);
        else problems.push(`${exported.name} is exported by ${have.entries.join(' and ')} and by ${e.name}, from different declarations: rename one`);
        continue;
      }
      const sym = { name: exported.name, target, entries: [e.name], members: new Map() };
      symbols.set(exported.name, sym);
      for (const d of target.declarations ?? []) membersOf(d, sym, problems);
    }
  }
  return { symbols, problems };
}

/** Every member a declaration holds, by its path: an interface's members, and the members of every object type literal
 *  in its types, at any depth. */
function membersOf(d, sym, problems) {
  const sf = d.getSourceFile();
  const where = (n) => `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const nameOf = (m) => {
    if (ts.isIndexSignatureDeclaration(m)) return `[${m.parameters.map((p) => `${p.name.getText(sf)}: ${p.type ? p.type.getText(sf) : 'any'}`).join(', ')}]`;
    if (ts.isCallSignatureDeclaration(m)) return '()';
    if (ts.isConstructSignatureDeclaration(m)) return 'new()';
    if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isNumericLiteral(m.name))) return m.name.text;
    return m.name ? m.name.getText(sf) : null;
  };
  const walkType = (node, base) => {
    if (!node) return;
    if (ts.isTypeLiteralNode(node)) { walkMembers(node.members, base); return; }
    ts.forEachChild(node, (c) => walkType(c, base));
  };
  const walkMembers = (members, base) => {
    for (const m of members) {
      const n = nameOf(m);
      if (n === null) { problems.push(`${where(m)}: a member of ${sym.name} that this test cannot name (${ts.SyntaxKind[m.kind]})`); continue; }
      const path = base ? `${base}.${n}` : n;
      if (!sym.members.has(path)) sym.members.set(path, where(m));
      if (!ts.isIndexSignatureDeclaration(m)) for (const p of m.parameters ?? []) walkType(p.type, path);
      walkType(m.type, path);
    }
  };
  if (ts.isInterfaceDeclaration(d)) walkMembers(d.members, '');
  else if (ts.isTypeAliasDeclaration(d) || ts.isVariableDeclaration(d)) walkType(d.type, '');
  else if (ts.isFunctionDeclaration(d)) {
    walkType(d.type, '');
    for (const p of d.parameters) walkType(p.type, p.name.getText(sf));
  } else problems.push(`${where(d)}: ${sym.name} is declared as ${ts.SyntaxKind[d.kind]}, whose members this test does not read: extend membersOf`);
}

/** The doc's sections and rows: name -> { entry, line, members: Map(member path -> line) }, and its own problems. */
function documented(text, entryNames) {
  const symbols = new Map(), problems = [];
  let entry = null, sym = null, fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (level <= 2) {
        const code = /`([^`]+)`/.exec(h[2])?.[1];
        entry = level === 2 && code !== undefined && entryNames.includes(code) ? code : null;
        sym = null;
        return;
      }
      const name = /^`([A-Za-z_$][\w$]*)/.exec(h[2])?.[1];
      if (name === undefined) { if (sym && level <= sym.level) sym = null; return; }
      if (symbols.has(name)) { problems.push(`docs/library.md:${i + 1}: a second section for ${name} (the first is at line ${symbols.get(name).line})`); sym = symbols.get(name); }
      else { sym = { name, entry, level, line: i + 1, members: new Map(), absent: new Map() }; symbols.set(name, sym); }
      return;
    }
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row && sym) {
      const path = row[1].replace(/\s+/g, ' ').trim();
      if (sym.members.has(path)) problems.push(`docs/library.md:${i + 1}: a second row for ${sym.name}.${path} (the first is at line ${sym.members.get(path)})`);
      else {
        sym.members.set(path, i + 1);
        // the third cell, "when absent, null or empty", of a table of three columns (a pipe written \| is not a border)
        const cells = line.split(/(?<!\\)\|/).slice(1, -1);
        if (cells.length >= 3) sym.absent.set(path, cells[2].trim());
      }
    }
  });
  return { symbols, problems };
}

/** One line per truth: a symbol with no section, a member with no row, a section or row for nothing, a misplaced one. */
function compare(decl, doc) {
  const out = [...decl.problems, ...doc.problems];
  for (const [name, s] of decl.symbols) {
    const d = doc.symbols.get(name);
    if (!d) {
      out.push(`${name} (exported by ${s.entries.join(' and ')}) has no section: add a heading #### \`${name}\` under ## \`${s.entries[0]}\``);
      for (const [p, w] of s.members) out.push(`${name}.${p} (${w}) has no row`);
      continue;
    }
    if (!s.entries.includes(d.entry)) out.push(`docs/library.md:${d.line}: the section of ${name} is under ${d.entry ? `## \`${d.entry}\`` : 'no entry point\'s heading'}; it is exported by ${s.entries.join(' and ')}`);
    for (const [p, w] of s.members) if (!d.members.has(p)) out.push(`${name}.${p} (${w}) has no row: add | \`${p}\` | ... | under the heading of ${name} (docs/library.md:${d.line})`);
    for (const [p, l] of d.members) if (!s.members.has(p)) out.push(`docs/library.md:${l}: a row for ${name}.${p}, which the declarations do not have`);
  }
  for (const [name, d] of doc.symbols) if (!decl.symbols.has(name)) out.push(`docs/library.md:${d.line}: a section for ${name}, which no entry point exports`);
  return out;
}

/** The entry points, after checking that "." is one and that every entry's types file exists. */
function builtEntries() {
  const all = entryPoints();
  const dot = all.find((e) => e.key === '.');
  assert.ok(dot, `package.json's "exports" has no "." entry with a "types" file (entries with one: ${all.map((e) => e.key).join(', ') || 'none'})`);
  const missing = all.filter((e) => !existsSync(e.file)).map((e) => `${rel(e.file)} (the types of ${e.name})`);
  assert.deepEqual(missing, [], 'types files that package.json\'s "exports" names and that do not exist: run npm run build');
  return { all, built: all, dot };
}

test('docs/library.md has a section for every symbol each entry point exports, and a row for every member, and nothing more', { skip: noTs }, (t) => {
  const { all, built, dot } = builtEntries();
  const decl = declared(built);
  const lacking = PARSER_SYMBOLS.filter((n) => !decl.symbols.get(n)?.entries.includes(dot.name));
  assert.deepEqual(lacking, [], `symbols of 0.0.5's parser that ${dot.name} does not export`);
  const members = [...decl.symbols.values()].reduce((a, s) => a + s.members.size, 0);
  t.diagnostic(`declared: ${decl.symbols.size} symbols and ${members} members, by ${built.map((e) => e.name).join(' and ')}`);
  const hasDoc = existsSync(DOC);
  const doc = documented(hasDoc ? readFileSync(DOC, 'utf8') : '', all.map((e) => e.name));
  const problems = (hasDoc ? [] : ['docs/library.md does not exist']).concat(compare(decl, doc));
  assert.deepEqual(problems, [], `${problems.length} problems in docs/library.md (its shape is described at the top of test/library-docs.test.mjs)`);
});

test('docs/library.md: the count of the symbols "." exports, by module and by kind, is the declarations\' count', { skip: noTs }, () => {
  const { dot } = builtEntries();
  const program = ts.createProgram([dot.file], { noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] });
  const checker = program.getTypeChecker();
  // each module "." exports from, by the words the doc's sentence calls it
  const OWNER = { 'parser.d.ts': 'the parser\'s', 'search.d.ts': 'search\'s' };
  const by = new Map(Object.keys(OWNER).map((f) => [f, { fn: 0, cn: 0, ty: 0 }]));
  for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(dot.file)))) {
    const s = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const file = relative(dirname(dot.file), s.declarations[0].getSourceFile().fileName);
    const c = by.get(file);
    assert.ok(c, `${exported.name} comes from ${file}, which this test's OWNER does not name: add the words the doc uses for it`);
    if (s.flags & ts.SymbolFlags.Function) c.fn++;
    else if (s.flags & ts.SymbolFlags.Variable) c.cn++;
    else if (s.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) c.ty++;
    else assert.fail(`${exported.name}: a kind of export this test does not count (${ts.SymbolFlags[s.flags] ?? s.flags})`);
  }
  const n = (k, one, many) => (k === 1 ? `a ${one}` : `${k} ${many}`);
  const sum = (c) => c.fn + c.cn + c.ty;
  const want = `exports ${[...by.values()].reduce((a, c) => a + sum(c), 0)} symbols: ` + [...by].map(([f, c]) =>
    `${OWNER[f]} ${sum(c)} (${n(c.fn, 'function', 'functions')}, ${n(c.cn, 'constant', 'constants')} and ${n(c.ty, 'type', 'types')})`).join(' and ');
  assert.ok(readFileSync(DOC, 'utf8').includes(want), `docs/library.md does not say "${want}"`);
});

/** The declared type of each top-level member of each exported symbol (an interface's or a type alias's properties; a
 *  function's return type's), read through the checker with strict on, so that `| undefined` and `| null` are kept. */
function memberTypes(entries) {
  const program = ts.createProgram(entries.map((e) => e.file), {
    noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
  });
  const checker = program.getTypeChecker();
  const symbols = new Map();
  for (const e of entries) {
    const mod = checker.getSymbolAtLocation(program.getSourceFile(e.file));
    for (const exported of mod ? checker.getExportsOfModule(mod) : []) {
      const s = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const d = s.declarations?.[0];
      const type = !d ? null
        : ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) ? checker.getDeclaredTypeOfSymbol(s)
        : ts.isFunctionDeclaration(d) ? checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(d))
        : null;
      if (!type || symbols.has(exported.name)) continue;
      symbols.set(exported.name, new Map(checker.getPropertiesOfType(type).map((p) =>
        [p.name, { type: checker.getTypeOfSymbol(p), optional: (p.flags & ts.SymbolFlags.Optional) !== 0 }])));
    }
  }
  return { symbols, text: (t) => checker.typeToString(t) };
}
/** Whether a declared type admits a value of `flag`'s kind: any and unknown admit every value. */
const admits = (type, flag) => (type.flags & (flag | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || (type.isUnion() && type.types.some((u) => (u.flags & flag) !== 0));

test('docs/library.md: a row that says a member is `undefined` or `null` names a member whose declared type admits it, and a row that says it is never absent, one whose type admits neither', { skip: noTs }, () => {
  // the third cell OPENS with what the member is when absent; a `null` later in a cell can be another member's
  // (PinCheckOptions.root: "with neither, `staleness` is `null`")
  const { built } = builtEntries();
  const { symbols, text } = memberTypes(built);
  const doc = documented(readFileSync(DOC, 'utf8'), built.map((e) => e.name));
  const wrong = [];
  let read = 0;
  for (const [name, d] of doc.symbols) {
    for (const [path, cell] of d.absent) {
      const m = symbols.get(name)?.get(path);
      if (!m) continue;   // a member of a literal in a member's type, a parameter's member, an index signature
      const says = /^`(undefined|null)`/.exec(cell)?.[1] ?? (/^never absent\b/.test(cell) ? 'never absent' : null);
      if (!says) continue;
      read++;
      const undef = m.optional || admits(m.type, ts.TypeFlags.Undefined), nul = admits(m.type, ts.TypeFlags.Null);
      const ok = says === 'undefined' ? undef : says === 'null' ? nul : !undef && !nul;
      if (!ok) wrong.push(`docs/library.md:${d.members.get(path)}: ${name}.${path}: the row says ${says}; the declarations say ${text(m.type)}${m.optional ? ' (optional)' : ''}`);
    }
  }
  assert.ok(read >= 100, `only ${read} rows were read: the doc's table shape changed, and this test no longer reads it`);
  assert.deepEqual(wrong, [], 'a row and its member\'s declared type disagree: correct the declaration in src/ or the row');
});

test('the declarations admit the caller Claude Code writes, an object ({"type":"direct"} in library-requests.jsonl, as 2.1.319 writes it): ToolUseBlock.caller and ToolCall.caller', { skip: noTs }, async () => {
  const lib = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
  const t = lib.parseTranscript(readFileSync(join(here, 'fixtures', 'library-requests.jsonl'), 'utf8'));
  const all = t.toolCalls.map((c) => c.caller).filter((v) => v !== undefined);
  assert.deepEqual(all, [{ type: 'direct' }, { type: 'direct' }], 'the fixture\'s callers: the two Bash calls carry one each');
  const values = [all[0]];
  const { symbols, text } = memberTypes(builtEntries().built);
  const kind = { object: ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive, string: ts.TypeFlags.StringLike, number: ts.TypeFlags.NumberLike, boolean: ts.TypeFlags.BooleanLike };
  const wrong = [];
  for (const [name, member] of [['ToolUseBlock', 'caller'], ['ToolCall', 'caller']]) {
    const m = symbols.get(name)?.get(member);
    if (!m) { wrong.push(`${name}.${member} is not declared`); continue; }
    for (const v of values) if (!admits(m.type, kind[typeof v])) wrong.push(`${name}.${member} is declared ${text(m.type)}, which does not admit ${JSON.stringify(v)}`);
  }
  assert.deepEqual(wrong, []);
});

test('TranscriptStats.inputTurns: its JSDoc names every input channel inputChannel returns (typed, sdk, input, task, loop, parent)', { skip: noTs }, async () => {
  const lib = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
  // one crafted user record per channel, as inputChannel's rules in src/parser.ts read them
  const user = (extra, content = 'go') => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const channels = [user({ promptSource: 'typed' }), user({ promptSource: 'sdk' }), user({}), user({ origin: { kind: 'task-notification' } }),
    user({ queueSkipAttachments: true }, '<command-name>/loop</command-name>'), user({ isSidechain: true })].map((r) => lib.inputChannel(r));
  assert.deepEqual(channels, ['typed', 'sdk', 'input', 'task', 'loop', 'parent'], 'the channels of the crafted records');
  const file = join(root, 'dist', 'parser.d.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const m = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'TranscriptStats')?.members.find((x) => x.name?.getText(sf) === 'inputTurns');
  assert.ok(m, 'TranscriptStats.inputTurns is not declared in dist/parser.d.ts');
  const jsdoc = ts.getJSDocCommentsAndTags(m).filter((d) => ts.isJSDoc(d)).map((d) => ts.getTextOfJSDocComment(d.comment) ?? '').join(' ');
  assert.deepEqual(channels.filter((c) => !new RegExp(`\\b${c}\\b`).test(jsdoc)), [], `channels the JSDoc of inputTurns does not name: ${JSON.stringify(jsdoc)}`);
});

test('the inventory finds members in each place one can be: an interface, a literal in a member\'s type, a union\'s literal, a return type\'s literal, an index signature', { skip: noTs }, () => {
  const { dot } = builtEntries();
  const decl = declared([dot]);
  // known answers, read off src/parser.ts by hand (lines 108-115, 106, 166, 453, 816, 891)
  const want = [['Usage', 'input_tokens'], ['Usage', '[k: string]'], ['Usage', 'output_tokens_details.thinking_tokens'],
    ['Usage', 'output_tokens_details.[k: string]'], ['AttachmentRecord', 'attachment.type'], ['ContentBlock', 'type'],
    ['ContentBlock', '[k: string]'], ['parseLines', 'records'], ['parseLines', 'lines'], ['livePath', 'from'],
    ['repairedLivePath', 'compactions'], ['TranscriptStats', 'requestKeyGuessed']];
  assert.deepEqual(want.filter(([s, p]) => !decl.symbols.get(s)?.members.has(p)).map(([s, p]) => `${s}.${p}`), []);
  // a function with no literal in its signature has no members, and neither has a type alias of strings
  assert.deepEqual([decl.symbols.get('parseTranscript')?.members.size, decl.symbols.get('FileKind')?.members.size], [0, 0]);
});

/** The 9 member comments that were // comments in 0.0.5 (tsc drops those from the declarations), word for word. */
const LINE_COMMENTS = [
  ['AssistantRecord', 'requestId', 'groups the blocks of one API response; absent on the oldest records'],
  ['AssistantRecord', 'effort', 'added in CLI 2.1.212'],
  ['AssistantRecord', 'apiBlockIndex', 'added in CLI 2.1.258: block order WITHIN a request'],
  ['AssistantRecord', 'attributionAgent', 'undocumented'],
  ['UserRecord', 'promptId', 'user-only; assistant carries requestId instead'],
  ['UserRecord', 'sourceToolAssistantUUID', 'on most tool results: links a result back to the calling block'],
  ['UserRecord', 'origin', 'a sibling of `message`, NOT inside it'],
  ['AttachmentRecord', 'rendered', 'added in CLI 2.1.263'],
  ['AttachmentRecord', 'renderedInHumanTurn', 'added in CLI 2.1.263; rare'],
];

test('dist/parser.d.ts carries the 9 member comments that were // comments in 0.0.5, as JSDoc, word for word', { skip: noTs }, () => {
  const file = join(root, 'dist', 'parser.d.ts');
  assert.ok(existsSync(file), 'dist/parser.d.ts does not exist: run npm run build');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const wrong = [];
  for (const [iface, member, words] of LINE_COMMENTS) {
    const decl = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === iface);
    const m = decl?.members.find((x) => x.name && ts.isIdentifier(x.name) && x.name.text === member);
    if (!m) { wrong.push(`${iface}.${member} is not declared in dist/parser.d.ts`); continue; }
    const docs = ts.getJSDocCommentsAndTags(m).filter((d) => ts.isJSDoc(d)).map((d) => ts.getTextOfJSDocComment(d.comment) ?? '');
    if (!docs.includes(words)) wrong.push(`${iface}.${member}: its JSDoc is ${JSON.stringify(docs)}, not ${JSON.stringify(words)}`);
  }
  assert.deepEqual(wrong, []);
});

test('no member of an exported type in src/ carries a comment that tsc drops from the declarations: each is a /** */ comment', { skip: noTs }, () => {
  const wrong = [];
  for (const f of readdirSync(join(root, 'src')).filter((x) => x.endsWith('.ts')).sort()) {
    const text = readFileSync(join(root, 'src', f), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true);
    const visit = (node, owner) => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        for (const m of node.members) {
          const dropped = [...(ts.getLeadingCommentRanges(text, m.getFullStart()) ?? []).filter((r) => !text.startsWith('/**', r.pos)),
            ...(ts.getTrailingCommentRanges(text, m.end) ?? [])];
          for (const r of dropped) wrong.push(`src/${f}:${sf.getLineAndCharacterOfPosition(r.pos).line + 1}: ${owner}.${m.name ? m.name.getText(sf) : '[index]'}: ${text.slice(r.pos, r.end)}`);
        }
      }
      ts.forEachChild(node, (c) => visit(c, owner));
    };
    for (const s of sf.statements) {
      if (!ts.canHaveModifiers(s) || !ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      visit(s, s.name?.getText(sf) ?? '(export)');
    }
  }
  assert.deepEqual(wrong, [], 'tsc drops each of these from dist/*.d.ts: write it as /** ... */ on the line above its member');
});

test('docs/library.md: every link to a heading (#anchor) names one of its headings, as GitHub makes their anchors', () => {
  assert.ok(existsSync(DOC), 'docs/library.md does not exist');
  const text = readFileSync(DOC, 'utf8');
  // GitHub's anchor: the heading's text, lower-cased, without its punctuation (code spans' backticks too), each space a -
  const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const anchors = new Set();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
    const h = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (h) anchors.add(slug(h[1]));
  }
  const links = [...text.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'docs/library.md links no heading of its own');
  assert.deepEqual(links.filter((a) => !anchors.has(a)), [], 'links to headings docs/library.md does not have');
});

test('README: the Library section links GitHub\'s rendered view of docs/library.md at the release\'s tag, v<the version in package.json>, as every link to it does, and names each entry point, and Privacy says what the library returns', () => {
  const readme = readFileSync(README, 'utf8');
  const start = readme.indexOf('\n## Library\n');
  assert.ok(start >= 0, 'the README has no "## Library" section');
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  // the owner's ruling (S358, A7): the docs a release's README links are that release's, at its tag (the owner tags
  // each release), not the branch's, which moves on
  const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const url = `https://github.com/long-term-memory-structure/long-term-memory-structure/blob/v${v}/docs/library.md`;
  assert.ok(section.includes(`(${url})`), `the Library section does not link ${url}`);
  for (const f of ['README.md', 'CHANGELOG.md', 'docs/library.md']) {
    const links = [...readFileSync(join(root, f), 'utf8').matchAll(/\]\(([^)\s]*library\.md[^)\s]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(links.filter((l) => l !== url), [], `links in ${f} to docs/library.md that are not ${url}`);
  }
  assert.ok(existsSync(DOC), 'docs/library.md, which the README links, does not exist');
  const unnamed = entryPoints().map((e) => e.name).filter((n) => !section.includes(`\`${n}\``));
  assert.deepEqual(unnamed, [], 'entry points the Library section does not name');
  // the README's Privacy is about what ltms prints; it says that the library returns the content itself
  const p = readme.indexOf('\n## Privacy\n'), privacy = readme.slice(p, readme.indexOf('\n## ', p + 1));
  assert.ok(p >= 0 && /library[^\n]*returns the transcript's content/.test(privacy), 'the Privacy section does not say that the library returns the transcript\'s content');
  // ... and that the search, which is in the library too, applies the label rule to what it returns
  const bullet = privacy.split('\n').find((l) => /library[^\n]*returns the transcript's content/.test(l));
  assert.match(bullet, /search[^\n]*label rule/, 'the Privacy bullet on the library does not say that the search applies the label rule');
});

test('docs/library.md: the rows of repairedLivePath\'s lists give the order test/library.test.mjs asserts: bridges and splices in path order, compactions the earliest first', () => {
  // the owner's ruling (S358, A6): bridges are listed in path order, as compactions are (the earliest first); the
  // walk back from the head meets them the other way round, latest first, which the row must no longer say
  const text = readFileSync(DOC, 'utf8'), lines = text.split('\n');
  const sym = documented(text, entryPoints().map((e) => e.name)).symbols.get('repairedLivePath');
  assert.ok(sym, 'docs/library.md has no section for repairedLivePath');
  const meaning = (m) => {
    const l = sym.members.get(m);
    assert.ok(l, `docs/library.md has no row for repairedLivePath's ${m}`);
    return lines[l - 1].split(/(?<!\\)\|/)[2].trim();
  };
  assert.match(meaning('bridges'), /\bin path order\b/, `docs/library.md:${sym.members.get('bridges')}: the bridges row does not say "in path order"`);
  assert.doesNotMatch(meaning('bridges'), /latest first/, `docs/library.md:${sym.members.get('bridges')}: the bridges row still says "latest first"`);
  assert.match(meaning('splices'), /\bin path order\b/, `docs/library.md:${sym.members.get('splices')}: the splices row does not say "in path order"`);
  assert.match(meaning('compactions'), /\bthe earliest first\b/, `docs/library.md:${sym.members.get('compactions')}: the compactions row does not say "the earliest first"`);
});

test('docs/library.md opens by naming every entry point, and src/index.ts\'s header names every module "." exports', () => {
  const text = readFileSync(DOC, 'utf8');
  const opening = text.slice(0, text.indexOf('\n## '));
  assert.deepEqual(entryPoints().map((e) => e.name).filter((n) => !opening.includes(`\`${n}\``)), [], 'entry points the doc\'s opening (before its first ## heading) does not name');
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const modules = [...index.matchAll(/^export \* from '\.\/([\w-]+)\.js';$/gm)].map((m) => m[1]);
  assert.ok(modules.length > 0, 'src/index.ts has no export * line');
  const header = index.slice(0, index.search(/^export /m));
  assert.deepEqual(modules.filter((m) => !new RegExp(`\\b${m}\\b`).test(header)), [], `modules src/index.ts exports from that its header comment does not name: ${header}`);
});

/** The node: modules a built file imports (its static import and export ... from statements), sorted. */
const nodeImports = (file) => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"](node:[^'"]+)['"]/gm)].map((m) => m[1]).sort();
/** The source of the regular expression a built file assigns to `const LABEL`. */
const labelRule = (file) => /^const LABEL = (\/.+\/[a-z]*);$/m.exec(readFileSync(file, 'utf8'))?.[1];

test('docs/library.md, "What the library returns": what each entry point reads, and whose output rule applies where, as the built files have it', () => {
  const text = readFileSync(DOC, 'utf8');
  const start = text.indexOf('\n## What the library returns\n');
  assert.ok(start >= 0, 'docs/library.md has no "## What the library returns" section');
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end < 0 ? undefined : end);
  const entries = entryPoints();
  // each entry point has a sentence of its own, opening with its name: what it reads
  const sentence = (name) => new RegExp('`' + name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '`([^.]|\\.(?! ))*\\.').exec(section)?.[0];
  const unnamed = entries.map((e) => e.name).filter((n) => sentence(n) === undefined);
  assert.deepEqual(unnamed, [], 'entry points the section gives no sentence of their own');
  const wrong = [];
  for (const e of entries) {
    const s = sentence(e.name);
    const runtime = join(root, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports[e.key].default);
    // the node: modules the entry's built file reaches: "." (dist/index.js) through its own modules, as package-paths.test.mjs walks them
    const reached = new Set(), stack = [runtime], mods = new Set();
    while (stack.length) {
      const f = stack.pop();
      if (reached.has(f)) continue;
      reached.add(f);
      if (!existsSync(f)) { wrong.push(`${rel(f)}, which ${e.name} loads, does not exist: run npm run build`); continue; }
      for (const m of nodeImports(f)) mods.add(m);
      for (const [, r] of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"](\.\/[\w.-]+\.js)['"]/gm)) stack.push(join(dirname(f), r));
    }
    const named = [...new Set([...s.matchAll(/`(node:[^`]+)`/g)].map((m) => m[1]))].sort();
    if (mods.size === 0 && !/imports nothing from Node/.test(s)) wrong.push(`${e.name} imports nothing from Node, and its sentence does not say so: ${s}`);
    if (mods.size > 0 && named.join() !== [...mods].sort().join()) wrong.push(`${e.name} imports ${[...mods].sort().join(', ')}; its sentence names ${named.join(', ') || 'none'}: ${s}`);
  }
  assert.deepEqual(wrong, []);
  // the output rule: the parser's functions apply none of it; the search applies the label rule itself, a copy of cli.ts's
  assert.match(section, /search[^\n]*label rule/, 'the section does not say that the search applies the label rule');
  const [cli, search] = [labelRule(join(root, 'dist', 'cli.js')), labelRule(join(root, 'dist', 'search.js'))];
  assert.ok(cli !== undefined && cli === search, `the label rule of dist/search.js (${search}) is not dist/cli.js's (${cli}), which the doc says it is a copy of`);
});

// ---- the recipe: the doc's and the README's, against the command ----
/** The first ```js block after a marker line. */
const jsBlock = (text, marker) => {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `no "${marker}"`);
  const m = /```js\n([\s\S]*?)```/.exec(text.slice(i));
  assert.ok(m, `no js block after "${marker}"`);
  return m[1];
};
/** The turnsOf call skeletonOf makes in src/cli.ts: how ltms reads a transcript. */
const cliTurnsOf = () => {
  const src = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
  const call = /turnsOf\([^;]*?\)(?=;)/.exec(src.slice(src.indexOf('function skeletonOf')))?.[0];
  assert.ok(call, 'src/cli.ts has no turnsOf call in skeletonOf');
  return call;
};

test('the README\'s recipe, run as written, counts the turns ltms stats counts, on a file with a compaction (compacted.jsonl)', () => {
  // turnsOf(t) alone stops at the compaction: 1 turn; the repaired path gives the 2 ltms stats counts
  const code = jsBlock(readFileSync(README, 'utf8'), 'This is how `ltms` reads a transcript');
  const fixture = join(here, 'fixtures', 'compacted.jsonl');
  const dir = mkdtempSync(join(tmpdir(), 'ltms-recipe-'));
  try {
    // the package, as a consumer's import finds it: node_modules/<name>, a link to this tree (a junction on win32)
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(root, join(dir, 'node_modules', 'long-term-memory-structure'), 'junction');
    writeFileSync(join(dir, 'recipe.mjs'), `const file = ${JSON.stringify(fixture)};\n${code}\nconsole.log(turns.length);\n`);
    const r = spawnSync(process.execPath, [join(dir, 'recipe.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `the README's recipe exited ${r.status}: ${r.stderr}`);
    const s = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'stats', fixture], { encoding: 'utf8' });
    assert.equal(s.status, 0, `ltms stats ${fixture} exited ${s.status}: ${s.stderr}`);
    assert.deepEqual([Number(r.stdout.trim()), JSON.parse(s.stdout.split('\n')[0]).turns], [2, 2], 'turns by the README\'s recipe, and by ltms stats');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('docs/library.md\'s recipe calls turnsOf as skeletonOf in src/cli.ts does', () => {
  const call = cliTurnsOf();
  assert.equal(call, 'turnsOf(t, repairedLivePath(t).path)', 'skeletonOf\'s call (the doc says the recipe is how ltms reads a transcript)');
  assert.ok(jsBlock(readFileSync(DOC, 'utf8'), '## The recipe').includes(call), `docs/library.md's recipe does not call ${call}`);
});

test("README.md and docs/library.md: every sentence on what transcript text the search's results hold names `last`, the latest timestamp as the transcript holds it (final[5], adopted from last-named.test.mjs)", () => {
  const claims = [];
  for (const f of [README, DOC]) {
    const text = readFileSync(f, 'utf8').replace(/\s*\n\s*/g, ' ');
    // sentences: split after a period followed by a space and a capital letter, a backquote or an opening bracket
    for (const s of text.split(/(?<=\.)\s+(?=[A-Z`\[(*])/)) if (/no transcript text/.test(s)) claims.push({ f: rel(f), s });
  }
  // the README's Privacy bullet on the library, the doc's Search paragraph and its closing section
  assert.ok(claims.length >= 3, `found ${claims.length} such sentences: ${claims.map((c) => c.f).join(', ')}`);
  const without = claims.filter((c) => !/`last`|latest timestamp/.test(c.s));
  assert.deepEqual(without.map((c) => `${c.f}: ${c.s.slice(0, 160)}`), []);
});
