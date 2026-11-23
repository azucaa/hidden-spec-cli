// main.ts is mend, the CLI SPEC.md specifies. It implements every section of SPEC.md: the command line,
// output and exit codes, safe paths, format detection, the three-tier line matching of section 5, unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write of section 10. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): that hand-over and runner.ts are kept as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Move pairs recorded by move edits, used at output time for the `R` lines of section 2. */
const moves: { from: string; to: string }[] = [];

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

interface Found {
  tier: number;
  positions: number[];
}

/** Every position at which O occurs in `lines`, at the first tier that has one; null when none does. */
function findAll(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  if (o.length === 0) return null;
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (!lineEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body entry of a hunk, chunk or block: context, old-only or new-only, plus its text. */
interface Entry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
  /** True when the source patch line was completely empty (not a single-space context line). */
  emptySrc?: boolean;
}

/** The O and N line lists of a set of body entries, in body order. */
function oldNew(entries: Entry[]): { o: string[]; n: Entry[] } {
  const o: string[] = [];
  const n: Entry[] = [];
  for (const e of entries) {
    if (e.kind !== 'new') o.push(e.text);
    if (e.kind !== 'old') n.push(e);
  }
  return { o, n };
}

/**
 * The lines to write for N, given that O matched `fileLines` at `pos` and `tier`: a context line is the
 * file's own matched line, and at tier 2 every other new line is re-indented from O's first line's
 * leading whitespace to the file's first matched line's (SPEC.md section 5).
 */
function resolveNew(n: Entry[], entries: Entry[], fileLines: string[], pos: number, tier: number): string[] {
  const oTexts: string[] = [];
  for (const e of entries) if (e.kind !== 'new') oTexts.push(e.text);
  let oi = 0;
  const f = oTexts.length > 0 && pos >= 0 ? leadWs(fileLines[pos] ?? '') : '';
  const p = oTexts.length > 0 ? leadWs(oTexts[0]!) : '';
  const out: string[] = [];
  let oIdx = -1;
  // Walk the entries once, tracking which O index each context entry corresponds to.
  const ctxLine = new Map<Entry, string>();
  let k = 0;
  for (const e of entries) {
    if (e.kind !== 'new') {
      if (e.kind === 'ctx') ctxLine.set(e, fileLines[pos + k] ?? e.text);
      k += 1;
    }
  }
  void oi;
  void oIdx;
  for (const e of n) {
    if (e.kind === 'ctx') {
      out.push(ctxLine.get(e) ?? e.text);
    } else if (tier === 2 && e.text.trim() !== '') {
      out.push(e.text.startsWith(p) ? f + e.text.slice(p.length) : e.text);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the last context or `+` entry of a body (SPEC.md section 6). */
function lastPlusNoEol(entries: Entry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.kind !== 'old') return entries[i]!.noEol;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  entries: Entry[];
}

interface Section {
  startLine: number;
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function newSection(startLine: number): Section {
  return {
    startLine,
    gitOld: null,
    gitNew: null,
    headOld: null,
    headNew: null,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDel: false,
    hasPair: false,
    hunks: [],
  };
}

function headerPath(raw: string): string {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const isPairAt = (j: number): boolean => (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(i + 1);
      cur.gitOld = rest.slice(2, sep);
      cur.gitNew = rest.slice(sep + 3);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const entries: Entry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (isPairAt(j)) break;
        const c = bl[0];
        if (c === '\\') {
          if (entries.length > 0) entries[entries.length - 1]!.noEol = true;
          j += 1;
          continue;
        }
        if (bl === '') {
          entries.push({ kind: 'ctx', text: '', noEol: false, emptySrc: true });
          j += 1;
          continue;
        }
        if (c === ' ') entries.push({ kind: 'ctx', text: bl.slice(1), noEol: false });
        else if (c === '-') entries.push({ kind: 'old', text: bl.slice(1), noEol: false });
        else if (c === '+') entries.push({ kind: 'new', text: bl.slice(1), noEol: false });
        else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it (SPEC.md section 6); only a source line
      // that was completely empty counts, never a context line written as a single space.
      while (entries.length > 0 && entries[entries.length - 1]!.kind === 'ctx' && entries[entries.length - 1]!.emptySrc === true) {
        entries.pop();
      }
      cur.hunks.push({ a, entries });
      i = j;
      continue;
    }
    if (isPairAt(i)) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.headOld = headerPath(lines[i]!);
        cur.headNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = newSection(i + 1);
        cur.headOld = headerPath(lines[i]!);
        cur.headNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside a section's header.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    // Prose, code fences and anything else outside a body is ignored.
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  return {
    oldP: s.headOld ?? s.renameFrom ?? s.gitOld,
    newP: s.headNew ?? s.renameTo ?? s.gitNew,
  };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = sectionPaths(s);
    const creation = oldP === '/dev/null' || s.isNew;
    const deletion = newP === '/dev/null' || s.isDel;
    if (creation) {
      const target = newP;
      if (target === null || target === '/dev/null') throw new Exit2(`error: parse ${s.startLine}`);
      checkSafe(target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let lastPlus: Entry | null = null;
      for (const h of s.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'new') {
            out.push(e.text);
            lastPlus = e;
          }
        }
      }
      const text = out.length === 0 ? '' : out.join('\n') + (lastPlus !== null && lastPlus.noEol ? '' : '\n');
      tree.now.set(target, text);
      return;
    }
    if (deletion) {
      const target = oldP;
      if (target === null) throw new Exit2(`error: parse ${s.startLine}`);
      checkSafe(target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP;
    const dst = newP ?? oldP;
    if (src === null || dst === null) throw new Exit2(`error: parse ${s.startLine}`);
    checkSafe(src);
    const isMove = dst !== src;
    if (isMove) checkSafe(dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    if (s.hunks.length === 0) {
      if (isMove) {
        tree.now.set(src, null);
        tree.now.set(dst, before);
        moves.push({ from: src, to: dst });
      }
      return;
    }
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n } = oldNew(h.entries);
      if (o.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const atEnd = at === f.lines.length;
        const add = n.map((e) => e.text);
        f.lines.splice(at, 0, ...add);
        if (atEnd && f.lines.length > 0) f.final = !lastPlusNoEol(h.entries);
        d += add.length;
        continue;
      }
      const found = findAll(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', src);
      const want = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const cand of found.positions) {
        if (Math.abs(cand - want) < Math.abs(pos - want)) pos = cand;
      }
      const runsToEnd = pos + o.length === f.lines.length;
      const add = resolveNew(n, h.entries, f.lines, pos, found.tier);
      f.lines.splice(pos, o.length, ...add);
      if (runsToEnd) f.final = !lastPlusNoEol(h.entries);
      d += add.length - o.length;
    }
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(dst, text);
      moves.push({ from: src, to: dst });
    } else {
      tree.now.set(src, text);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    // The path: the nearest usable line before this SEARCH line, after the previous block.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b));
}

function searchReplaceEdit(b: Block): Edit {
  return (tree) => {
    checkSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const strictNow = strictFlag;
    const found = findAll(f.lines, b.oldLines, strictNow);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const entries: Entry[] = [
      ...b.oldLines.map((t) => ({ kind: 'old' as const, text: t, noEol: false })),
      ...b.newLines.map((t) => ({ kind: 'new' as const, text: t, noEol: false })),
    ];
    const nEntries = entries.filter((e) => e.kind === 'new');
    const add = resolveNew(nEntries, entries, f.lines, pos, found.tier);
    f.lines.splice(pos, b.oldLines.length, ...add);
    tree.now.set(b.path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isHead = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isHead(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const sec: VSection = { kind, path: line.slice(prefix.length).trim(), line: i + 1, addLines: [], moveTo: null, chunks: [] };
    i += 1;
    // Collect this section's raw lines, up to the next section header or the end of the patch.
    const raw: { text: string; no: number }[] = [];
    while (i < last && !isHead(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (kind === 'del') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      let chunk: Chunk | null = null;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        if (r.text.startsWith('@@')) {
          const anchor = r.text.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
          sec.chunks.push(chunk);
        } else if (r.text.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, entries: [] };
            sec.chunks.push(chunk);
          } else {
            chunk.eof = true;
          }
        } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, entries: [] };
            sec.chunks.push(chunk);
          }
          const kindE = r.text === '' || r.text[0] === ' ' ? 'ctx' : r.text[0] === '-' ? 'old' : 'new';
          chunk.entries.push({ kind: kindE, text: r.text === '' ? '' : r.text.slice(1), noEol: false });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
    sections.push(sec);
  }
  return sections.map((s) => v4aEdit(s));
}

function v4aEdit(s: VSection): Edit {
  return (tree) => {
    checkSafe(s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : `${s.addLines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null) checkSafe(s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const anchor = chunk.anchor;
        const top = strictFlag ? 0 : 2;
        let at = -1;
        for (let tier = 0; tier <= top && at < 0; tier += 1) {
          for (let j = cursor; j < f.lines.length; j += 1) {
            if (lineEq(f.lines[j]!, anchor, tier)) {
              at = j;
              break;
            }
          }
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const { o, n } = oldNew(chunk.entries);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const add = n.map((e) => e.text);
        f.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      let found = findAll(f.lines, o, strictFlag, cursor);
      if (found !== null && chunk.eof) {
        const ends = found.positions.filter((p) => p + o.length === f.lines.length);
        if (ends.length === 0) found = null;
        else found = { tier: found.tier, positions: ends };
      }
      if (found === null) throw new Fail('no-match', s.path);
      const pos = found.positions[0]!;
      const add = resolveNew(n, chunk.entries, f.lines, pos, found.tier);
      f.lines.splice(pos, o.length, ...add);
      cursor = pos + add.length;
    }
    const text = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      moves.push({ from: s.path, to: s.moveTo });
    } else {
      tree.now.set(s.path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The run itself (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

let strictFlag = false;

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictFlag = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof Exit2) return { code: 2, out: [e.line] };
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, in byte order; a qualifying move pair collapses into one `R` line sorted by its new path.
  const byNew = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const mv of moves) {
    const wasOld = tree.original(mv.from);
    const wasNew = tree.original(mv.to);
    const nowOld = tree.now.has(mv.from) ? tree.now.get(mv.from)! : tree.original(mv.from);
    const nowNew = tree.now.has(mv.to) ? tree.now.get(mv.to)! : tree.original(mv.to);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      byNew.set(mv.to, mv.from);
      movedFrom.add(mv.from);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p)) continue;
    if (byNew.has(p)) rows.push({ key: p, text: `R ${byNew.get(p)!} -> ${p}` });
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // Files deleted as the old side of a move still need their removal on disk.
  if (!check) {
    for (const p of movedFrom) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
