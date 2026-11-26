/* Supstack's web/src/js/core/tasks.js file format and task semantics. */
import { randomUUID } from "node:crypto";
import { splitNote, stripCode, TAG_RE } from "./frontmatter.js";
import { orgNowTs, orgShiftRep, orgStamps, orgStripTs, orgTsParse, orgTsStr, taskState, taskStateName } from "./org.js";

export const TASKS_PATH = ".supstack/tasks.jsonl";
const FIELDS = ["id", "state", "pri", "title", "tags", "sched", "dead", "closed", "when", "note", "created", "upd"];
export const newId = (prefix) => prefix + Date.now().toString(36) + randomUUID().replaceAll("-", "");

export function parseTasks(text) {
  const records = new Map(), extra = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { /* Keep non-task lines verbatim. */ }
    if (!rec || typeof rec.id !== "string" || !rec.id) { extra.push(line); continue; }
    if (typeof rec.title !== "string") rec.title = String(rec.title ?? "");
    if (!Array.isArray(rec.tags)) rec.tags = [];
    if (rec.state !== null && !taskState(rec.state)) rec.state = " ";
    records.set(rec.id, rec);
  }
  return { records, extra };
}

export function serializeTasks(records, extra) {
  const lines = [...records.keys()].sort().map((id) => {
    const rec = records.get(id);
    const out = Object.create(null);
    for (const field of FIELDS) {
      const value = rec[field];
      if (field === "state") out.state = value ?? null;
      else if (value != null && value !== "" && (!Array.isArray(value) || value.length)) out[field] = value;
    }
    for (const [field, value] of Object.entries(rec)) if (!FIELDS.includes(field)) out[field] = value;
    return JSON.stringify(out);
  }).concat(extra);
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function taskEntry(rec, note) {
  const st = taskState(rec.state);
  const inherited = note?.fm.tags;
  const noteTags = Array.isArray(inherited) ? inherited : String(inherited ?? "").split(/[,\s]+/);
  const inline = [...stripCode(rec.title).matchAll(TAG_RE)].map((m) => m[2]);
  const alltags = [], seen = new Set();
  for (const value of [...noteTags, ...(rec.tags ?? []), ...inline]) {
    const tag = String(value).replace(/^#/, "");
    const lower = tag.toLowerCase();
    if (!tag || seen.has(lower)) continue;
    alltags.push(tag);
    seen.add(lower);
  }
  return {
    id: rec.id, path: note?.path ?? null, note: note?.name ?? null, noteGone: !!rec.note && !note,
    kw: st?.id, isTodo: !!st, done: st?.open === false, pri: rec.pri,
    title: orgStripTs(rec.title) || rec.title, fullTitle: rec.title, alltags,
    sched: orgTsParse(rec.sched), dead: orgTsParse(rec.dead), closed: orgTsParse(rec.closed),
    stamps: orgStamps(rec.when || ""),
  };
}

export function taskSetState(rec, to) {
  const from = taskState(rec.state);
  if (to.id === "done" && from.open) {
    const s = orgTsParse(rec.sched), d = orgTsParse(rec.dead);
    if (s?.rep || d?.rep) {
      if (s?.rep) rec.sched = orgTsStr(orgShiftRep(s));
      if (d?.rep) rec.dead = orgTsStr(orgShiftRep(d));
      return `Repeats: moved to ${s?.rep ? "SCHEDULED: " + rec.sched : "DEADLINE: " + rec.dead}`;
    }
  }
  rec.state = to.ch;
  if (!to.open && from.open) rec.closed = orgNowTs();
  else if (to.open) delete rec.closed;
  return `State: ${taskStateName(to.ch)}`;
}

export function withNoteId(raw, id) {
  const { fm, body } = splitNote(raw);
  const nl = (fm || body).includes("\r\n") ? "\r\n" : "\n";
  if (!fm) return ["---", `id: ${id}`, "---", raw].join(nl);
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((line, i) => i > 0 && /^id:/.test(line));
  if (at > 0) lines[at] = `id: ${id}`;
  else lines.splice(1, 0, `id: ${id}`);
  return lines.join(nl) + body;
}

/** The app migrates these entries; ordinary Markdown checklists stay in place. */
export function hasLegacyTasks(entries) {
  return entries.some((e) => e.stamps.length || (e.isTodo &&
    (e.sched || e.dead || e.closed || e.pri || (e.kw !== "todo" && e.kw !== "done"))));
}
