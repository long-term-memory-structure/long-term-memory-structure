// The shape report (ltms shapes, 0.3.0): what a set of JSONL transcripts is made of, never what it says. Record kinds,
// key paths, JSON types, classes of strings and numbers, counts and the versions of the program that wrote them.
//
// THE REPORT IS A CLOSED LANGUAGE. Every string in it is one of:
//   (1) a field name or a line kind of the report's own format;
//   (2) a count as a power-of-two bucket ("0", "1", "2-3", "4-7", ...), or a capped one ("64+");
//   (3) a JSON type, or the name of a class of strings or numbers, from the fixed lists below;
//   (4) a key path or a value from the vocabulary (named in the first line by its name and sha256), or one the person
//       named with --allow (listed in the first line);
//   (5) a version by the version rule (VERSION, below: N.N.N, no part of more than one digit starting with 0), read
//       only at a version path the vocabulary names, and printed as written: the one value of a record a report holds
//       (it can be a date, when a program writes its version as one, 2026.11.15).
// No key name, value, length, time, position or order from a transcript reaches a report any other way: writeReport
// checks the report whole against that language before it writes any of it (checkRows: every line by checkLine, each
// written byte for byte as the builder writes it, and each in its place: the line kinds in the format's order, each
// kind's lines in the builder's order and each once, the end line last, counting them), and writes none of a report that
// fails. The guard is at the write, so a defect in the reading (a misparse, a wrong count) can make a count wrong but
// cannot put a transcript's token in the report, nor a count or an order in the number or the order of its lines.
//
// This module knows nothing of any supplier: everything that names a program's records is data in the vocabulary file.
// Each line of a transcript is parsed alone, with JSON.parse; nothing here uses the parser of the rest of ltms. It writes
// nothing itself: the command (cli.ts) gives writeReport the function that writes stdout. Ported from the S373 prototype
// (the privacy seat's shapes.mjs), without its --census.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
/** The report's format, named in its first line. */
export const SHAPES_FORMAT = 'ltms-shapes/0';
/** The format a vocabulary file names in its `format` field. */
export const SHAPES_VOCABULARY_FORMAT = 'ltms-shapes-vocabulary/0';
/** The longest line read by default; a longer one is counted (tooLong) as its bytes stream past, never held. */
export const SHAPES_MAX_LINE = 64 * 1024 * 1024;
/** The number of files a path must be seen in to be printed, unless --floor says otherwise. */
export const SHAPES_FLOOR = 3;
/** The least floor --floor takes, and a report's first line may state; the largest is Number.MAX_SAFE_INTEGER (a floor is
 *  a whole number a double holds exactly, never one it rounds: S374's closure read, U7). */
export const SHAPES_MIN_FLOOR = 2;
/** The core's label rule, a copy of cli.ts's (test/shapes.test.mjs holds the two equal). A value printed in a report
 *  (a vocabulary value, an allowed one) must pass it. */
const LABEL = /^[\w.:+-]{1,64}$/;
/** A key name a vocabulary or --allow may hold: a field name, with no '.' and no '[' (a path's own syntax), so a key that
 *  holds them can never be read as a path. An optional leading $ or @ (as in JSON Schema's $id, JSON-LD's @type). */
const NAME = /^[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63}$/;
/** THE VERSION RULE, the only versions printed: three parts joined by '.', of 1 to 4, 1 to 4 and 1 to 6 digits, none of
 *  more than one digit starting with 0, and nothing else (no pre-release or build suffix). Without a leading 0, each
 *  version has one spelling, so two versions never compare equal (S374's closure read, U3). The class version is a
 *  string that follows it too. */
const VERSION = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,5})$/;
const TYPES = ['array', 'boolean', 'null', 'number', 'object', 'string'];
const STRING_CLASSES = ['empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'version', 'digits', 'hex', 'label', 'text'];
const NUMBER_CLASSES = ['int', 'float', 'epoch-s', 'epoch-ms'];
const BOOLEANS = ['false', 'true'];
const RARE = '(rare)', UNLISTED = '(unlisted)', NONE = '(none)', WITHHELD = '(withheld)', NOT_STRING = '(not a string)', ALL = '(all)';
/** Distinct names and array lengths are counted up to this, then print as 64+. */
const CAP = 64;
const CAP_LABELS = ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];
/** The names (or values) kept per path for the local review list (--unlisted); the occurrences past them are counted. */
export const SHAPES_NAMES_PER_PATH = 2048;
/** Separators inside the accumulators' keys, built: no name, path or label printed can hold them. */
const SEP = String.fromCharCode(0), KSEP = String.fromCharCode(1);
// ---- buckets --------------------------------------------------------------------------------------------------------
/** A count as a power-of-two bucket: 0, 1, 2-3, 4-7, ... Every count a report prints is one. */
function bucket(n) { if (n <= 1)
    return String(n); let lo = 1; while (lo * 2 <= n)
    lo *= 2; return `${lo}-${lo * 2 - 1}`; }
/** The same, capped: for a number that only needs to say few or many (distinct names, an array's length). */
const capped = (n) => (n >= CAP ? '64+' : bucket(n));
/** A bucket as bucket() writes it, and nothing else: a string (never another value whose text reads as one). Each number
 *  has at most 16 digits, and below that bound Number() reads a power of two, and the number below its double, exactly. */
function isBucket(s) {
    if (typeof s !== 'string')
        return false;
    if (s === '0' || s === '1')
        return true;
    const m = /^([1-9]\d{0,15})-([1-9]\d{0,15})$/.exec(s);
    if (!m)
        return false;
    const lo = Number(m[1]), hi = Number(m[2]);
    return lo >= 2 && Number.isInteger(Math.log2(lo)) && hi === lo * 2 - 1;
}
// ---- classes --------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;
const ISO_OFF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?[+-]\d{2}:?\d{2}$/;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;
const HEX = /^[0-9a-fA-F]{8,}$/;
/** A string's class, tested in this order; its text is never kept. */
function stringClass(s) {
    if (s === '')
        return 'empty';
    if (UUID.test(s))
        return 'uuid';
    if (ISO_UTC.test(s))
        return 'iso8601-utc';
    if (ISO_OFF.test(s))
        return 'iso8601-offset';
    if (ISO_LOCAL.test(s))
        return 'iso8601-local';
    if (DATE.test(s))
        return 'date';
    if (VERSION.test(s))
        return 'version';
    if (DIGITS.test(s))
        return 'digits';
    if (HEX.test(s))
        return 'hex';
    if (LABEL.test(s))
        return 'label';
    return 'text';
}
/** A number's class: whole numbers of seconds or milliseconds between 2000-01-01 and 2100-01-01 are epochs. */
function numberClass(v) {
    if (!Number.isInteger(v))
        return 'float';
    if (v >= 946684800 && v < 4102444800)
        return 'epoch-s';
    if (v >= 946684800000 && v < 4102444800000)
        return 'epoch-ms';
    return 'int';
}
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// ---- the vocabulary -------------------------------------------------------------------------------------------------
/** A key path of field names only (the kind path, a sub-kind's path, a version path). */
const PLAIN_PATH = /^(?:\.[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63})+$/;
/** A key path of field names and [] steps (an array's elements). */
const VOCAB_PATH = /^(?:\.[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63}|\[\])+$/;
/** A usage error: the run cannot start as given (exit 2). Its message is ltms's own, and quotes only what was given. */
export class ShapesUsageError extends Error {
    constructor(message) { super(message); this.name = 'ShapesUsageError'; }
}
const usage = (m) => new ShapesUsageError(m);
/** A vocabulary file's fields, and its kinds' (the README's section on ltms shapes, The vocabulary file, gives the
 *  format); the loader refuses any other (S374's closure read, U4). */
const VOCABULARY_FIELDS = ['format', 'name', 'source', 'paths', 'values', 'kinds', 'versions'];
const KINDS_FIELDS = ['path', 'sub'];
/** The rules, as the messages word them. */
const NAME_RULE = 'a name being an optional $ or @, then an ASCII letter or _, then ASCII letters, digits and _ : + -, at most 64 after the $ or @';
const PLAIN_RULE = `steps, each . and a name, ${NAME_RULE}`;
const PATH_RULE = `steps, each . and a name, or [] (an array's elements), ${NAME_RULE}`;
const VALUE_RULE = '1 to 64 ASCII letters, digits and . _ : + -';
/** An entry of a vocabulary file, as a message shows it: a string quoted as JSON (its first 80 characters), any other
 *  value by its type. */
function shown(x) {
    if (typeof x === 'string')
        return x.length > 80 ? `${JSON.stringify(x.slice(0, 80))}...` : JSON.stringify(x);
    return x === null ? 'null' : Array.isArray(x) ? 'an array' : isObj(x) ? 'an object' : `a ${typeof x}`;
}
/** Reads a vocabulary file (ltms-shapes-vocabulary/0). A file that cannot be read throws its own error; one that is not a
 *  vocabulary, that holds a field the format does not name (at its top or in kinds), whose path, name or value breaks
 *  the rules, that names in kinds, versions or values a path that paths does not list, or that names in kinds.sub a kind
 *  that values does not list at the kind path, is a usage error whose message names the entry by its field and index
 *  (paths[3], values[".kind"][2], kinds.sub["event"], versions[0]). */
export function loadVocabulary(file) {
    const bytes = readFileSync(file);
    let v;
    try {
        v = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw usage(`cannot read the vocabulary '${file}' as JSON.`);
    }
    if (!isObj(v) || v.format !== SHAPES_VOCABULARY_FORMAT)
        throw usage(`'${file}' is not a vocabulary (its format is not ${SHAPES_VOCABULARY_FORMAT}).`);
    const bad = (m) => usage(`'${file}': ${m}`);
    for (const f of Object.keys(v))
        if (!VOCABULARY_FIELDS.includes(f))
            throw bad(`the field ${shown(f)} is not a vocabulary's; its fields are format, name, source, paths, values, kinds and versions (the README's section on ltms shapes: The vocabulary file).`);
    if (v.name === undefined)
        throw bad(`name is missing: the vocabulary's name, which a report's first line gives (${VALUE_RULE}).`);
    if (typeof v.name !== 'string' || !LABEL.test(v.name))
        throw bad(`name ${shown(v.name)} is not a value: ${VALUE_RULE}.`);
    if (v.source !== undefined && typeof v.source !== 'string')
        throw bad(`source is ${shown(v.source)}: it holds words on where the vocabulary's names come from, a string.`);
    if (v.paths === undefined)
        throw bad('paths is missing: the list of the key paths a report may print (with none, every key prints as *).');
    if (!Array.isArray(v.paths))
        throw bad(`paths is ${shown(v.paths)}, not a list of key paths.`);
    const paths = v.paths;
    const V = { list: [], paths: new Set(), values: new Map(), kindPath: null, sub: new Map(), versions: [] };
    paths.forEach((p, i) => {
        if (typeof p !== 'string' || !VOCAB_PATH.test(p))
            throw bad(`paths[${i}] ${shown(p)} is not a key path: ${PATH_RULE}; as in .message.content[].type.`);
        V.paths.add(p);
    });
    const notListed = ' is a path that paths does not list; every path named in kinds, versions and values must be in paths.';
    let nValues = 0;
    if (v.values !== undefined && !isObj(v.values))
        throw bad(`values is ${shown(v.values)}, not an object of value lists by path.`);
    for (const [p, vs] of Object.entries(v.values ?? {})) {
        const at = `values[${shown(p)}]`;
        if (!VOCAB_PATH.test(p))
            throw bad(`${at} names no key path: ${PATH_RULE}.`);
        if (!V.paths.has(p))
            throw bad(at + notListed);
        if (!Array.isArray(vs))
            throw bad(`${at} is ${shown(vs)}, not a list of values.`);
        let set = V.values.get(p);
        if (!set)
            V.values.set(p, (set = new Set()));
        for (let j = 0; j < vs.length; j++) {
            const x = vs[j];
            if (typeof x !== 'string' || !LABEL.test(x))
                throw bad(`${at}[${j}] ${shown(x)} is not a value: ${VALUE_RULE}.`);
            set.add(x);
            nValues++;
        }
    }
    if (v.kinds !== undefined) {
        const k = v.kinds;
        if (!isObj(k))
            throw bad(`kinds is ${shown(k)}, not an object: {"path": the path of a record's kind, "sub": {a kind: the path of its sub-kind}}.`);
        for (const f of Object.keys(k))
            if (!KINDS_FIELDS.includes(f))
                throw bad(`kinds holds the field ${shown(f)}; its fields are path and sub.`);
        if (k.path === undefined)
            throw bad(`kinds.path is missing: the path of a record's kind (${PLAIN_RULE}).`);
        if (typeof k.path !== 'string' || !PLAIN_PATH.test(k.path))
            throw bad(`kinds.path ${shown(k.path)} is not a plain path: ${PLAIN_RULE}.`);
        if (!V.paths.has(k.path))
            throw bad(`kinds.path ${shown(k.path)}${notListed}`);
        V.kindPath = k.path;
        if (k.sub !== undefined && !isObj(k.sub))
            throw bad(`kinds.sub is ${shown(k.sub)}, not an object of the paths of sub-kinds by kind.`);
        for (const [t, sp] of Object.entries(k.sub ?? {})) {
            const at = `kinds.sub[${shown(t)}]`;
            if (!LABEL.test(t))
                throw bad(`${at}: the kind is not a value: ${VALUE_RULE}.`);
            // a kind values does not list at the kind path prints as (unlisted) before its sub-kind's path is read (kindOf),
            // so such an entry could never apply (S375's known issue k5)
            if (!V.values.get(k.path)?.has(t))
                throw bad(`${at}: the kind is not a value that values lists at the kind path, values[${shown(k.path)}]; a sub-kind's path is read only for a kind listed there.`);
            if (typeof sp !== 'string' || !PLAIN_PATH.test(sp))
                throw bad(`${at} ${shown(sp)} is not a plain path: ${PLAIN_RULE}.`);
            if (!V.paths.has(sp))
                throw bad(`${at} ${shown(sp)}${notListed}`);
            V.sub.set(t, sp);
        }
    }
    if (v.versions !== undefined && !Array.isArray(v.versions))
        throw bad(`versions is ${shown(v.versions)}, not a list of plain paths.`);
    const versions = (v.versions ?? []);
    versions.forEach((p, i) => {
        if (typeof p !== 'string' || !PLAIN_PATH.test(p))
            throw bad(`versions[${i}] ${shown(p)} is not a plain path: ${PLAIN_RULE}.`);
        if (!V.paths.has(p))
            throw bad(`versions[${i}] ${shown(p)}${notListed}`);
        if (!V.versions.includes(p))
            V.versions.push(p);
    });
    V.list.push({ name: v.name, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 12), paths: paths.length, values: nValues });
    return V;
}
/** The paths a record's kind is read at: the kind path, and each sub-kind's path. A report joins a kind and its
 *  sub-kind with ':' (kind:subkind), so a value with ':' there could print as the token of another kind. */
function kindPaths(V) {
    return V.kindPath === null ? [] : [...new Set([V.kindPath, ...V.sub.values()])];
}
/** An --allow argument, split: its path, and its value (null for a path alone). */
function allowParts(s) {
    const i = s.indexOf('=');
    return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}
/** The rule an --allow argument breaks, or null when --allow takes it: 'path', its path breaks the path rule; 'value', its
 *  value the label rule; 'kind', its value holds ':' at a path of kp, the kind path or a sub-kind's path (kindPaths). One
 *  function for --allow and for --check's reading of a report's allowed list (S375's known issue k1). */
function allowRule(s, kp) {
    const [p, val] = allowParts(s);
    if (!VOCAB_PATH.test(p))
        return 'path';
    if (val !== null && !LABEL.test(val))
        return 'value';
    if (val !== null && val.includes(':') && kp.includes(p))
        return 'kind';
    return null;
}
/** Each rule --allow applies, as --check names the one an entry of a report's allowed list breaks: the module's own words,
 *  which hold no part of the entry (the kind paths are the vocabulary's). */
const ALLOW_RULE_WORDS = {
    path: () => `its path is not written like .message.newField or .list[].name: ${PATH_RULE}`,
    value: () => `its value is not one by the label rule: ${VALUE_RULE}`,
    kind: (kp) => `its value holds ':' at the kind path or at a sub-kind's path (${kp.join(', ')}), where ':' joins a kind and its sub-kind in a report (kind:subkind)`,
};
/** --allow <path> or --allow <path>=<value>: the person names a key path (and with it every path above it) or a value, to
 *  print. Adds them to the vocabulary; returns the allowed list as the first line prints it, sorted, each once. A value
 *  at a kind path may not hold ':' (S374's closure read, U15): it would merge two kinds of record into one line. */
export function applyAllow(V, specs) {
    const allowed = [];
    const kp = kindPaths(V);
    for (const s of specs) {
        const [p, val] = allowParts(s);
        const rule = allowRule(s, kp);
        if (rule === 'path')
            throw usage(`--allow '${s}': the path must be written like .message.newField or .list[].name: ${PATH_RULE}.`);
        if (rule === 'value')
            throw usage(`--allow '${s}': the value must pass the label rule (at most 64 ASCII letters, digits and . _ : + -).`);
        if (rule === 'kind')
            throw usage(`--allow '${s}': a value at the kind path or at a sub-kind's path (${kp.join(', ')}) may not hold ':', which joins a kind and its sub-kind in a report (kind:subkind), so the value could print as another kind; '${val}' holds one. Such a value cannot be allowed: it prints as (unlisted).`);
        const re = /\.[^.[]+|\[\]/g;
        let m, acc = '';
        while ((m = re.exec(p)) !== null) {
            acc += m[0];
            V.paths.add(acc);
        }
        if (val !== null) {
            let set = V.values.get(p);
            if (!set)
                V.values.set(p, (set = new Set()));
            set.add(val);
        }
        allowed.push(s);
    }
    return [...new Set(allowed)].sort();
}
function getPlain(rec, path) {
    let x = rec;
    for (const seg of path.slice(1).split('.')) {
        if (!isObj(x) || !Object.hasOwn(x, seg))
            return undefined;
        x = x[seg];
    }
    return x;
}
/** A directory's entries, their names as bytes (encoding 'buffer'), with their types: a name that is not valid UTF-8
 *  comes back as its bytes, never as text whose U+FFFD can spell another entry's name (S374's closure read, S7).
 *  (Node gives Buffer names here; the typings of @types/node 20 have no such overload, hence the casts.) search's and
 *  index's walk lists directories with it too, so the three commands key a directory's entries alike (S375's known
 *  issue k13). */
export const listBytes = (d) => readdirSync(d, { withFileTypes: true, encoding: 'buffer' });
/** Every file named, and every .jsonl under a directory named (at any depth; symbolic links counted, not followed; an
 *  entry named .jsonl that is not a regular file counted, not read; a name that is not valid UTF-8 kept by its bytes and
 *  not read; a directory met again in a path's walk, by its device and inode, not entered again, and counted). Each
 *  directory is entered once per path given, as search enters it, and its entries are counted the first time it is
 *  listed, so each entry is counted once however many paths given reach it. Sorted, so a run does not depend on the
 *  order the paths were given or listed in. */
export function collectFiles(paths) {
    const files = new Map(), listed = new Set(), again = new Set();
    const failed = [], notUtf8 = [];
    let symlinks = 0, special = 0;
    const addFile = (p, st) => { const id = `${st.dev}:${st.ino}`; if (!files.has(id))
        files.set(id, p); };
    // a depth-first walk per path given, with its own stack, in the order a recursive one takes: each entry in its
    // directory's order, a directory entered where it is met. `fresh`: the directory is listed for the first time in the
    // run, and its entries are counted; one listed before, under another path given, is walked again only to meet the
    // directories met again in this path's walk, as search meets them (S375's known issue k15)
    const stack = [];
    /** Enters directory d in a path's walk: `entered`, the directories that walk has entered; `met`, for one met under the
     *  path given, the directory it was met in and its name (a directory met again is counted once by them); `count`,
     *  whether a failure to read it is one to count (not when it was counted under another path given); `given`, for the
     *  path given, its stat, which follows a symbolic link to the directory it names (a directory met under it is read by
     *  lstat: a link there is counted, never entered). A directory is known by its own device and inode, as search knows
     *  it, never by a link's. */
    const enter = (d, entered, met, count, given) => {
        let st;
        if (given)
            st = given;
        else
            try {
                st = lstatSync(d);
            }
            catch (e) {
                if (count)
                    failed.push({ path: d, error: e });
                return;
            }
        const id = `${st.dev}:${st.ino}`;
        if (entered.has(id)) {
            if (met !== null)
                again.add(met);
            return;
        }
        entered.add(id);
        const fresh = !listed.has(id);
        listed.add(id);
        let entries;
        try {
            entries = listBytes(d);
        }
        catch (e) {
            if (fresh)
                failed.push({ path: d, error: e });
            return;
        }
        stack.push({ d, id, entries, i: 0, fresh });
    };
    for (const p of paths) {
        let st;
        try {
            st = statSync(p);
        }
        catch (e) {
            failed.push({ path: p, error: e });
            continue;
        }
        if (!st.isDirectory()) {
            addFile(p, st);
            continue;
        }
        const entered = new Set();
        enter(p, entered, null, true, st);
        while (stack.length) {
            const top = stack[stack.length - 1];
            if (top.i >= top.entries.length) {
                stack.pop();
                continue;
            }
            const e = top.entries[top.i++], name = e.name.toString('utf8');
            // a name is opened by its text only when the text gives its bytes back: decoded, any other could name another
            // entry, a twin whose valid name has U+FFFD where it has bytes that are not UTF-8 (S374's closure read, S7)
            const valid = Buffer.from(name, 'utf8').equals(e.name), full = join(top.d, name);
            if (e.isSymbolicLink()) {
                if (top.fresh)
                    symlinks++;
            }
            else if (!valid) {
                if (top.fresh && (e.isDirectory() || name.endsWith('.jsonl')))
                    notUtf8.push({ dir: top.d, name: e.name, isDir: e.isDirectory() });
            }
            else if (e.isDirectory())
                enter(full, entered, `${top.id}/${name}`, top.fresh);
            else if (top.fresh && name.endsWith('.jsonl')) {
                if (!e.isFile())
                    special++; // a FIFO (reading it would wait), a socket, a device: counted, never opened
                else
                    try {
                        addFile(full, statSync(full));
                    }
                    catch (x) {
                        failed.push({ path: full, error: x });
                    }
            }
        }
    }
    return { files: [...files.values()].sort(), failed, symlinks, special, again: again.size, notUtf8 };
}
/** One read buffer for every file. */
const CHUNK = Buffer.allocUnsafe(1 << 20);
/** Calls onLine(bytes) for each line of the file, split on byte 0x0A (which never occurs inside a UTF-8 sequence; a last
 *  line without a new line is read), or onLine(null) for a line longer than maxLine bytes, whose bytes are passed over as
 *  they stream past and never held; onLine returns false to read no further. Memory: one chunk, plus at most maxLine
 *  bytes of one line. */
export function readLines(file, maxLine, onLine) {
    const fd = openSync(file, 'r');
    try {
        let parts = [], len = 0, skipping = false;
        for (;;) {
            const got = readSync(fd, CHUNK, 0, CHUNK.length, null);
            if (got === 0)
                break;
            let start = 0;
            while (start < got) {
                let nl = CHUNK.indexOf(10, start);
                if (nl >= got)
                    nl = -1;
                const end = nl < 0 ? got : nl;
                if (!skipping && len + (end - start) > maxLine) {
                    skipping = true;
                    parts = [];
                }
                if (!skipping && end > start)
                    parts.push(Buffer.from(CHUNK.subarray(start, end)));
                len += end - start;
                if (nl < 0)
                    break;
                if (onLine(skipping ? null : parts.length === 1 ? parts[0] : Buffer.concat(parts)) === false)
                    return;
                parts = [];
                len = 0;
                skipping = false;
                start = nl + 1;
            }
        }
        if (len > 0 || skipping)
            onLine(skipping ? null : parts.length === 1 ? parts[0] : Buffer.concat(parts));
    }
    finally {
        closeSync(fd);
    }
}
const tally = (c, fi) => { c[0]++; if (c[2] !== fi) {
    c[2] = fi;
    c[1]++;
} };
/** Is this the first line of what ltms shapes writes: a report's (k "shapes", its format ltms-shapes/...) or an
 *  --unlisted list's (k "unlisted-review", "send":false)? Read as JSON, a byte-order mark before it passed over. */
function isShapesOutput(line) {
    let s = line.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff)
        s = s.slice(1);
    let o;
    try {
        o = JSON.parse(s);
    }
    catch {
        return false;
    }
    if (!isObj(o))
        return false;
    const family = SHAPES_FORMAT.slice(0, SHAPES_FORMAT.indexOf('/') + 1);
    return (o.k === 'shapes' && typeof o.format === 'string' && o.format.startsWith(family)) || (o.k === 'unlisted-review' && o.send === false);
}
/** Reads the files, one at a time, each line alone, and counts. Per record: the version in force (the value at the first
 *  version path the record has, if it follows the version rule; (withheld) for any other value; else the version before
 *  it in the same file, or (none) before the file's first); its kind; and the walk, along vocabulary paths only: a key
 *  the vocabulary holds is counted at its path and walked, any other is counted at the .* of the object it is in, and
 *  the walk stops there. A file whose reading throws counts as failed; what was read of it before is counted. A file
 *  whose first line is a report's or an --unlisted list's is ltms shapes' own output: nothing of it is read, and it is
 *  listed in skipped. */
export function readShapes(V, files, opts) {
    const S = {
        filesRead: 0, filesFailed: 0, skipped: [], failures: [], records: 0, blank: 0, notJson: 0, notObject: 0, tooLong: 0,
        versions: new Map(), kinds: new Map(), lines: new Map(),
        unlisted: opts.unlisted ? new Map() : null, unlistedValues: opts.unlisted ? new Map() : null,
    };
    const unl = S.unlisted, unlVals = S.unlistedValues;
    const lineOf = (kind, path) => {
        const key = kind + KSEP + path;
        let L = S.lines.get(key);
        if (!L)
            S.lines.set(key, (L = { kind, path, n: 0, f: 0, last: -1, vers: new Set(), lastVer: undefined, sub: new Map(), names: null }));
        return L;
    };
    const bump = (L, group, label, fi) => {
        const key = group + SEP + label;
        let s = L.sub.get(key);
        if (!s)
            L.sub.set(key, (s = [0, 0, -1]));
        tally(s, fi);
    };
    /** --unlisted only: a value the vocabulary lacks at a path, for the person's own review; past the 2048 kept at a path,
     *  its occurrence is counted as a name's is (S374's closure read, S5). */
    const keepValue = (path, v, fi) => {
        if (!unlVals)
            return;
        let u = unlVals.get(path);
        if (!u)
            unlVals.set(path, (u = { names: new Map(), overflow: 0 }));
        let e = u.names.get(v);
        if (!e) {
            if (u.names.size >= SHAPES_NAMES_PER_PATH) {
                u.overflow++;
                return;
            }
            u.names.set(v, (e = [0, 0, -1]));
        }
        tally(e, fi);
    };
    // --unlisted: the paths a kind is read at (the kind path, each sub-kind's) where the walk keeps no value, so that the
    // reading of the kind keeps it there: a path with no value list (the walk keeps a value only at a path that lists
    // values), or one the walk does not reach (a step of it that paths does not list). Where the walk keeps a value, the
    // reading of the kind does not, so each is counted once (S374's closure read, U1).
    const walkReaches = (p) => { let acc = ''; for (const step of p.slice(1).split('.')) {
        acc += '.' + step;
        if (!V.paths.has(acc))
            return false;
    } return true; };
    const kindKeeps = new Set(unlVals ? kindPaths(V).filter((p) => !(V.values.has(p) && walkReaches(p))) : []);
    const kindOf = (rec, fi) => {
        if (!V.kindPath)
            return ALL;
        const t = getPlain(rec, V.kindPath);
        if (t === undefined)
            return NONE;
        if (typeof t !== 'string')
            return NOT_STRING;
        if (!V.values.get(V.kindPath)?.has(t)) {
            if (kindKeeps.has(V.kindPath))
                keepValue(V.kindPath, t, fi);
            return UNLISTED;
        }
        const sp = V.sub.get(t);
        if (!sp)
            return t;
        // the sub-kind as the kind path gives its own: (none), (not a string), a listed value, or (unlisted) (S374's
        // closure read, U14)
        const s = getPlain(rec, sp);
        if (s === undefined)
            return `${t}:${NONE}`;
        if (typeof s !== 'string')
            return `${t}:${NOT_STRING}`;
        if (V.values.get(sp)?.has(s))
            return `${t}:${s}`;
        if (kindKeeps.has(sp))
            keepValue(sp, s, fi);
        return `${t}:${UNLISTED}`;
    };
    const note = (L, v, fi, ver, path) => {
        L.n++;
        if (L.last !== fi) {
            L.last = fi;
            L.f++;
        }
        if (L.lastVer !== ver) {
            L.lastVer = ver;
            L.vers.add(ver);
        }
        const t = typeOf(v);
        bump(L, 'types', t, fi);
        if (typeof v === 'string') {
            bump(L, 'strings', stringClass(v), fi);
            const vs = path === null ? undefined : V.values.get(path);
            if (vs) {
                const ok = vs.has(v);
                bump(L, 'values', ok ? v : UNLISTED, fi);
                if (!ok && path !== null)
                    keepValue(path, v, fi); // --unlisted only: the value itself, for the person's own review
            }
        }
        else if (typeof v === 'number')
            bump(L, 'numbers', numberClass(v), fi);
        else if (typeof v === 'boolean')
            bump(L, 'booleans', String(v), fi);
        else if (Array.isArray(v))
            bump(L, 'lengths', capped(v.length), fi);
    };
    const noteUnlisted = (kind, star, name, v, fi, ver) => {
        const L = lineOf(kind, star);
        note(L, v, fi, ver, null);
        if (!L.names)
            L.names = new Set();
        if (L.names.size < CAP)
            L.names.add(name);
        if (unl) {
            let u = unl.get(star);
            if (!u)
                unl.set(star, (u = { names: new Map(), overflow: 0 }));
            let e = u.names.get(name);
            if (!e) {
                if (u.names.size >= SHAPES_NAMES_PER_PATH) {
                    u.overflow++;
                    return;
                }
                u.names.set(name, (e = [0, 0, -1]));
            }
            tally(e, fi);
        }
    };
    // the walk: an explicit stack of (value, path), along vocabulary paths only, so its depth is the vocabulary's, never
    // the record's (JSON.parse takes lines nested a million deep)
    const walk = (root, kind, fi, ver) => {
        const vals = [root], at = [''];
        while (vals.length) {
            const v = vals.pop(), p = at.pop();
            if (Array.isArray(v)) {
                if (!v.length)
                    continue; // an empty array has no element line: its own line counts its length, 0
                const cp = p + '[]', named = V.paths.has(cp), L = lineOf(kind, cp);
                for (const el of v) {
                    note(L, el, fi, ver, named ? cp : null);
                    if (named && el !== null && typeof el === 'object') {
                        vals.push(el);
                        at.push(cp);
                    }
                }
            }
            else {
                const o = v;
                for (const k of Object.keys(o)) {
                    const x = o[k], cp = p + '.' + k;
                    if (NAME.test(k) && V.paths.has(cp)) {
                        note(lineOf(kind, cp), x, fi, ver, cp);
                        if (x !== null && typeof x === 'object') {
                            vals.push(x);
                            at.push(cp);
                        }
                    }
                    else
                        noteUnlisted(kind, p + '.*', k, x, fi, ver);
                }
            }
        }
    };
    files.forEach((file, fi) => {
        let ver = NONE, first = true, own = false;
        try {
            readLines(file, opts.maxLine, (buf) => {
                // a first line that is a report's or an --unlisted list's: ltms shapes' own output (saved inside the folder it
                // reads, say), not a transcript; nothing of it is read or counted (S374's closure read, U5)
                if (first) {
                    first = false;
                    if (buf !== null && isShapesOutput(buf)) {
                        own = true;
                        return false;
                    }
                }
                if (buf === null) {
                    S.tooLong++;
                    return;
                }
                const s = buf.toString('utf8');
                if (/^\s*$/.test(s)) {
                    S.blank++;
                    return;
                }
                let rec;
                try {
                    rec = JSON.parse(s);
                }
                catch {
                    S.notJson++;
                    return;
                }
                if (!isObj(rec)) {
                    S.notObject++;
                    return;
                }
                S.records++;
                for (const vp of V.versions) {
                    const x = getPlain(rec, vp);
                    if (x !== undefined) {
                        ver = typeof x === 'string' && VERSION.test(x) ? x : WITHHELD;
                        break;
                    }
                }
                const kind = kindOf(rec, fi);
                let K = S.kinds.get(kind);
                if (!K)
                    S.kinds.set(kind, (K = { n: 0, f: 0, last: -1, vers: new Map() }));
                K.n++;
                if (K.last !== fi) {
                    K.last = fi;
                    K.f++;
                }
                let kv = K.vers.get(ver);
                if (!kv)
                    K.vers.set(ver, (kv = [0, 0, -1]));
                tally(kv, fi);
                let vv = S.versions.get(ver);
                if (!vv)
                    S.versions.set(ver, (vv = [0, 0, -1]));
                tally(vv, fi);
                walk(rec, kind, fi, ver);
            });
            if (own)
                S.skipped.push(file);
            else
                S.filesRead++;
        }
        catch (e) {
            S.filesFailed++;
            S.failures.push({ file, error: e });
        }
    });
    return S;
}
// ---- the report -----------------------------------------------------------------------------------------------------
const vkey = (v) => v.split('.').map(Number);
/** Numeric order; equal numbers by their text. The version rule gives each version one spelling, so two never tie; the
 *  text decides if a rule ever lets two spellings of one number through (1.2.3, 01.2.3), so that no order of the files
 *  or of the records, which decides where each was met first, reaches a report (S374's closure read, S4). Exported for
 *  the tests alone: no report reaches the tie-break, since every caller hands it versions by the rule (S375's known
 *  issue S4t); it is not a part of the module's use. */
export const vcmp = (a, b) => { const x = vkey(a), y = vkey(b); for (let i = 0; i < 3; i++)
    if (x[i] !== y[i])
        return x[i] - y[i]; return cmp(a, b); };
/** THE BUILDER'S ORDERS, each one function, which buildReport sorts by and the check (checkRows) holds a report to.
 *  Versions: in numeric order (equal numbers by their text), then the other tokens ((none), (withheld)) by their text. */
const versionOrder = (a, b) => {
    const sa = VERSION.test(a), sb = VERSION.test(b);
    return sa && sb ? vcmp(a, b) : sa ? -1 : sb ? 1 : cmp(a, b);
};
const sortVersions = (vs) => [...vs].sort(versionOrder);
/** Path lines: by kind, then by path. */
const pathOrder = (a, b) => cmp(a.kind, b.kind) || cmp(a.path, b.path);
/** A path line's maps of counts, in the order the line gives them. */
const GROUPS = ['types', 'strings', 'numbers', 'booleans', 'lengths', 'values'];
/** THE ORDER OF A MAP'S KEYS, as the builder writes them and the check holds a report to: the keys that are array indices
 *  (a whole number from 0 to 4294967294 written without leading zeros) first, in numeric order, then the others by their
 *  text, but an array's lengths in the order of their buckets, and (rare) last. This function gives the second part: the
 *  map is an object, built in its order (buildReport, and canonicalText for the check), and a JavaScript object lists
 *  its array-index keys first, in numeric order, whatever the order they were put in. So a value at a value path that is
 *  such a number comes first: 10, 9, 007 and abc are written 9, 10, 007, abc (007 is not one: it has a leading 0). The
 *  order is ltms-shapes/0's; a pure text order would be another format's (S375's known issue k11). */
const groupOrder = (g) => (a, b) => Number(a === RARE) - Number(b === RARE) || (g === 'lengths' ? CAP_LABELS.indexOf(a) - CAP_LABELS.indexOf(b) : cmp(a, b));
/** The report of a run. Every count becomes a bucket; a path line seen in fewer than floor files is not printed and is
 *  counted in its kind's rare line; a sub-count over fewer than floor files folds into (rare). The lines are sorted
 *  (versions in numeric order, equal numbers by their text, then kinds, then paths by kind and path, then the rare
 *  lines), and their fields come in a fixed order, so the same files give the same bytes whatever the order of the files
 *  and of the keys in each record. */
export function buildReport(V, S, floor, allowed) {
    const F = floor, out = [];
    out.push({
        k: 'shapes', format: SHAPES_FORMAT, vocabulary: V.list, floor: F, allowed: [...allowed],
        files: { read: bucket(S.filesRead), failed: bucket(S.filesFailed) },
        lines: { records: bucket(S.records), blank: bucket(S.blank), notJson: bucket(S.notJson), notObject: bucket(S.notObject), tooLong: bucket(S.tooLong) },
    });
    for (const v of sortVersions(S.versions.keys())) {
        const [n, f] = S.versions.get(v);
        out.push({ k: 'version', v, records: bucket(n), files: bucket(f) });
    }
    for (const kind of [...S.kinds.keys()].sort(cmp)) {
        const K = S.kinds.get(kind), versions = {};
        for (const v of sortVersions(K.vers.keys()))
            versions[v] = bucket(K.vers.get(v)[0]);
        out.push({ k: 'kind', kind, records: bucket(K.n), files: bucket(K.f), versions });
    }
    const rare = new Map();
    let pathLines = 0, printed = 0, belowFloor = 0;
    const lines = [...S.lines.values()].sort(pathOrder);
    for (const L of lines) {
        pathLines++;
        if (L.f < F) {
            belowFloor++;
            const r = rare.get(L.kind) ?? [0, 0];
            r[0]++;
            r[1] += L.n;
            rare.set(L.kind, r);
            continue;
        }
        printed++;
        const o = { k: 'path', kind: L.kind, path: L.path, n: bucket(L.n), files: bucket(L.f) };
        const vs = sortVersions([...L.vers].filter((v) => VERSION.test(v)));
        if (vs.length) {
            o.first = vs[0];
            o.last = vs[vs.length - 1];
        }
        const groups = new Map();
        for (const [key, [n, f]] of L.sub) {
            const i = key.indexOf(SEP), g = key.slice(0, i), label = key.slice(i + 1);
            let m = groups.get(g);
            if (!m)
                groups.set(g, (m = new Map()));
            if (f >= F)
                m.set(label, (m.get(label) ?? 0) + n);
            else
                m.set(RARE, (m.get(RARE) ?? 0) + n);
        }
        for (const g of GROUPS) {
            const m = groups.get(g);
            if (!m)
                continue;
            o[g] = Object.fromEntries([...m.keys()].sort(groupOrder(g)).map((x) => [x, bucket(m.get(x))]));
        }
        if (L.names)
            o.names = capped(L.names.size);
        out.push(o);
    }
    for (const kind of [...rare.keys()].sort(cmp)) {
        const [p, n] = rare.get(kind);
        out.push({ k: 'rare', kind, paths: bucket(p), n: bucket(n) });
    }
    out.push({ k: 'end', lines: out.length + 1 });
    return { lines: out, pathLines, printed, belowFloor };
}
// ---- the closed language: one check for the writer and for --check ---------------------------------------------------
/** Each line kind's fields, in the format's order: a path line has its first five always, and each of the rest when it
 *  has something to say there. Its keys give the line kinds, in the order a report gives them. */
const LINE_FIELDS = {
    shapes: ['k', 'format', 'vocabulary', 'floor', 'allowed', 'files', 'lines'],
    version: ['k', 'v', 'records', 'files'],
    kind: ['k', 'kind', 'records', 'files', 'versions'],
    path: ['k', 'kind', 'path', 'n', 'files', 'first', 'last', ...GROUPS, 'names'],
    rare: ['k', 'kind', 'paths', 'n'],
    end: ['k', 'lines'],
};
const PATH_REQUIRED = 5;
const LINE_KINDS = Object.keys(LINE_FIELDS);
/** The first line's files and lines, in order. */
const HEADER_FILES = ['read', 'failed'], HEADER_LINES = ['records', 'blank', 'notJson', 'notObject', 'tooLong'];
/** The language a report of this vocabulary and allowed list is written in. `expect`, at the write, is the run's floor
 *  and its number of lines. */
export function shapesLanguage(V, allowed, expect) {
    // THE KINDS A LINE MAY NAME: the format's four words for a kind, (none), (not a string), (unlisted) and (all), wherever
    // a kind stands, whatever the vocabulary; each kind at the kind path that has no sub-kind's path, the vocabulary's and
    // the allowed list's (applyAllow put those in V); and each kind that has one, joined to (unlisted), (none),
    // (not a string) and each value at its sub-kind's path, the vocabulary's and the allowed list's, never alone. That is
    // what kindOf can give, and more: (all) beside a kind path, and (none), (not a string) and (unlisted) without one. The
    // language is not narrowed to what kindOf gives: a word of the format leaks nothing, and a narrower language that
    // missed a kind kindOf can give would make a valid report fail its write (S375's known issue k3).
    const kindTokens = new Set([NONE, NOT_STRING, UNLISTED, ALL]);
    if (V.kindPath)
        for (const t of V.values.get(V.kindPath) ?? []) {
            const sp = V.sub.get(t);
            if (!sp) {
                kindTokens.add(t);
                continue;
            }
            for (const s of [UNLISTED, NONE, NOT_STRING, ...(V.values.get(sp) ?? [])])
                kindTokens.add(`${t}:${s}`);
        }
    return { V, allowed: [...allowed], kindTokens, floor: expect?.floor ?? null, lines: expect?.lines ?? null };
}
/** A path a line may print: a vocabulary path, one .* step past one (or the root's .*), or one [] step past one. */
function validPath(Lg, p) {
    if (typeof p !== 'string')
        return false;
    const P = Lg.V.paths;
    return P.has(p) || (p.endsWith('.*') && (p === '.*' || P.has(p.slice(0, -2)))) || (p.endsWith('[]') && P.has(p.slice(0, -2)));
}
const keysAre = (obj, req, opt = []) => isObj(obj) && Object.keys(obj).every((k) => req.includes(k) || opt.includes(k)) && req.every((k) => Object.hasOwn(obj, k));
const bucketMap = (m, allowedKey) => isObj(m) && Object.entries(m).every(([k, v]) => allowedKey(k) && isBucket(v));
const isVersionToken = (v) => typeof v === 'string' && (VERSION.test(v) || v === NONE || v === WITHHELD);
const isVersion = (v) => typeof v === 'string' && VERSION.test(v);
const inList = (list) => (k) => k === RARE || list.includes(k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Is this line in the report's language? null when it is; otherwise why not, as one of this function's own words, never
 *  a part of the line: 'not an object'; 'k' (no line kind of the format); 'fields' (one missing, or one its kind does
 *  not have); the name of the field that failed (S374's closure read, U10); or, on a path line whose fields each pass,
 *  what it says of itself that the builder never writes: 'first without last', 'last without first', 'first after
 *  last', 'n under files' (n's bucket below files', S375's known issue k10). */
export function checkLine(o, Lg) {
    if (!isObj(o))
        return 'not an object';
    switch (o.k) {
        case 'shapes': {
            if (!keysAre(o, LINE_FIELDS.shapes))
                return 'fields';
            if (o.format !== SHAPES_FORMAT)
                return 'format';
            if (!Array.isArray(o.vocabulary) || !same(o.vocabulary, Lg.V.list))
                return 'vocabulary';
            // a floor --floor takes: a whole number from 2 that a double holds exactly (S374's closure read, S3 and U6)
            if (typeof o.floor !== 'number' || !Number.isSafeInteger(o.floor) || o.floor < SHAPES_MIN_FLOOR || (Lg.floor !== null && o.floor !== Lg.floor))
                return 'floor';
            if (!Array.isArray(o.allowed) || !same(o.allowed, Lg.allowed))
                return 'allowed';
            if (!keysAre(o.files, HEADER_FILES) || !Object.values(o.files).every(isBucket))
                return 'files';
            if (!keysAre(o.lines, HEADER_LINES) || !Object.values(o.lines).every(isBucket))
                return 'lines';
            return null;
        }
        case 'version':
            if (!keysAre(o, LINE_FIELDS.version))
                return 'fields';
            if (!isVersionToken(o.v))
                return 'v';
            if (!isBucket(o.records))
                return 'records';
            if (!isBucket(o.files))
                return 'files';
            return null;
        case 'kind':
            if (!keysAre(o, LINE_FIELDS.kind))
                return 'fields';
            if (typeof o.kind !== 'string' || !Lg.kindTokens.has(o.kind))
                return 'kind';
            if (!isBucket(o.records))
                return 'records';
            if (!isBucket(o.files))
                return 'files';
            if (!bucketMap(o.versions, isVersionToken))
                return 'versions';
            return null;
        case 'path': {
            if (!keysAre(o, LINE_FIELDS.path.slice(0, PATH_REQUIRED), LINE_FIELDS.path.slice(PATH_REQUIRED)))
                return 'fields';
            if (typeof o.kind !== 'string' || !Lg.kindTokens.has(o.kind))
                return 'kind';
            if (!validPath(Lg, o.path))
                return 'path';
            if (!isBucket(o.n))
                return 'n';
            if (!isBucket(o.files))
                return 'files';
            const path = o.path;
            if (Object.hasOwn(o, 'first') && !isVersion(o.first))
                return 'first';
            if (Object.hasOwn(o, 'last') && !isVersion(o.last))
                return 'last';
            if (Object.hasOwn(o, 'types') && !bucketMap(o.types, inList(TYPES)))
                return 'types';
            if (Object.hasOwn(o, 'strings') && !bucketMap(o.strings, inList(STRING_CLASSES)))
                return 'strings';
            if (Object.hasOwn(o, 'numbers') && !bucketMap(o.numbers, inList(NUMBER_CLASSES)))
                return 'numbers';
            if (Object.hasOwn(o, 'booleans') && !bucketMap(o.booleans, inList(BOOLEANS)))
                return 'booleans';
            if (Object.hasOwn(o, 'lengths') && !bucketMap(o.lengths, inList(CAP_LABELS)))
                return 'lengths';
            if (Object.hasOwn(o, 'values')) {
                const vs = Lg.V.values.get(path);
                if (!vs || !bucketMap(o.values, (k) => k === RARE || k === UNLISTED || vs.has(k)))
                    return 'values';
            }
            if (Object.hasOwn(o, 'names') && (!path.endsWith('.*') || typeof o.names !== 'string' || !CAP_LABELS.includes(o.names)))
                return 'names';
            // what the line says of itself, as the builder always writes it (S375's known issue k10): a first version with a
            // last, and a last with a first; the first not later than the last; and no fewer occurrences than files (each file
            // it is in holds one at least), refused where the buckets decide it: n's bucket below files'
            const hasFirst = Object.hasOwn(o, 'first'), hasLast = Object.hasOwn(o, 'last');
            if (hasFirst && !hasLast)
                return 'first without last';
            if (hasLast && !hasFirst)
                return 'last without first';
            if (hasFirst && versionOrder(o.first, o.last) > 0)
                return 'first after last';
            if (bucketTop(o.n) < bucketBottom(o.files))
                return 'n under files';
            return null;
        }
        case 'rare':
            if (!keysAre(o, LINE_FIELDS.rare))
                return 'fields';
            if (typeof o.kind !== 'string' || !Lg.kindTokens.has(o.kind))
                return 'kind';
            if (!isBucket(o.paths))
                return 'paths';
            if (!isBucket(o.n))
                return 'n';
            return null;
        case 'end':
            if (!keysAre(o, LINE_FIELDS.end))
                return 'fields';
            if (typeof o.lines !== 'number' || !Number.isInteger(o.lines) || (Lg.lines !== null && o.lines !== Lg.lines))
                return 'lines';
            return null;
        default: return 'k';
    }
}
/** An empty line, or one of white space only. */
const BLANK = /^\s*$/;
/** The words of the report as a whole, beside checkLine's: a line that is 'blank' or 'not JSON'; a line that is in the
 *  language alone but not where it stands
 *  ('first line': line 1 is not a first line; 'second first line'; 'end before the last line'; 'order': out of the
 *  format's order of line kinds, or of its kind's order; 'repeat': the same key as the line of its kind before it;
 *  'under the floor': a path line in fewer files than the floor), one not written as the builder writes it ('form'), and
 *  the end ('cut': the last line is not an end line; 'count': the end line does not count the report's lines). */
export const CHECK_WORDS = ['blank', 'not JSON', 'first line', 'second first line', 'end before the last line', 'order', 'repeat', 'under the floor', 'form', 'cut', 'count'];
/** The builder's order of two lines of one kind (version, kind, path or rare), by their key: 0 for the same key. */
function lineOrder(a, b) {
    if (a.k === 'version')
        return versionOrder(a.v, b.v);
    if (a.k === 'path')
        return pathOrder(a, b);
    return cmp(a.kind, b.kind);
}
/** The largest count a bucket stands for: 0, 1, or the top of lo-hi. */
const bucketTop = (b) => Number(b.slice(b.indexOf('-') + 1));
/** The least count a bucket stands for: 0, 1, or the lo of lo-hi. */
const bucketBottom = (b) => Number(b.split('-')[0]);
/** A line as the builder writes it: its fields in the format's order (LINE_FIELDS), each map's keys in the builder's
 *  order, JSON.stringify's spelling. For a line checkLine passed; anything else is taken as it is, never thrown on. */
function canonicalText(o) {
    const pick = (m, keys) => (isObj(m) ? Object.fromEntries(keys.filter((k) => Object.hasOwn(m, k)).map((k) => [k, m[k]])) : m);
    const sorted = (m, order) => (isObj(m) ? Object.fromEntries(Object.keys(m).sort(order).map((k) => [k, m[k]])) : m);
    const c = pick(o, LINE_FIELDS[o.k] ?? []);
    if (o.k === 'shapes') {
        c.files = pick(o.files, HEADER_FILES);
        c.lines = pick(o.lines, HEADER_LINES);
    }
    else if (o.k === 'kind')
        c.versions = sorted(o.versions, versionOrder);
    else if (o.k === 'path')
        for (const g of GROUPS)
            if (Object.hasOwn(c, g))
                c[g] = sorted(c[g], groupOrder(g));
    return JSON.stringify(c);
}
/** THE CHECK OF A REPORT WHOLE, the same at the write and at --check (S374's closure read, S3 and U6). `rows` are its
 *  lines' text (null: a line that has none, an object JSON cannot write). Each line alone: JSON, an object, in the
 *  language (checkLine), and written byte for byte as the builder writes it (canonicalText: its fields in the format's
 *  order, each map's keys in the builder's order, each key once, no space, JSON's own spelling of every string and
 *  number). Then each line in its place: line 1 the first line, and no other; the line kinds in the format's order
 *  (shapes, version, kind, path, rare, end); within each kind, the lines strictly in the builder's order, so none
 *  repeats; a path line in at least the floor's files; one end line, the last, that counts the lines. A line that fails
 *  alone is not held to its place. Returns the problems, by line; none when the report is in the language. */
export function checkRows(rows, Lg) {
    const n = rows.length;
    if (!n)
        return [{ line: 1, why: 'first line' }];
    const read = rows.map((r) => {
        let o;
        if (r === null)
            return 'not JSON';
        if (BLANK.test(r))
            return 'blank';
        try {
            o = JSON.parse(r);
        }
        catch {
            return 'not JSON';
        }
        const why = checkLine(o, Lg);
        if (why !== null)
            return why;
        return canonicalText(o) === r ? o : 'form';
    });
    const head = read[0];
    // the floor: at the write, the run's; at --check, the one the first line states, when that line is in the language
    const floor = Lg.floor ?? (typeof head === 'object' ? head.floor : null);
    const problems = [];
    let prev = null;
    read.forEach((o, i) => {
        let why = null;
        if (typeof o === 'string')
            why = o;
        else if (i === 0)
            why = o.k === 'shapes' ? null : 'first line';
        else if (o.k === 'shapes')
            why = 'second first line';
        else if (o.k === 'end' && i !== n - 1)
            why = 'end before the last line';
        else {
            const d = prev === null ? 1 : LINE_KINDS.indexOf(o.k) - LINE_KINDS.indexOf(prev.k);
            const c = d === 0 && prev !== null ? lineOrder(prev, o) : 0;
            if (d < 0 || c > 0)
                why = 'order';
            else if (d === 0 && c === 0)
                why = 'repeat';
            else if (o.k === 'path' && floor !== null && bucketTop(o.files) < floor)
                why = 'under the floor';
        }
        if (why !== null)
            problems.push({ line: i + 1, why });
        else
            prev = o;
    });
    const last = read[n - 1];
    if (typeof last === 'object') {
        if (last.k !== 'end')
            problems.push({ line: n, why: 'cut' });
        else if (last.lines !== n)
            problems.push({ line: n, why: 'count' });
    }
    return problems;
}
/** THE WRITE GUARD, and the only way a report leaves this module. Each line is turned into the text that will be
 *  written; the report, that text, is checked whole (checkRows: each line parsed back and checked against the language,
 *  and each in its place) before any of it is written; and only that text is written: what is checked is exactly what
 *  goes out (an object whose JSON is not its own fields, through an inherited toJSON say, cannot pass as one line and be
 *  written as another: S374's closure read, S1). A report with any problem is not written at all: no part of a report
 *  out of the language (a line repeated, say) leaves, and which lines failed cannot be read from what does. `write` is
 *  given the text in parts of at most 1,000 lines. */
export function writeReport(lines, Lg, write) {
    const rows = lines.map((o) => {
        try {
            const s = JSON.stringify(o);
            return typeof s === 'string' ? s : null;
        }
        catch {
            return null;
        }
    });
    const reasons = checkRows(rows, Lg);
    const done = { written: 0, refused: new Set(reasons.map((p) => p.line)).size, reasons, bytes: 0 };
    if (reasons.length)
        return done;
    for (let i = 0; i < rows.length; i += 1000) {
        const part = rows.slice(i, i + 1000), text = part.join('\n') + '\n';
        write(text);
        done.written += part.length;
        done.bytes += Buffer.byteLength(text);
    }
    return done;
}
/** --check: is this report, every token of it and every line in its place, in its language? The language is the
 *  vocabulary given and the report's own allowed list (its first line), each of whose strings --allow must take: one it
 *  refuses is named (bad-allowed), by its index and the rule it breaks, and nothing else is checked. The report is
 *  checked whole as the writer checks it (checkRows), its floor the one its first line states. It cannot tell whether
 *  ltms wrote it, nor whether its counts are true. What ltms never writes, and an editor or a shell can add (S374's
 *  closure read, U10), is named for what it is: a byte-order mark before line 1, a carriage return at the end of a line
 *  (CR LF), blank lines after the last line; each is a problem, and is taken off for the rest of the check, so that the
 *  lines are checked as they would be without it. */
export function checkReport(text, V) {
    const own = [];
    if (text.charCodeAt(0) === 0xfeff) {
        own.push({ line: 1, why: 'byte-order mark' });
        text = text.slice(1);
    }
    const rows = text.split('\n');
    if (rows[rows.length - 1] === '')
        rows.pop();
    const all = rows.length;
    let cr = -1;
    rows.forEach((r, i) => { if (r.endsWith('\r')) {
        if (cr < 0)
            cr = i;
        rows[i] = r.slice(0, -1);
    } });
    if (cr >= 0)
        own.push({ line: cr + 1, why: 'carriage return' });
    let n = rows.length;
    while (n > 0 && BLANK.test(rows[n - 1]))
        n--;
    if (n === 0)
        return { k: 'not-a-report', why: all ? 'blank' : 'empty' };
    if (n < all)
        own.push({ line: n + 1, why: 'blank at the end' });
    rows.length = n;
    if (BLANK.test(rows[0]))
        return { k: 'not-a-report', why: 'blank' };
    let header;
    try {
        header = JSON.parse(rows[0]);
    }
    catch {
        return { k: 'not-a-report', why: 'not JSON' };
    }
    if (!isObj(header))
        return { k: 'not-a-report', why: 'not an object' };
    if (header.k === 'unlisted-review')
        return { k: 'not-a-report', why: 'unlisted' };
    if (header.k !== 'shapes' || !Array.isArray(header.allowed))
        return { k: 'not-a-report', why: 'not a first line' };
    // the report's language is made of its allowed list: each string --allow refuses is named, by its index and the rule it
    // breaks, and the report is not checked further (an entry that is not a string fails the first line's 'allowed')
    const kp = kindPaths(V), refused = [];
    header.allowed.forEach((s, index) => {
        const rule = typeof s === 'string' ? allowRule(s, kp) : null;
        if (rule !== null)
            refused.push({ index, rule: ALLOW_RULE_WORDS[rule](kp) });
    });
    if (refused.length)
        return { k: 'bad-allowed', refused };
    const allowed = applyAllow(V, header.allowed.filter((s) => typeof s === 'string'));
    const problems = [...own, ...checkRows(rows, shapesLanguage(V, allowed))].sort((a, b) => a.line - b.line);
    return { k: 'checked', lines: n, rows: all, problems, allowed };
}
/** --unlisted: NOT a report. The names and values the vocabulary lacks, read from the transcripts as written, for the
 *  person's own review before an --allow; every line says "send":false, and --check refuses the list. Exact counts. A
 *  name that cannot be a path step (a file path, say), or a value --allow refuses (not a label; ':' at a kind path),
 *  gets "allow":null: it can never be allowed. */
export function reviewLines(S, V) {
    const kp = kindPaths(V);
    const out = [{ k: 'unlisted-review', send: false, note: 'names the vocabulary does not hold, for your own review: do not send this list. To print one in a report, rerun with --allow <path>.' }];
    const unl = S.unlisted ?? new Map(), vals = S.unlistedValues ?? new Map();
    for (const star of [...unl.keys()].sort(cmp)) {
        const u = unl.get(star);
        for (const name of [...u.names.keys()].sort(cmp)) {
            const [n, f] = u.names.get(name);
            out.push({ k: 'unlisted', send: false, at: star, name, n, files: f, allow: NAME.test(name) ? star.slice(0, -1) + name : null });
        }
        if (u.overflow)
            out.push({ k: 'unlisted-more', send: false, at: star, n: u.overflow });
    }
    for (const vp of [...vals.keys()].sort(cmp)) {
        const u = vals.get(vp);
        for (const value of [...u.names.keys()].sort(cmp)) {
            const [n, f] = u.names.get(value);
            const allowable = LABEL.test(value) && !(value.includes(':') && kp.includes(vp));
            out.push({ k: 'unlisted-value', send: false, at: vp, value, n, files: f, allow: allowable ? `${vp}=${value}` : null });
        }
        if (u.overflow)
            out.push({ k: 'unlisted-more', send: false, at: vp, n: u.overflow });
    }
    return out;
}
export function reviewTotals(lines) {
    const t = { names: 0, namePaths: 0, values: 0, valuePaths: 0, moreNames: 0, moreNamePaths: 0, moreValues: 0, moreValuePaths: 0 };
    const np = new Set(), vp = new Set();
    for (const o of lines) {
        if (o.k === 'unlisted') {
            t.names++;
            np.add(o.at);
        }
        else if (o.k === 'unlisted-value') {
            t.values++;
            vp.add(o.at);
        }
        else if (o.k === 'unlisted-more' && typeof o.n === 'number') {
            if (String(o.at).endsWith('.*')) {
                t.moreNames += o.n;
                t.moreNamePaths++;
            }
            else {
                t.moreValues += o.n;
                t.moreValuePaths++;
            }
        }
    }
    t.namePaths = np.size;
    t.valuePaths = vp.size;
    return t;
}
