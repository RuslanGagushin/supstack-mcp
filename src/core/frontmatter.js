/* Frontmatter and note parsing, as Supstack's web/src/js/core/frontmatter.js, util.js and search.js:
   the server reads and writes a note exactly as the app does. */
import * as yaml from "js-yaml";
import { formatMoment } from "./dates.js";

const FM_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
export function splitNote(data) {
  const m = FM_RE.exec(data);
  if (!m) return { fm: "", body: data };
  return { fm: m[0], body: data.slice(m[0].length) };
}
export function fmInner(fmBlock) { return fmBlock.replace(/^---\r?\n/, "").replace(/\r?\n---(?:\r?\n)?$/, ""); }
export function parseYaml(text) {
  const v = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
export function dumpYaml(obj) {
  return yaml.dump(obj, { schema: yaml.CORE_SCHEMA, lineWidth: -1, quoteStyle: "double", noRefs: true });
}
/** A note's text from its frontmatter object and body. */
export function composeNote(fm, body) {
  return (Object.keys(fm).length ? "---\n" + dumpYaml(fm) + "---\n" : "") + body;
}
export function extractLinkpath(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  const wiki = /^!?\[\[([^\]]+)\]\]$/.exec(s);
  if (wiki) s = wiki[1];
  else {
    const md = /^\[[^\]]*\]\(([^)]+)\)$/.exec(s);
    if (md) { try { s = decodeURIComponent(md[1]); } catch { s = md[1]; } }
  }
  s = s.split("|")[0].split("#")[0].trim();
  return s || null;
}
export function parentLinkpaths(value) {
  const out = [];
  const visit = (v) => {
    if (Array.isArray(v)) {
      // `- [[Name]]` without quotes is YAML for a list in a list
      if (v.length === 1 && Array.isArray(v[0]) && v[0].length === 1 && typeof v[0][0] === "string") {
        const lp = extractLinkpath(v[0][0]);
        if (lp) out.push(lp);
        return;
      }
      v.forEach(visit);
      return;
    }
    const lp = extractLinkpath(v);
    if (lp) out.push(lp);
  };
  visit(value);
  return [...new Set(out)];
}
export function toStringList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => {
      if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") return [`[[${v[0]}]]`];
      return typeof v === "string" ? [v] : [];
    });
  }
  return typeof value === "string" && value.trim() ? [value] : [];
}
export const CODE_RE = /(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)|`[^`\n]+`/g;
export function stripCode(s) { return s.replace(CODE_RE, " "); }
export const TAG_RE = /(^|[\s,;])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
export function noteTags(fm, body) {
  const out = [];
  const add = (x) => { const s = String(x).trim().replace(/^#/, ""); if (s) out.push("#" + s); };
  const ft = fm.tags ?? fm.tag;
  if (Array.isArray(ft)) ft.flat().forEach(add);
  else if (typeof ft === "string") ft.split(/[,\s]+/).forEach(add);
  const text = stripCode(body).replace(/%%[\s\S]*?%%/g, " ");
  for (const m of text.matchAll(TAG_RE)) add(m[2]);
  return [...new Set(out)];
}
export function noteLinks(body) {
  const out = [];
  const text = stripCode(body);
  for (const m of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) { const lp = extractLinkpath(`[[${m[1]}]]`); if (lp) out.push(lp); }
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+\.md)\)/gi)) { const lp = extractLinkpath(`[x](${m[1]})`); if (lp && !/^[a-z]+:/i.test(lp)) out.push(lp); }
  return out;
}
export function fillTemplate(text, title, now) {
  return text.replace(/\{\{\s*(title|date|time)(?::([^}]+))?\s*\}\}/gi, (_m, key, f) => {
    const k = key.toLowerCase();
    if (k === "title") return title;
    if (f) return formatMoment(now, f.trim());
    return formatMoment(now, k === "date" ? "YYYY-MM-DD" : "HH:mm");
  });
}
export function composeBody(templateBody, typed) {
  const tpl = templateBody.replace(/^\n+/, "").replace(/\n+$/, "");
  const extra = typed.trim();
  if (!tpl) return extra ? extra + "\n" : "";
  return extra ? `${tpl}\n\n${extra}\n` : `${tpl}\n`;
}
export const TEMPLATE_SKIP_KEYS = new Set(["child_order", "child_template", "order", "position", "tags_template"]);

export const baseName = (p) => (p.split("/").pop() || p).replace(/\.md$/i, "");
export const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const norm = (s) => String(s).toLowerCase().replace(/ё/g, "е");
export const sanitizeTitle = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
export function cleanTag(s) { return String(s).trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, ""); }

/** A note's Markdown as one line of plain text, for a preview. */
export function plainText(md, max = 300) {
  return String(md)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]/g, (m, a, b) => b || a.split("#")[0])
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, " ")
    .replace(/^[ \t]*(?:>[ \t]*)+(?:\[![^\]\n]*\][+-]?)?/gm, "")
    .replace(/^[ \t]*(?:(?:SCHEDULED|DEADLINE|CLOSED):[ \t]*[<[][^>\]\n]*[>\]][ \t]*)+$/gm, " ")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX/<>-]\][ \t]+)?|\d+[.)][ \t]+(?:\[[ xX/<>-]\][ \t]+)?)/gm, "")
    .replace(/^\[#[A-Za-z]\][ \t]*/gm, "")
    .replace(/[ \t]+:(?:[\p{L}\p{N}_@#%]+:)+[ \t]*$/gmu, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|~~|==|\*|`)/g, "")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

/* Search (the app's core/search.js): the query's words and its +tag / -tag filters, and how well a note matches. */
const TAG_TOKEN = /^([+-])#?([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)$/u;
export function parseQuery(q) {
  const out = { words: [], include: [], exclude: [] };
  for (const tok of norm(q).split(/\s+/).filter(Boolean)) {
    const m = TAG_TOKEN.exec(tok);
    if (m) (m[1] === "+" ? out.include : out.exclude).push(m[2]);
    else out.words.push(tok);
  }
  return out;
}
export function headingsText(md) {
  let out = "";
  for (const m of String(md).matchAll(/^ {0,3}#{1,6}[ \t]+(.+)$/gm)) out += m[1] + "\n";
  return out;
}
/** 3 when the title has every word, 2 when the title and headings together have them, 1 when only the text does. */
export function matchRank(words, title, headings) {
  const t = norm(title);
  if (words.every((w) => t.includes(w))) return 3;
  const th = t + "\n" + norm(headings);
  return words.every((w) => th.includes(w)) ? 2 : 1;
}
