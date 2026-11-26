/* A Supstack vault on disk: its notes, the notebooks they sit in, its tasks, and the changes the app itself makes
   to them (create, edit, move, rename, delete to .trash). Every call looks at the folder again first, so changes
   made in the app or by sync are seen; the app in turn picks up what is written here. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  baseName, cleanTag, composeBody, composeNote, dirName, extractLinkpath, fillTemplate, fmInner, headingsText, matchRank,
  norm, noteLinks, noteTags, parentLinkpaths, parseQuery, parseYaml, plainText, sanitizeTitle, splitNote,
  TEMPLATE_SKIP_KEYS, toStringList,
} from "./core/frontmatter.js";
import { ohm, onow, orgDayEntries, orgParse, orgReadDate, orgSkip, orgTsParse, orgTsStr, oymd, opad, TASK_STATES } from "./core/org.js";
import { hasLegacyTasks, newId, parseTasks, serializeTasks, taskEntry, taskSetState, TASKS_PATH, withNoteId } from "./core/tasks.js";

export const CARDS = "cards";
export const DAILY = "daily notes";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** An error to show to the caller as it is: a note not found, a name taken, a change the vault's rules don't allow. */
export class VaultError extends Error {}

const key = (name) => name.normalize("NFC").toLowerCase();
const isMd = (p) => /\.md$/i.test(p);
const topFolder = (p) => (p.includes("/") ? p.slice(0, p.indexOf("/")).toLowerCase() : null);
const isoDay = (dn) => { const o = oymd(dn); return `${o.y}-${opad(o.m)}-${opad(o.d)}`; };
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const noteId = (n) => n.fm.id == null || n.fm.id === "" ? null : String(n.fm.id);
const taskTitle = (title) => title.replace(/\s*[\r\n]+\s*/g, " ").trim();
const taskTags = (tags) => tags.map(cleanTag).filter(Boolean);

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

/** A date as the app's date prompt reads it ("tomorrow 10:00", "fri", "+3d", "2026-11-20 +1w") or an Org timestamp. */
export function parseWhen(text) {
  const s = String(text).trim();
  const r = s && (/^[<[]/.test(s) ? orgTsParse(s) : orgReadDate(s));
  if (!r) throw new VaultError(`Cannot read the date "${text}". Use 2026-11-20, "2026-11-20 14:00", tomorrow, fri, +3d, optionally with a repeater (+1w, ++1m, .+3d) or a warning (-2d).`);
  return { active: true, dn: r.dn, time: r.time ?? null, end: r.end ?? null, rep: r.rep ?? null, warn: r.warn ?? null };
}

/** Put `block` at the end of the text, or at the end of the section under the heading `heading`. */
export function insertBlock(raw, block, heading) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const add = block.replace(/\r?\n/g, eol).replace(/\s+$/, "");
  if (!heading) return raw + (raw && !/\n$/.test(raw) ? eol : "") + add + eol;
  const lines = raw.split("\n");
  const want = norm(heading.replace(/^#+\s*/, "").trim());
  let at = -1, level = 0, end = lines.length, inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].replace(/\r$/, "");
    if (/^\s*(```|~~~)/.test(L)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = /^(#{1,6})[ \t]+(.*)$/.exec(L);
    if (!m) continue;
    if (at < 0) { if (norm(m[2].trim()) === want) { at = i; level = m[1].length; } }
    else if (m[1].length <= level) { end = i; break; }
  }
  if (at < 0) throw new VaultError(`No heading "${heading}" in the note.`);
  let ins = end;
  while (ins > at + 1 && !lines[ins - 1].trim()) ins--;
  const cr = eol === "\r\n" ? "\r" : "";
  const added = add.split(eol).map((l) => l + cr);
  if (ins === lines.length) { // the section runs to the end of the file
    const head = lines.slice(0, ins).join("\n");
    return head + (head.endsWith("\n") || !head ? "" : eol) + add + eol;
  }
  lines.splice(ins, 0, ...added);
  return lines.join("\n");
}

export class Vault {
  constructor(root, { readOnly = false } = {}) {
    this.root = path.resolve(root);
    this.readOnly = readOnly;
    this.notes = new Map(); // path → note
    this.allPaths = new Set();
    this.unreadable = [];
    this.byName = new Map();
    this.cache = new Map(); // path → { mtimeMs, size, note }
  }

  /* ---------- reading the folder */

  /** Look at the folder again: every .md outside hidden folders is a note. */
  async refresh() {
    const files = [];
    const walk = async (dir, rel) => {
      let ents;
      try { ents = await fs.readdir(dir, { withFileTypes: true }); }
      catch (e) { if (!rel) throw new VaultError(`Cannot read the vault folder ${this.root}: ${e.message}`); return; }
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.isFile()) files.push(r);
      }
    };
    await walk(this.root, "");
    this.allPaths = new Set(files);
    this.notes = new Map();
    this.unreadable = [];
    const cache = new Map();
    for (const p of files) {
      if (!isMd(p)) continue;
      try {
        const st = await fs.stat(this.abs(p));
        const c = this.cache.get(p);
        const note = c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c.note : this.parseNote(p, strictUtf8.decode(await fs.readFile(this.abs(p))), st.mtimeMs);
        cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, note });
        this.notes.set(p, note);
      } catch { this.unreadable.push(p); }
    }
    this.cache = cache;
    this.index();
    this.taskText = await readText(this.abs(TASKS_PATH));
    this.taskStore = parseTasks(this.taskText);
    this.taskMigrationRequired = this.taskText === null &&
      [...this.notes.values()].some((n) => n.raw.length <= 400000 && hasLegacyTasks(orgParse(n)));
    return this;
  }
  parseNote(p, raw, mtime) {
    const { fm: fmRaw, body } = splitNote(raw);
    let fm = {}, fmError = null;
    if (fmRaw) { try { fm = parseYaml(fmInner(fmRaw)); } catch (e) { fmError = String(e.message || e).split("\n")[0]; } }
    const created = Date.parse(fm.created ?? fm.date ?? "") || null;
    return { path: p, name: baseName(p), raw, body, fm, fmError, mtime, ctime: created || mtime, tags: noteTags(fm, body), links: noteLinks(body) };
  }
  /** Names, then the hierarchy: who is in which notebook, the order inside one, and who links to whom. */
  index() {
    this.byName = new Map();
    this.byId = new Map();
    for (const n of this.notes.values()) {
      const id = noteId(n);
      if (id && !this.byId.has(id)) this.byId.set(id, n);
    }
    for (const p of this.notes.keys()) { const k = key(baseName(p)); (this.byName.get(k) || this.byName.set(k, []).get(k)).push(p); }
    this.parents = new Map(); this.children = new Map(); this.childOrder = new Map(); this.linksIn = new Map(); this.unresolved = new Map();
    for (const n of this.notes.values()) {
      const ps = new Set(), missing = [];
      for (const lp of parentLinkpaths(n.fm.parents)) { const r = this.resolve(lp, n.path); if (!r) missing.push(lp); else if (r !== n.path) ps.add(r); }
      if (ps.size) this.parents.set(n.path, [...ps]);
      if (missing.length) this.unresolved.set(n.path, missing);
      for (const p of ps) (this.children.get(p) || this.children.set(p, []).get(p)).push(n.path);
      const order = parentLinkpaths(n.fm.child_order).map((lp) => this.resolve(lp, n.path)).filter(Boolean);
      if (order.length) this.childOrder.set(n.path, order);
      for (const lp of new Set(n.links)) { const r = this.resolve(lp, n.path); if (r && r !== n.path) (this.linksIn.get(r) || this.linksIn.set(r, new Set()).get(r)).add(n.path); }
    }
  }
  abs(rel) {
    const a = path.resolve(this.root, rel);
    if (a !== this.root && !a.startsWith(this.root + path.sep)) throw new VaultError(`"${rel}" is outside the vault.`);
    return a;
  }
  /** The folder's name as it is in this vault (any letter case), else its usual name. */
  folder(name) {
    for (const p of this.allPaths) if (topFolder(p) === name) return p.slice(0, p.indexOf("/"));
    return name;
  }

  /* ---------- finding notes */

  /** Link resolution as in the app: an exact path, then by name (the same folder first, then the shortest path). */
  resolve(linkpath, source = "") {
    if (!linkpath) return null;
    const lp = linkpath.trim().replace(/\\/g, "/");
    if (!lp) return null;
    const lower = key(lp);
    const withMd = isMd(lp) ? lower : lower + ".md";
    if (lp.includes("/")) {
      const rel = (dirName(source) ? key(dirName(source)) + "/" : "") + withMd;
      for (const p of this.notes.keys()) { const pl = key(p); if (pl === withMd || pl === rel) return p; }
    }
    const cands = this.byName.get(baseName(withMd));
    if (!cands?.length) return null;
    if (lp.includes("/")) { const hit = cands.find((p) => key(p).endsWith("/" + withMd)); if (hit) return hit; }
    if (cands.length === 1) return cands[0];
    return cands.find((p) => dirName(p) === dirName(source)) || [...cands].sort((a, b) => a.length - b.length)[0];
  }
  /** A note by its name, its path or a [[link]] to it. */
  find(ref) {
    const lp = extractLinkpath(String(ref ?? ""));
    return lp ? this.resolve(lp) : null;
  }
  need(ref) {
    const p = this.find(ref);
    if (p) return this.notes.get(p);
    const words = norm(String(ref)).split(/\s+/).filter(Boolean);
    const near = [...this.notes.values()].filter((n) => words.some((w) => norm(n.name).includes(w))).slice(0, 5).map((n) => n.name);
    throw new VaultError(`No note named "${ref}".` + (near.length ? ` Similar names: ${near.join("; ")}.` : " Use search_notes to find it."));
  }
  parentsOf(p) { return this.parents.get(p) ?? []; }
  childrenOf(p) { return this.children.get(p) ?? []; }
  roots() { return [...this.notes.keys()].filter((p) => !this.parentsOf(p).length); }
  isDescendant(from, to) {
    const stack = [from], seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.childrenOf(cur));
    }
    return false;
  }
  /** Everything inside a notebook, through every level. */
  descendants(p) {
    const out = new Set(), stack = [...this.childrenOf(p)];
    while (stack.length) { const c = stack.pop(); if (out.has(c)) continue; out.add(c); stack.push(...this.childrenOf(c)); }
    return out;
  }
  comparator(mode) {
    const info = (p) => { const n = this.notes.get(p); const o = Number(n.fm.order); return { order: Number.isFinite(o) ? o : Number.MAX_SAFE_INTEGER, name: n.name, mtime: n.mtime, ctime: n.ctime }; };
    const byName = (a, b) => nameCollator.compare(a.name, b.name);
    return (pa, pb, parent) => {
      if (mode === "manual" && parent) {
        const order = this.childOrder.get(parent) ?? [];
        const ia = order.indexOf(pa), ib = order.indexOf(pb);
        if (ia >= 0 || ib >= 0) { if (ia < 0) return 1; if (ib < 0) return -1; if (ia !== ib) return ia - ib; }
      }
      const a = info(pa), b = info(pb);
      if (mode === "name") return byName(a, b);
      if (mode === "modified") return b.mtime - a.mtime || byName(a, b);
      if (mode === "created") return b.ctime - a.ctime || byName(a, b);
      return a.order - b.order || byName(a, b);
    };
  }
  sortedChildren(parent, mode = "manual") {
    const cmp = this.comparator(mode);
    return (parent ? [...this.childrenOf(parent)] : this.roots()).sort((a, b) => cmp(a, b, parent));
  }
  summary(p) {
    const n = this.notes.get(p);
    const out = { name: n.name, path: p };
    const ps = this.parentsOf(p);
    if (ps.length) out.notebooks = ps.map(baseName);
    const kids = this.childrenOf(p).length;
    if (kids) out.notes_inside = kids;
    if (n.tags.length) out.tags = n.tags;
    out.modified = new Date(n.mtime).toISOString().slice(0, 16).replace("T", " ");
    return out;
  }

  /* ---------- reading */

  info() {
    const tags = new Map();
    for (const n of this.notes.values()) for (const t of n.tags) tags.set(t, (tags.get(t) || 0) + 1);
    const T = onow().dn;
    let open = 0, overdue = 0, today = 0;
    for (const e of this.entries()) {
      if (orgSkip(e) || e.done || !e.isTodo) continue;
      open++;
      const d = Math.min(e.dead?.active ? e.dead.dn : Infinity, e.sched?.active ? e.sched.dn : Infinity);
      if (d < T) overdue++; else if (d === T) today++;
    }
    return {
      vault: this.root, read_only: this.readOnly, today: `${isoDay(T)} ${WEEKDAYS[oymd(T).w]}`, notes: this.notes.size,
      notebooks: [...this.notes.keys()].filter((p) => this.childrenOf(p).length).length,
      top_level: this.sortedChildren(null).slice(0, 100).map((p) => { const k = this.childrenOf(p).length; return k ? `${baseName(p)} (${k})` : baseName(p); }),
      tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100).map(([t, n]) => `${t} (${n})`),
      tasks: { open, overdue, due_today: today },
      ...(this.taskMigrationRequired ? { task_migration_required: true } : {}),
      ...(this.unreadable.length ? { unreadable_files: this.unreadable } : {}),
    };
  }
  list({ notebook = null, depth = 1, sort = "manual", limit = 200 } = {}) {
    const target = notebook ? this.need(notebook).path : null;
    const out = [], seen = new Set(target ? [target] : []);
    let truncated = false;
    const walk = (paths, level) => {
      for (const p of paths) {
        if (seen.has(p)) continue;
        if (out.length >= limit) { truncated = true; return; }
        seen.add(p);
        const s = this.summary(p);
        if (depth > 1) s.level = level;
        out.push(s);
        if (level < depth) walk(this.sortedChildren(p, sort), level + 1);
      }
    };
    walk(this.sortedChildren(target, sort), 1);
    return { notebook: target ? baseName(target) : "All notes (top level)", count: out.length, ...(truncated ? { truncated: true } : {}), notes: out };
  }
  read(ref) {
    const n = this.need(ref);
    const meta = this.summary(n.path);
    const missing = this.unresolved.get(n.path);
    if (missing) meta.notebooks_not_found = missing;
    if (n.fmError) meta.frontmatter_error = n.fmError;
    const kids = this.sortedChildren(n.path);
    if (kids.length) { delete meta.notes_inside; meta.notes_inside = kids.map(baseName); }
    const back = [...(this.linksIn.get(n.path) ?? [])].map(baseName).sort(nameCollator.compare);
    if (back.length) meta.linked_from = back;
    const tasks = this.entries(new Set([n.path])).filter((e) => e.isTodo);
    if (tasks.length) meta.tasks = { open: tasks.filter((e) => !e.done).length, closed: tasks.filter((e) => e.done).length };
    const boxes = orgParse(n).filter((e) => e.isTodo && e.kw !== "cancel" && e.kw !== "fwd");
    if (boxes.length) meta.checklist = { total: boxes.length, done: boxes.filter((e) => e.kw === "done").length };
    return { meta, text: n.raw };
  }
  search({ query, notebook = null, limit = 30 }) {
    const q = parseQuery(query);
    const scope = notebook ? this.descendants(this.need(notebook).path) : null;
    const hits = [];
    for (const n of this.notes.values()) {
      if (scope && !scope.has(n.path)) continue;
      const tags = n.tags.map((t) => norm(t.slice(1)));
      if (q.include.some((t) => !tags.includes(t)) || q.exclude.some((t) => tags.includes(t))) continue;
      const text = norm(n.name + "\n" + n.raw);
      if (!q.words.every((w) => text.includes(w))) continue;
      hits.push({ n, rank: q.words.length ? matchRank(q.words, n.name, headingsText(n.body)) : 1 });
    }
    hits.sort((a, b) => b.rank - a.rank || b.n.mtime - a.n.mtime);
    const found = hits.slice(0, limit).map(({ n }) => {
      const s = this.summary(n.path);
      const lines = n.body.split("\n");
      const i = q.words.length ? lines.findIndex((l) => q.words.some((w) => norm(l).includes(w))) : -1;
      const line = i >= 0 ? lines[i].trim() : plainText(n.body, 160);
      if (line) s.match = line.length > 240 ? line.slice(0, 240) + "…" : line;
      return s;
    });
    return { query, found: hits.length, ...(hits.length > limit ? { showing: limit } : {}), notes: found };
  }

  /* ---------- writing */

  canWrite() { if (this.readOnly) throw new VaultError("The server was started with --read-only: the vault cannot be changed."); }
  async write(p, raw) {
    this.canWrite();
    const a = this.abs(p);
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.writeFile(a, raw, "utf8");
    this.allPaths.add(p);
  }
  async updateFM(p, fn) {
    const n = this.notes.get(p);
    if (n.fmError) throw new VaultError(`The properties of "${n.name}" are not valid YAML (${n.fmError}); fix them first.`);
    const fm = structuredClone(n.fm);
    fn(fm);
    const raw = composeNote(fm, n.body);
    if (raw !== n.raw) await this.write(p, raw);
    return raw !== n.raw;
  }
  linkTo(p) { return `[[${(this.byName.get(key(baseName(p))) || []).length > 1 ? p.replace(/\.md$/i, "") : baseName(p)}]]`; }

  async create({ title, body = "", notebooks = [], tags = [], icon = null }) {
    this.canWrite();
    const clean = sanitizeTitle(title);
    if (!clean) throw new VaultError("The title is empty.");
    const taken = this.byName.get(key(clean));
    if (taken) throw new VaultError(`A note named "${baseName(taken[0])}" already exists (${taken[0]}). Names are unique in a vault: pick another title or change that note.`);
    const parents = [...new Set(notebooks.map((r) => this.need(r).path))];
    const first = parents[0];
    const folder = first && topFolder(first) === CARDS ? dirName(first) : this.folder(CARDS);
    const p = folder + "/" + clean + ".md";
    if ([...this.allPaths].some((x) => key(x) === key(p))) throw new VaultError(`A file ${p} already exists.`);
    // the template the first notebook gives its notes (child_template), as the app applies it
    let fm = {}, tplBody = "";
    const tplLink = first && parentLinkpaths(this.notes.get(first).fm.child_template)[0];
    const tpl = tplLink ? this.notes.get(this.resolve(tplLink, first)) : null;
    const now = new Date();
    if (tpl) {
      for (const [k, v] of Object.entries(tpl.fm)) {
        if (TEMPLATE_SKIP_KEYS.has(k) || k === "parents" || k === "id") continue;
        fm[k] = typeof v === "string" ? fillTemplate(v, clean, now) : structuredClone(v);
      }
      tplBody = fillTemplate(tpl.body, clean, now);
    }
    if (parents.length) fm = { parents: parents.map((x) => this.linkTo(x)), ...fm };
    const tg = tags.map(cleanTag).filter(Boolean);
    if (tg.length) fm.tags = [...new Set([...toStringList(fm.tags), ...tg])];
    if (icon) fm.icon = icon;
    await this.write(p, composeNote(fm, composeBody(tplBody, body)));
    return { created: clean, path: p, ...(parents.length ? { notebooks: parents.map(baseName) } : {}), ...(tpl ? { template: tpl.name } : {}) };
  }

  /** Change a note's text; its properties (frontmatter) stay as they are. */
  async edit({ note, body, append, heading, replace }) {
    this.canWrite();
    const n = this.need(note);
    const fmRaw = n.raw.slice(0, n.raw.length - n.body.length);
    let text = n.body;
    const did = [];
    if (body != null) { text = body; did.push("text replaced"); }
    for (const r of replace ?? []) {
      const count = text.split(r.old).length - 1;
      if (!r.old || !count) throw new VaultError(`The text to replace was not found in "${n.name}": ${JSON.stringify(r.old.slice(0, 120))}. Read the note and copy the text exactly.`);
      if (count > 1 && !r.all) throw new VaultError(`The text to replace occurs ${count} times in "${n.name}": give more of the surrounding text, or set all to true.`);
      text = text.split(r.old).join(r.new);
      did.push(count > 1 ? `${count} replacements` : "1 replacement");
    }
    if (append != null && append.trim()) { text = insertBlock(text, append, heading); did.push(heading ? `added under "${heading}"` : "appended"); }
    if (!did.length) throw new VaultError("Nothing to change: give body, append or replace.");
    if (fmRaw + text !== n.raw) await this.write(n.path, fmRaw + text);
    return { note: n.name, path: n.path, changes: did };
  }

  /** A note's notebooks, tags and icon. */
  async organize({ note, notebooks, add_to, remove_from, tags, add_tags, remove_tags, icon }) {
    this.canWrite();
    const n = this.need(note);
    let ps = this.parentsOf(n.path);
    const want = (refs) => [...new Set(refs.map((r) => this.need(r).path))];
    if (notebooks) ps = want(notebooks);
    if (add_to) for (const p of want(add_to)) if (!ps.includes(p)) ps.push(p);
    if (remove_from) { const gone = new Set(want(remove_from)); ps = ps.filter((p) => !gone.has(p)); }
    for (const p of ps) {
      if (p === n.path) throw new VaultError("A note cannot be its own notebook.");
      if (this.isDescendant(n.path, p)) throw new VaultError(`"${baseName(p)}" is inside "${n.name}", so "${n.name}" cannot go into it.`);
    }
    const parentsChanged = notebooks || add_to || remove_from;
    const changed = await this.updateFM(n.path, (fm) => {
      if (parentsChanged) {
        // keep the entries as they are written; links to notebooks that don't exist stay too, unless the list is set anew
        const kept = notebooks ? [] : toStringList(fm.parents).filter((e) => { const lp = extractLinkpath(e); const r = lp && this.resolve(lp, n.path); return r ? ps.includes(r) : true; });
        const have = new Set(kept.map((e) => this.resolve(extractLinkpath(e), n.path)));
        const list = [...kept, ...ps.filter((p) => !have.has(p)).map((p) => this.linkTo(p))];
        if (list.length) fm.parents = list; else delete fm.parents;
      }
      if (tags || add_tags || remove_tags) {
        let list = tags ? [] : toStringList(fm.tags ?? fm.tag).flatMap((s) => s.split(/[,\s]+/)).map((s) => s.replace(/^#/, "")).filter(Boolean);
        for (const t of [...(tags ?? []), ...(add_tags ?? [])].map(cleanTag).filter(Boolean)) if (!list.some((x) => norm(x) === norm(t))) list.push(t);
        const drop = new Set((remove_tags ?? []).map((t) => norm(cleanTag(t))));
        list = list.filter((x) => !drop.has(norm(x)));
        delete fm.tag;
        if (list.length) fm.tags = list; else delete fm.tags;
      }
      if (icon !== undefined) { if (icon) fm.icon = icon; else delete fm.icon; }
    });
    const out = { note: n.name, changed, notebooks: ps.map(baseName) };
    const inBody = (remove_tags ?? []).map(cleanTag).filter((t) => [...n.body.matchAll(/(^|[\s,;])#([\p{L}\p{N}_/-]+)/gu)].some((m) => norm(m[2]) === norm(t)));
    if (inBody.length) out.note_text_still_has = inBody.map((t) => "#" + t);
    return out;
  }

  /** The order of the notes in a notebook (child_order); notes not named keep their order after the named ones. */
  async reorder({ notebook, order }) {
    this.canWrite();
    const nb = this.need(notebook);
    const kids = this.sortedChildren(nb.path);
    const named = [];
    for (const r of order) {
      const p = this.need(r).path;
      if (!kids.includes(p)) throw new VaultError(`"${baseName(p)}" is not in the notebook "${nb.name}".`);
      if (!named.includes(p)) named.push(p);
    }
    const all = [...named, ...kids.filter((p) => !named.includes(p))];
    await this.updateFM(nb.path, (fm) => { fm.child_order = all.map((p) => this.linkTo(p)); });
    return { notebook: nb.name, order: all.map(baseName) };
  }

  /** Rename a note and update the links to it everywhere. */
  async rename({ note, title }) {
    this.canWrite();
    const n = this.need(note);
    const clean = sanitizeTitle(title);
    if (!clean) throw new VaultError("The new title is empty.");
    if (clean === n.name) return { note: n.name, renamed: false };
    const taken = (this.byName.get(key(clean)) || []).filter((p) => p !== n.path);
    if (taken.length) throw new VaultError(`A note named "${baseName(taken[0])}" already exists (${taken[0]}).`);
    const to = (dirName(n.path) ? dirName(n.path) + "/" : "") + clean + ".md";
    if ([...this.allPaths].some((x) => x !== n.path && key(x) === key(to))) throw new VaultError(`A file ${to} already exists.`);
    const rewrites = [];
    for (const other of this.notes.values()) {
      if (other.path === n.path) continue;
      const raw = other.raw.replace(/(!?\[\[)([^\]|#]+)([^\]]*\]\])/g, (m, a, lp, rest) => (this.resolve(lp, other.path) === n.path ? a + clean + rest : m));
      if (raw !== other.raw) rewrites.push([other.path, raw]);
    }
    // links the note has to itself
    const own = n.raw.replace(/(!?\[\[)([^\]|#]+)([^\]]*\]\])/g, (m, a, lp, rest) => (this.resolve(lp, n.path) === n.path ? a + clean + rest : m));
    await this.write(to, own);
    if (key(to) !== key(n.path)) await fs.rm(this.abs(n.path));
    else if (to !== n.path) await fs.rename(this.abs(n.path), this.abs(to)); // only the letter case changed
    for (const [p, raw] of rewrites) await this.write(p, raw);
    return { renamed: n.name, to: clean, path: to, links_updated_in: rewrites.map(([p]) => baseName(p)) };
  }

  /** Delete a note the way the app does: a copy goes to .trash, the notes inside it stay. */
  async remove({ note }) {
    this.canWrite();
    const n = this.need(note);
    const file = n.path.split("/").pop();
    let tp = ".trash/" + file, i = 1;
    const exists = async (p) => fs.access(this.abs(p)).then(() => true, () => false);
    while (await exists(tp)) tp = `.trash/${n.name} ${i++}.md`;
    await this.write(tp, n.raw);
    this.allPaths.delete(tp);
    await fs.rm(this.abs(n.path));
    const kids = this.childrenOf(n.path).map(baseName);
    const back = [...(this.linksIn.get(n.path) ?? [])].map(baseName);
    return { deleted: n.name, copy: tp, ...(kids.length ? { notes_that_were_inside_now_without_it: kids } : {}), ...(back.length ? { links_now_broken_in: back } : {}) };
  }

  /* ---------- daily notes */

  dailyPath(dn) { return this.folder(DAILY) + "/" + isoDay(dn) + ".md"; }
  /** The daily note of a day, created empty (as the app does) when it is not there yet. */
  async daily(date, { create = true } = {}) {
    const dn = date ? parseWhen(date).dn : onow().dn;
    const p = this.dailyPath(dn);
    const have = [...this.notes.keys()].find((x) => key(x) === key(p));
    if (have) return have;
    if (!create) return null;
    await this.write(p, "");
    await this.refresh();
    return p;
  }

  /* ---------- tasks */

  /** Tasks and events from the active store. The archive and note checklists are separate. */
  entries(scope = null) {
    const out = [];
    for (const rec of this.taskStore.records.values()) {
      const note = this.byId.get(rec.note);
      if (!scope || scope.has(note?.path)) out.push(taskEntry(rec, note));
    }
    return out;
  }
  taskOut(e) {
    const o = { id: e.id, note: e.note, state: e.kw, title: e.title };
    if (e.noteGone) o.note_missing = true;
    if (e.pri) o.priority = e.pri;
    if (e.sched) o.scheduled = orgTsStr(e.sched);
    if (e.dead) o.deadline = orgTsStr(e.dead);
    if (e.closed) o.closed = orgTsStr(e.closed);
    if (e.alltags.length) o.tags = e.alltags;
    return o;
  }
  tasks({ states = ["open"], note = null, notebook = null, tag = null, priority = null, due = null, query = null, limit = 100 } = {}) {
    const want = new Set();
    for (const s of states) {
      if (s === "open") TASK_STATES.filter((x) => x.open).forEach((x) => want.add(x.id));
      else if (s === "closed") TASK_STATES.filter((x) => !x.open).forEach((x) => want.add(x.id));
      else if (s === "all") TASK_STATES.forEach((x) => want.add(x.id));
      else want.add(s);
    }
    let scope = null;
    if (note) scope = new Set([this.need(note).path]);
    else if (notebook) { const p = this.need(notebook).path; scope = this.descendants(p); scope.add(p); }
    const T = onow().dn;
    const date = (e) => Math.min(e.dead?.active ? e.dead.dn : Infinity, e.sched?.active ? e.sched.dn : Infinity);
    const tg = tag ? norm(cleanTag(tag)) : null, q = query ? norm(query) : null;
    const hits = this.entries(scope).filter((e) => {
      if (!e.isTodo || orgSkip(e) || !want.has(e.kw)) return false;
      if (tg && !e.alltags.some((x) => norm(x) === tg)) return false;
      if (priority && e.pri !== priority) return false;
      if (q && !norm(e.fullTitle).includes(q)) return false;
      const d = date(e);
      if (due === "overdue") return d < T;
      if (due === "today") return d <= T;
      if (due === "week") return d <= T + 7;
      if (due === "dated") return d !== Infinity;
      if (due === "undated") return d === Infinity;
      return true;
    });
    const pri = (e) => (e.pri ? e.pri.charCodeAt(0) : 68.5); // no priority sorts between C and D
    hits.sort((a, b) => date(a) - date(b) || pri(a) - pri(b) || (a.path ?? "").localeCompare(b.path ?? "") || a.id.localeCompare(b.id));
    return { today: isoDay(T), found: hits.length, ...(hits.length > limit ? { showing: limit } : {}), tasks: hits.slice(0, limit).map((e) => this.taskOut(e)) };
  }
  agenda({ from = null, days = 7 } = {}) {
    const T = onow().dn;
    const start = from ? parseWhen(from).dn : T;
    const all = this.entries();
    const carried = T >= start && T < start + days;
    const out = [];
    for (let dn = start; dn < start + days; dn++) {
      const ents = orgDayEntries(dn, all, T, { log: true, carried }).map((x) => {
        const o = {};
        if (x.time != null) o.time = ohm(x.time) + (x.end != null ? "-" + ohm(x.end) : "");
        if (x.label) o.what = x.label;
        if (x.overdue) o.overdue = true;
        const e = x.e;
        Object.assign(o, { id: e.id, title: e.title, ...(e.isTodo ? { state: e.kw } : { event: true }), ...(e.pri ? { priority: e.pri } : {}), note: e.note });
        if (e.noteGone) o.note_missing = true;
        return o;
      });
      out.push({ date: isoDay(dn), day: WEEKDAYS[oymd(dn).w] + (dn === T ? " (today)" : ""), entries: ents });
    }
    return { today: isoDay(T), days: out };
  }

  canWriteTasks() {
    this.canWrite();
    if (this.taskMigrationRequired) throw new VaultError("Open this vault in Supstack 0.38 or later and move its legacy tasks out of the notes before adding or updating tasks.");
  }

  /** Publish complete text and catch changes made since the tool read the file. */
  async replaceTaskFile(rel, before, text) {
    const dest = this.abs(rel);
    const temp = path.join(path.dirname(dest), `.supstack-mcp-${randomUUID()}.tmp`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.writeFile(temp, text, { encoding: "utf8", flag: "wx" });
      if (await readText(dest) !== before) throw new VaultError(`${rel} changed on disk. Re-read the vault before retrying.`);
      await fs.rename(temp, dest);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  async ensureNoteId(n) {
    const existing = noteId(n);
    if (existing) return existing;
    if (n.fmError) throw new VaultError(`The properties of "${n.name}" are not valid YAML (${n.fmError}); fix them first.`);
    const id = newId("n");
    await this.replaceTaskFile(n.path, n.raw, withNoteId(n.raw, id));
    this.byId.set(id, n);
    return id;
  }

  async saveTask(rec) {
    const { records, extra } = this.taskStore;
    records.set(rec.id, rec);
    await this.replaceTaskFile(TASKS_PATH, this.taskText, serializeTasks(records, extra));
    return this.taskOut(taskEntry(rec, this.byId.get(rec.note)));
  }

  async addTask({ title, note = null, state = "todo", priority = null, tags = [], scheduled = null, deadline = null }) {
    this.canWriteTasks();
    const st = TASK_STATES.find((s) => s.id === state);
    const text = taskTitle(title);
    if (!text) throw new VaultError("The task's title is empty.");
    const now = new Date().toISOString();
    const rec = { id: newId("t"), state: " ", title: text, pri: priority, tags: taskTags(tags), created: now, upd: now };
    if (deadline != null) rec.dead = orgTsStr(parseWhen(deadline));
    if (scheduled != null) rec.sched = orgTsStr(parseWhen(scheduled));
    const said = st.ch === " " ? null : taskSetState(rec, st);
    if (note) rec.note = await this.ensureNoteId(this.need(note));
    return { added: await this.saveTask(rec), ...(said?.startsWith("Repeats") ? { note_on_state: said } : {}) };
  }

  async updateTask({ id, note, state, priority, scheduled, deadline, new_title, tags }) {
    this.canWriteTasks();
    const original = this.taskStore.records.get(id);
    if (!original || original.state === null) throw new VaultError(`No active task with ID "${id}". Use list_tasks to find it.`);
    const rec = { ...original }, said = [];
    if (new_title !== undefined) {
      rec.title = taskTitle(new_title);
      if (!rec.title) throw new VaultError("The new title is empty.");
      said.push("Title changed");
    }
    if (tags !== undefined) { rec.tags = taskTags(tags); said.push(rec.tags.length ? "Tags set" : "Tags removed"); }
    if (priority !== undefined) { rec.pri = priority; said.push(priority ? `Priority: ${priority}` : "Priority removed"); }
    for (const [key, field, value] of [["DEADLINE", "dead", deadline], ["SCHEDULED", "sched", scheduled]]) {
      if (value === undefined) continue;
      rec[field] = value === null ? null : orgTsStr(parseWhen(value));
      said.push(rec[field] ? `${key}: ${rec[field]}` : `${key} removed`);
    }
    if (state) said.push(taskSetState(rec, TASK_STATES.find((s) => s.id === state)));
    if (note !== undefined) {
      rec.note = note === null ? null : await this.ensureNoteId(this.need(note));
      said.push(note === null ? "Note link removed" : "Note linked");
    }
    if (!said.length) throw new VaultError("Nothing to change: give state, priority, scheduled, deadline, new_title, tags or note.");
    rec.upd = new Date().toISOString();
    return { changes: said, task: await this.saveTask(rec) };
  }
}
