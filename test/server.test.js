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
  await put("cards/Report.md", `---\nparents:\n  - "[[Work]]"\n---\n## Plan\n- [ ] [#A] Write the report :work:\n  SCHEDULED: <${day(-2)}> DEADLINE: <${day(3)}>\n  - [x] outline\n  - [/] draft\n- [<] Call the plumber #home\n  SCHEDULED: <${day(0)} 10:00 +1w>\n- Dentist <${day(1)} 14:00-15:00>\n\n## Log\n- [x] Old thing\n  CLOSED: [${day(-5)} 09:00]\n\n\`\`\`\n- [ ] not a task, it is code\n\`\`\`\n`);
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
  assert.ok(data.tags.includes("#home (2)"));
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
  assert.deepEqual(data.tasks, { open: 3, closed: 2 });
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

test("list_tasks reads the six states, dates, priorities and inherited tags", async () => {
  const { data } = await call("list_tasks");
  assert.deepEqual(data.tasks.map((t) => t.title), ["Write the report", "Call the plumber #home", "draft"]);
  const [a, b] = data.tasks;
  assert.deepEqual({ state: a.state, priority: a.priority, subtasks: a.subtasks, under: a.under, tags: a.tags }, { state: "todo", priority: "A", subtasks: "1/2", under: "Plan", tags: ["work"] });
  assert.equal(a.scheduled, `<${day(-2)}>`);
  assert.equal(b.state, "wait");
  assert.equal(b.scheduled, `<${day(0)} 10:00 +1w>`);
  assert.equal((await call("list_tasks", { due: "overdue" })).data.found, 1);
  assert.equal((await call("list_tasks", { states: ["all"] })).data.found, 5);
  assert.deepEqual((await call("list_tasks", { tag: "home" })).data.tasks.map((t) => t.state), ["wait"]);
  assert.equal((await call("list_tasks", { notebook: "Personal" })).data.found, 0);
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
  await put("cards/Meeting template.md", "---\ntags:\n  - meeting\nchild_order: []\n---\n# {{title}}\nDate: {{date}}\n");
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

test("add_task goes to today's daily note by default, with dates read as the app reads them", async () => {
  let r = await call("add_task", { title: "Buy milk", scheduled: "tomorrow 9:30", deadline: `${iso(4)} -1d`, priority: "B", tags: ["shop"], notes: "2 litres" });
  assert.equal(r.error, false);
  const daily = `daily notes/${iso()}.md`;
  assert.equal(await file(daily), `- [ ] [#B] Buy milk #shop\n  DEADLINE: <${day(4)} -1d> SCHEDULED: <${day(1)} 09:30>\n  2 litres\n`);
  assert.deepEqual({ note: r.data.added.note, line: r.data.added.line, state: r.data.added.state }, { note: iso(), line: 1, state: "todo" });
  r = await call("add_task", { title: "Review", note: "Report", heading: "Plan", state: "doing" });
  assert.match(await file("cards/Report.md"), /14:00-15:00>\n- \[\/\] Review\n\n## Log/);
  r = await call("add_task", { title: "Bad date", scheduled: "someday maybe" });
  assert.match(r.data, /Cannot read the date/);
});

test("update_task closes with CLOSED:, reopens, and moves a repeating task on", async () => {
  let r = await call("update_task", { note: "Report", title: "Write the report", state: "done" });
  assert.equal(r.data.task.state, "done");
  assert.match(await file("cards/Report.md"), new RegExp(`- \\[x\\] \\[#A\\] Write the report :work:\\n {2}CLOSED: \\[${day(0)} \\d\\d:\\d\\d\\] DEADLINE: <${day(3)}> SCHEDULED: <${day(-2)}>\\n`));
  r = await call("update_task", { note: "Report", line: r.data.task.line, state: "todo", priority: null, scheduled: null, deadline: "+2d", new_title: "Write the big report" });
  assert.match(await file("cards/Report.md"), new RegExp(`- \\[ \\] Write the big report :work:\\n {2}DEADLINE: <${day(2)}>\\n`));
  r = await call("update_task", { note: "Report", title: "plumber", state: "done" });
  assert.equal(r.data.task.state, "wait", "a repeating task stays open");
  assert.equal(r.data.task.scheduled, `<${day(7)} 10:00 +1w>`);
  assert.match(r.data.changes[0], /Repeats/);
});

test("update_task checks the title against the line and asks when several match", async () => {
  await put("cards/Twins.md", "- [ ] Same\n- [ ] Same\n- [ ] Other\n");
  let r = await call("update_task", { note: "Twins", title: "Same", state: "done" });
  assert.match(r.data, /2 tasks match/);
  r = await call("update_task", { note: "Twins", line: 1, title: "Other", state: "cancel" });
  assert.equal(r.data.task.line, 3, "the title wins over a stale line");
  assert.match(await file("cards/Twins.md"), /^- \[ \] Same\n- \[ \] Same\n- \[-\] Other\n {2}CLOSED: /);
  r = await call("update_task", { note: "Twins", line: 4, state: "done" });
  assert.match(r.data, /not a task/);
});

test("update_task keeps Windows line endings", async () => {
  await put("cards/Crlf.md", "- [ ] One\r\n- [ ] Two\r\n");
  await call("update_task", { note: "Crlf", title: "One", priority: "A", scheduled: iso(1) });
  assert.equal(await file("cards/Crlf.md"), `- [ ] [#A] One\r\n  SCHEDULED: <${day(1)}>\r\n- [ ] Two\r\n`);
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
