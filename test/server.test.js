/* The server end to end: an MCP client calls the tools on a small vault in a temporary folder. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { insertBlock } from "../src/vault.js";

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** An Org date `offset` days from today, e.g. "2026-11-19 Thu". */
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${DAYS[d.getDay()]}`; };
const iso = (offset = 0) => day(offset).slice(0, 10);

let root, client;
const file = (p) => fs.readFile(path.join(root, p), "utf8");
const put = async (p, text) => { await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), text); };
const exists = (p) => fs.access(path.join(root, p)).then(() => true, () => false);
const tasksPath = ".supstack/tasks.jsonl";
const jsonl = (records) => records.map((rec) => JSON.stringify(rec)).join("\n") + "\n";
async function connect(dir, opts) {
  const { server } = createServer(dir, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}
/** Call a tool; the first block parsed as JSON when it is JSON, and the text of the second block. */
async function call(name, args = {}, c = client) {
  const r = await c.callTool({ name, arguments: args });
  const first = r.content[0].text;
  let data = first;
  try { data = JSON.parse(first); } catch { /* plain text */ }
  return { data, text: r.content[1]?.text, error: !!r.isError };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "supstack-mcp-"));
  await put("cards/Work.md", "---\nchild_order:\n  - \"[[Report]]\"\n  - \"[[Budget]]\"\nicon: briefcase\n---\nEverything about work.\n");
  await put("cards/Budget.md", "---\nparents:\n  - \"[[Work]]\"\ntags:\n  - money\n---\nNumbers for 2026. See [[Report]].\n");
  await put("cards/Report.md", "---\nid: nreport\nparents:\n  - \"[[Work]]\"\ntags: [project]\n---\n## Plan\n- [x] outline\n- [ ] draft\n\n```\n- [ ] not a task, it is code\n```\n");
  await put(tasksPath, jsonl([
    { id: "treport", title: "Write the report", state: " ", note: "nreport", pri: "A", tags: ["work"], sched: `<${day(-2)}>`, dead: `<${day(3)}>`, future_field: { extra: true } },
    { id: "tplumber", title: "Call the plumber #home", state: "<", note: "nreport", sched: `<${day()} 10:00 +1w>` },
    { id: "tdentist", title: "Dentist", state: null, when: `<${day(1)} 14:00-15:00>` },
    { id: "told", title: "Old thing", state: "x", note: "nreport", closed: `[${day(-5)} 09:00]` },
    { id: "tmissing", title: "Task with missing note", state: "/", note: "nmissing" },
  ]) + "unrecognized line\n");
  await put(".supstack/tasks-archive.jsonl", jsonl([{ id: "tarchived", title: "Archived", state: "x", closed: `[${day(-5)} 09:00]` }]));
  await put("cards/Personal.md", "Home things. #home\n");
  await put("cards/Recipes.md", "---\nparents:\n  - \"[[Personal]]\"\n  - \"[[Work]]\"\n---\nPancakes: flour, milk, eggs.\n");
  await put(".supstack/settings.json", "{}");
  await put(".trash/Old.md", "should not be seen");
  await put("attachments/pic.png", "x");
  client = await connect(root);
});
after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });

test("the tools are listed, and --read-only leaves out those that change the vault", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["vault_info", "list_notes", "read_note", "search_notes", "list_tasks", "agenda", "create_note", "edit_note", "organize_note", "reorder_notebook", "rename_note", "delete_note", "add_task", "update_task", "daily_note"]) assert.ok(names.includes(n), n);
  const ro = await connect(root, { readOnly: true });
  const roNames = (await ro.listTools()).tools.map((t) => t.name);
  assert.deepEqual(roNames.sort(), ["agenda", "daily_note", "list_notes", "list_tasks", "read_note", "search_notes", "vault_info"]);
  const d = await call("daily_note", { date: "2031-01-01" }, ro);
  assert.match(d.data, /no daily note/);
  assert.equal(await exists("daily notes/2031-01-01.md"), false);
  await ro.close();
});

test("vault_info counts notes and tasks and skips hidden folders", async () => {
  const { data } = await call("vault_info");
  assert.equal(data.notes, 5);
  assert.equal(data.notebooks, 2);
  assert.deepEqual(data.top_level, ["Personal (1)", "Work (3)"]);
  assert.ok(data.tags.includes("#home (1)"));
  assert.equal(data.today.slice(0, 10), iso());
  assert.deepEqual(data.tasks, { open: 3, overdue: 1, due_today: 1 });
});

test("list_notes follows the notebook's manual order and goes down levels", async () => {
  const { data } = await call("list_notes", { notebook: "work" });
  assert.deepEqual(data.notes.map((n) => n.name), ["Report", "Budget", "Recipes"]);
  const deep = await call("list_notes", { depth: 2 });
  assert.deepEqual(deep.data.notes.map((n) => `${n.level} ${n.name}`), ["1 Personal", "2 Recipes", "1 Work", "2 Report", "2 Budget"]);
});

test("read_note gives the text and what is around the note", async () => {
  const { data, text } = await call("read_note", { note: "[[Report]]" });
  assert.deepEqual(data.notebooks, ["Work"]);
  assert.deepEqual(data.linked_from, ["Budget"]);
  assert.deepEqual(data.tasks, { open: 2, closed: 1 });
  assert.deepEqual(data.checklist, { total: 2, done: 1 });
  assert.equal(text, await file("cards/Report.md"));
  const missing = await call("read_note", { note: "Repor" });
  assert.ok(missing.error);
  assert.match(missing.data, /Similar names: Report/);
});

test("search_notes ranks titles first and filters by tag and notebook", async () => {
  assert.deepEqual((await call("search_notes", { query: "report" })).data.notes.map((n) => n.name).slice(0, 1), ["Report"]);
  assert.deepEqual((await call("search_notes", { query: "+money" })).data.notes.map((n) => n.name), ["Budget"]);
  assert.deepEqual((await call("search_notes", { query: "flour", notebook: "Personal" })).data.notes.map((n) => n.name), ["Recipes"]);
  assert.equal((await call("search_notes", { query: "flour -nothing zzz" })).data.found, 0);
});

test("list_tasks uses task IDs and reads dates, priorities and inherited tags", async () => {
  const { data } = await call("list_tasks");
  assert.deepEqual(data.tasks.map((t) => t.title), ["Write the report", "Call the plumber #home", "Task with missing note"]);
  const [a, b, missing] = data.tasks;
  assert.deepEqual({ id: a.id, state: a.state, priority: a.priority, tags: a.tags }, { id: "treport", state: "todo", priority: "A", tags: ["project", "work"] });
  assert.equal(missing.note, null);
  assert.equal(missing.note_missing, true);
  assert.equal(a.scheduled, `<${day(-2)}>`);
  assert.equal(b.state, "wait");
  assert.equal(b.scheduled, `<${day(0)} 10:00 +1w>`);
  assert.equal((await call("list_tasks", { due: "overdue" })).data.found, 1);
  assert.equal((await call("list_tasks", { states: ["all"] })).data.found, 4);
  assert.deepEqual((await call("list_tasks", { tag: "home" })).data.tasks.map((t) => t.state), ["wait"]);
  assert.equal((await call("list_tasks", { notebook: "Personal" })).data.found, 0);
  assert.equal((await call("list_tasks", { notebook: "Work" })).data.found, 2);
});

test("agenda lists scheduled, overdue, repeating and event entries by day", async () => {
  const { data } = await call("agenda", { days: 8 });
  const [today, tomorrow] = data.days;
  assert.match(today.day, /today/);
  const plumber = today.entries.find((e) => e.title.startsWith("Call the plumber"));
  assert.deepEqual({ time: plumber.time, what: plumber.what }, { time: "10:00", what: "Scheduled" });
  const report = today.entries.filter((e) => e.title === "Write the report");
  assert.deepEqual(report.map((e) => e.what), ["Scheduled 2 days ago"]);
  assert.deepEqual(tomorrow.entries.map((e) => [e.title, e.time, e.event]), [["Dentist", "14:00-15:00", true]]);
  assert.ok(data.days[3].entries.some((e) => e.what === "Deadline"));
  assert.ok(data.days[7].entries.some((e) => e.title.startsWith("Call the plumber")), "the weekly task comes round");
  const closed = (await call("agenda", { from: iso(-5), days: 1 })).data.days[0].entries;
  assert.deepEqual(closed.map((e) => [e.id, e.what]), [["told", "Closed"]]);
});

test("create_note writes the frontmatter the app writes and refuses a taken name", async () => {
  const { data } = await call("create_note", { title: "Ideas: 2026?", body: "First idea.", notebooks: ["Work"], tags: ["#brain storm"], icon: "lightbulb" });
  assert.equal(data.path, "cards/Ideas 2026.md");
  assert.equal(await file("cards/Ideas 2026.md"), "---\nparents:\n  - \"[[Work]]\"\ntags:\n  - brain-storm\nicon: lightbulb\n---\nFirst idea.\n");
  const again = await call("create_note", { title: "ideas 2026" });
  assert.ok(again.error);
  const plain = await call("create_note", { title: "Loose note" });
  assert.equal(await file(plain.data.path), "");
});

test("create_note applies the notebook's template", async () => {
  await put("cards/Meeting template.md", "---\nid: ntemplate\ntags:\n  - meeting\nchild_order: []\n---\n# {{title}}\nDate: {{date}}\n");
  await call("organize_note", { note: "Meeting template", notebooks: [] });
  await put("cards/Meetings.md", "---\nchild_template: \"[[Meeting template]]\"\n---\n");
  const { data } = await call("create_note", { title: "Kickoff", notebooks: ["Meetings"], body: "Agenda" });
  assert.equal(data.template, "Meeting template");
  assert.equal(await file("cards/Kickoff.md"), `---\nparents:\n  - "[[Meetings]]"\ntags:\n  - meeting\n---\n# Kickoff\nDate: ${iso()}\n\nAgenda\n`);
});

test("edit_note replaces, appends under a heading and keeps the frontmatter", async () => {
  await put("cards/Edit me.md", "---\ntags:\n  - x\n---\nIntro\n\n## Log\n- one\n\n## Later\nlast\n");
  let r = await call("edit_note", { note: "Edit me", replace: [{ old: "Intro", new: "Hello" }], append: "- two", heading: "log" });
  assert.equal(r.error, false);
  assert.equal(await file("cards/Edit me.md"), "---\ntags:\n  - x\n---\nHello\n\n## Log\n- one\n- two\n\n## Later\nlast\n");
  r = await call("edit_note", { note: "Edit me", append: "the end" });
  assert.ok((await file("cards/Edit me.md")).endsWith("last\nthe end\n"));
  r = await call("edit_note", { note: "Edit me", replace: [{ old: "nowhere", new: "x" }] });
  assert.ok(r.error);
  r = await call("edit_note", { note: "Edit me", replace: [{ old: "e", new: "x" }] });
  assert.match(r.data, /occurs \d+ times/);
  r = await call("edit_note", { note: "Edit me", body: "New text\n" });
  assert.equal(await file("cards/Edit me.md"), "---\ntags:\n  - x\n---\nNew text\n");
});

test("insertBlock adds to the last section and to an empty text", () => {
  assert.equal(insertBlock("", "- a"), "- a\n");
  assert.equal(insertBlock("x", "- a"), "x\n- a\n");
  assert.equal(insertBlock("## A\none", "two", "A"), "## A\none\ntwo\n");
  assert.equal(insertBlock("## A\none\n\n\n", "two", "A"), "## A\none\ntwo\n\n\n");
  assert.equal(insertBlock("## A\r\none\r\n## B\r\n", "two", "A"), "## A\r\none\r\ntwo\r\n## B\r\n");
  assert.throws(() => insertBlock("text", "two", "Nope"), /No heading/);
});

test("organize_note moves a note, refuses a circle and sets tags", async () => {
  let r = await call("organize_note", { note: "Recipes", remove_from: ["Work"], add_tags: ["food"], icon: "utensils" });
  assert.deepEqual(r.data.notebooks, ["Personal"]);
  assert.equal(await file("cards/Recipes.md"), "---\nparents:\n  - \"[[Personal]]\"\ntags:\n  - food\nicon: utensils\n---\nPancakes: flour, milk, eggs.\n");
  r = await call("organize_note", { note: "Work", add_to: ["Budget"] });
  assert.ok(r.error);
  assert.match(r.data, /inside/);
  r = await call("organize_note", { note: "Recipes", notebooks: [], remove_tags: ["food"], icon: "" });
  assert.equal(await file("cards/Recipes.md"), "Pancakes: flour, milk, eggs.\n");
  await call("organize_note", { note: "Recipes", notebooks: ["Personal"] });
});

test("reorder_notebook writes child_order", async () => {
  const { data } = await call("reorder_notebook", { notebook: "Work", order: ["Budget"] });
  assert.deepEqual(data.order.slice(0, 2), ["Budget", "Report"]);
  assert.match(await file("cards/Work.md"), /child_order:\n {2}- "\[\[Budget\]\]"\n {2}- "\[\[Report\]\]"/);
  assert.ok((await call("reorder_notebook", { notebook: "Work", order: ["Personal"] })).error);
});

test("add_task captures without a note by default, with dates read as the app reads them", async () => {
  let r = await call("add_task", { title: "Buy milk", scheduled: "tomorrow 9:30", deadline: `${iso(4)} -1d`, priority: "B", tags: ["shop"] });
  assert.equal(r.error, false);
  const { id } = r.data.added;
  assert.deepEqual(r.data.added, {
    id, note: null, state: "todo", title: "Buy milk", priority: "B",
    scheduled: `<${day(1)} 09:30>`, deadline: `<${day(4)} -1d>`, tags: ["shop"],
  });
  assert.equal(await exists(`daily notes/${iso()}.md`), false);
  r = await call("add_task", { title: "Review", note: "Report", state: "doing" });
  assert.equal(r.data.added.note, "Report");
  assert.equal(r.data.added.state, "doing");
  r = await call("add_task", { title: "Bad date", scheduled: "someday maybe" });
  assert.match(r.data, /Cannot read the date/);
  assert.equal((await call("add_task", { title: "Old API", notes: "Do not drop this silently" })).error, true);
});

test("update_task closes, reopens, and moves a repeating task on without changing the note", async () => {
  const raw = await file("cards/Report.md");
  let r = await call("update_task", { id: "treport", state: "done" });
  assert.equal(r.data.task.state, "done");
  assert.ok(r.data.task.closed.startsWith(`[${day()} `));
  r = await call("update_task", { id: "treport", state: "todo", priority: null, scheduled: null, deadline: "+2d", new_title: "Write the big report" });
  assert.equal(r.data.task.title, "Write the big report");
  assert.equal(r.data.task.deadline, `<${day(2)}>`);
  for (const field of ["closed", "scheduled", "priority"]) assert.equal(r.data.task[field], undefined);
  r = await call("update_task", { id: "tplumber", state: "done" });
  assert.equal(r.data.task.state, "wait", "a repeating task stays open");
  assert.equal(r.data.task.scheduled, `<${day(7)} 10:00 +1w>`);
  assert.match(r.data.changes[0], /Repeats/);
  assert.equal(await file("cards/Report.md"), raw);
  const lines = (await file(tasksPath)).trimEnd().split("\n");
  const report = JSON.parse(lines.find((line) => line.startsWith('{"id":"treport"')));
  assert.deepEqual(report.future_field, { extra: true });
  assert.equal(lines.at(-1), "unrecognized line");
  assert.equal((await call("update_task", { id: "tdentist", state: "done" })).error, true);
});

test("parallel capture keeps both tasks and assigns a single ID without rewriting the CRLF note", async () => {
  const raw = "---\r\n# Keep this comment\r\ntags: [windows]\r\n---\r\n- [ ] One\r\n- [ ] Two\r\n";
  await put("cards/Crlf.md", raw);
  const [a, b] = await Promise.all([call("add_task", { title: "Same", note: "Crlf" }), call("add_task", { title: "Same", note: "Crlf" })]);
  const id = a.data.added.id;
  assert.notEqual(id, b.data.added.id);
  const note = await file("cards/Crlf.md");
  assert.match(note, /^---\r\nid: n[a-z0-9]+\r\n/);
  assert.equal(note.replace(/^id:.*\r\n/m, ""), raw);
  assert.equal((await call("list_tasks", { note: "Crlf" })).data.found, 2);
  assert.equal((await call("update_task", { id, note: null, state: "cancel" })).data.task.note, null);
  assert.deepEqual((await call("list_tasks", { note: "Crlf" })).data.tasks.map((task) => task.id), [b.data.added.id]);
  assert.equal((await call("update_task", { note: "Crlf", line: 1, state: "done" })).error, true);
});

test("an older vault needs the app migration before MCP creates its task store", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supstack-legacy-"));
  const old = await connect(dir);
  try {
    const file = path.join(dir, "Legacy.md");
    await fs.writeFile(file, `- [/] Old task\n  SCHEDULED: <${day()}>\n`);
    assert.equal((await call("vault_info", {}, old)).data.task_migration_required, true);
    assert.equal((await call("add_task", { title: "New task" }, old)).error, true);
    await assert.rejects(fs.access(path.join(dir, tasksPath)), { code: "ENOENT" });
    await fs.writeFile(file, "- [ ] Just a checklist\n");
    assert.equal((await call("add_task", { title: "New task" }, old)).error, false);
    assert.equal((await call("list_tasks", {}, old)).data.found, 1);
  } finally {
    await old.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rename_note updates links and the notebooks lists", async () => {
  const { data } = await call("rename_note", { note: "Work", title: "Job" });
  assert.equal(data.path, "cards/Job.md");
  assert.ok(data.links_updated_in.includes("Budget"));
  assert.equal(await exists("cards/Work.md"), false);
  assert.match(await file("cards/Budget.md"), /parents:\n {2}- "\[\[Job\]\]"/);
  assert.deepEqual((await call("list_notes", { notebook: "Job" })).data.notes.map((n) => n.name).slice(0, 2), ["Budget", "Report"]);
  assert.ok((await call("rename_note", { note: "Job", title: "budget" })).error);
});

test("delete_note keeps a copy in .trash and leaves the notes inside", async () => {
  const before = await file("cards/Personal.md");
  const { data } = await call("delete_note", { note: "Personal" });
  assert.equal(data.copy, ".trash/Personal.md");
  assert.equal(await file(".trash/Personal.md"), before);
  assert.equal(await exists("cards/Personal.md"), false);
  assert.deepEqual(data.notes_that_were_inside_now_without_it, ["Recipes"]);
  assert.ok((await call("vault_info")).data.top_level.includes("Recipes"));
});

test("a change made outside the server is seen on the next call", async () => {
  await put("cards/From the app.md", "Written by Supstack. #fresh\n");
  assert.deepEqual((await call("search_notes", { query: "+fresh" })).data.notes.map((n) => n.name), ["From the app"]);
});

test("linked tasks survive a rename and deletion and reconnect when their note returns", async () => {
  await put("cards/To rename.md", "Body\n");
  const { id } = (await call("add_task", { title: "Keep the link", note: "To rename" })).data.added;
  const getTask = async () => (await call("list_tasks", { query: "Keep the link" })).data.tasks[0];
  await call("rename_note", { note: "To rename", title: "Renamed" });
  assert.equal((await getTask()).note, "Renamed");
  const { copy } = (await call("delete_note", { note: "Renamed" })).data;
  assert.deepEqual(await getTask(), { id, title: "Keep the link", note: null, note_missing: true, state: "todo" });
  await put("cards/Restored.md", await file(copy));
  assert.equal((await getTask()).note, "Restored");
});
