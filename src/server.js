/* The MCP server: the vault's notes, notebooks and tasks as tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault, VaultError } from "./vault.js";

export const VERSION = "0.2.0";

const INSTRUCTIONS = `This server reads and changes a Supstack vault: a folder of plain Markdown notes that the Supstack app shows as notebooks, with tasks and an agenda.

- A note is a .md file; its name is its title, and names are unique in the vault. Refer to a note by its name.
- A notebook is a note that holds other notes. A note lists its notebooks in the \`parents\` property and can sit in several at once; the tools manage that property, so don't write it by hand.
- Link notes with [[Note name]]; embed with ![[Note name]] or ![[Note name#Heading]]. Don't start a note with an H1 that repeats its name.
- Tasks and events live in .supstack/tasks.jsonl. Boxes in Markdown notes are checklists and stay out of the agenda.
- Use add_task with a title and optional note, scheduled date, deadline, priority and tags. Omitting the note creates a standalone task. Pass dates, tags and note links as separate fields.
- Use update_task with the stable ID from list_tasks or agenda. Marking a repeating task done advances its date; other closures record a closed time and appear on that day in the agenda.
- Daily notes are named YYYY-MM-DD and can be opened separately with daily_note.
- Call vault_info first to see today's date, the top-level notebooks and the tags.
- Deleted notes go to the vault's .trash. The app syncs the vault with git itself; this server never runs git.`;

const STATES = ["todo", "doing", "wait", "done", "cancel", "fwd"];
const noteRef = z.string().min(1).describe("The note's name (its title), e.g. \"Shopping list\"; a path such as cards/Shopping list.md works too");
const when = "A date: 2026-11-20, \"2026-11-20 14:00\", \"2026-11-20 14:00-15:30\", today, tomorrow, fri, +3d, optionally followed by a repeater (+1w, ++1m, .+3d) or a deadline warning (-2d)";

export function createServer(root, { readOnly = false } = {}) {
  const vault = new Vault(root, { readOnly });
  const server = new McpServer({ name: "supstack", version: VERSION }, { instructions: INSTRUCTIONS });
  let queued = Promise.resolve();

  const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
  /** A tool: the vault is looked at again before every call, and a VaultError is an answer, not a crash. */
  const tool = (name, title, description, shape, fn, { write = false, destructive = false, creates = false } = {}) => {
    if (write && readOnly) return;
    server.registerTool(name, {
      title, description, inputSchema: shape,
      annotations: { readOnlyHint: !write && !(creates && !readOnly), destructiveHint: destructive, idempotentHint: !write, openWorldHint: false },
    }, (args) => {
      // Keep refresh and the tool action together when callers send parallel requests.
      const result = queued.then(async () => {
        try {
          await vault.refresh();
          const out = await fn(args);
          return out?.content ? out : json(out);
        } catch (e) {
          if (e instanceof VaultError) return { isError: true, content: [{ type: "text", text: e.message }] };
          throw e;
        }
      });
      queued = result.catch(() => {});
      return result;
    });
  };

  /* ---------- reading */
  tool("vault_info", "Vault overview", "Today's date, how many notes there are, the top-level notebooks and notes, the tags, and how many tasks are open, overdue and due today. A good first call.",
    {}, () => vault.info());

  tool("list_notes", "List a notebook", "The notes in a notebook (or at the top level), in the order the app shows them. A note with notes_inside is itself a notebook.", {
    notebook: noteRef.optional().describe("The notebook's name; leave out for the top level (All notes)"),
    depth: z.number().int().min(1).max(10).default(1).describe("How many levels to go down"),
    sort: z.enum(["manual", "name", "modified", "created"]).default("manual").describe("manual is the order set in the app"),
    limit: z.number().int().min(1).max(1000).default(200),
  }, (a) => vault.list(a));

  tool("read_note", "Read a note", "A note's full Markdown (with its frontmatter), plus its notebooks, the notes inside it, the notes that link to it, and counts of linked tasks and checklist boxes.",
    { note: noteRef }, ({ note }) => {
      const { meta, text } = vault.read(note);
      return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, { type: "text", text }] };
    });

  tool("search_notes", "Search notes", "Find notes that have every word of the query in their name or text. +tag and -tag in the query require or exclude a tag. Notes with the words in their title come first, then in a heading, then the rest.", {
    query: z.string().min(1).describe("Words to find, with optional +tag / -tag filters, e.g. \"invoice +work -archive\""),
    notebook: noteRef.optional().describe("Search only inside this notebook, through every level"),
    limit: z.number().int().min(1).max(200).default(30),
  }, (a) => vault.search(a));

  tool("list_tasks", "List tasks", "Tasks from the whole vault (or one note or notebook), earliest date first. By default the open ones (to do, in progress, waiting).", {
    states: z.array(z.enum(["open", "closed", "all", ...STATES])).default(["open"]).describe("open = todo, doing, wait; closed = done, cancel, fwd"),
    note: noteRef.optional().describe("Only the tasks of this note"),
    notebook: noteRef.optional().describe("Only the tasks of this notebook and everything inside it"),
    tag: z.string().optional().describe("Only tasks with this tag (their own, or inherited from the linked note)"),
    priority: z.enum(["A", "B", "C"]).optional(),
    due: z.enum(["overdue", "today", "week", "dated", "undated"]).optional().describe("overdue: date before today; today: overdue or today; week: up to 7 days ahead; dated / undated: with or without SCHEDULED or DEADLINE"),
    query: z.string().optional().describe("Only tasks whose title has this text"),
    limit: z.number().int().min(1).max(1000).default(100),
  }, (a) => vault.tasks(a));

  tool("agenda", "Agenda", "The agenda as the app shows it, day by day: scheduled tasks, deadlines (with early warnings and overdue items under today), repeating tasks, events, and tasks on the day they closed.", {
    from: z.string().optional().describe("The first day (default: today). " + when),
    days: z.number().int().min(1).max(62).default(7),
  }, (a) => vault.agenda(a));

  /* ---------- writing */
  tool("create_note", "Create a note", "Create a note, optionally inside one or more notebooks. If the first notebook has a template for its notes, it is applied. Fails if a note with this name exists.", {
    title: z.string().min(1).describe("The note's name; the characters \\ / : * ? \" < > | # ^ [ ] are replaced with spaces"),
    body: z.string().default("").describe("The note's Markdown text, without frontmatter and without an H1 that repeats the title"),
    notebooks: z.array(noteRef).default([]).describe("The notebooks to put it in; none = top level"),
    tags: z.array(z.string()).default([]).describe("Tags, without #"),
    icon: z.string().regex(/^[a-z0-9-]+$/).optional().describe("A Lucide icon name, e.g. book-open"),
  }, (a) => vault.create(a), { write: true });

  tool("edit_note", "Edit a note's text", "Change a note's text: replace exact pieces of it, append to its end or to the end of a section, or replace the whole text. Properties (frontmatter) are kept; use organize_note for notebooks, tags and icon, and update_task for task states and dates.", {
    note: noteRef,
    replace: z.array(z.object({
      old: z.string().min(1).describe("Text exactly as it is in the note"),
      new: z.string().describe("What to put in its place"),
      all: z.boolean().default(false).describe("Replace every occurrence; otherwise the text must occur once"),
    })).optional().describe("Pieces of text to replace, applied in order"),
    append: z.string().optional().describe("Markdown to add at the end of the note, or of the section named in heading"),
    heading: z.string().optional().describe("With append: the heading whose section gets the text, e.g. \"Log\""),
    body: z.string().optional().describe("New text for the whole note (everything after the frontmatter). Prefer replace or append for small changes"),
  }, (a) => vault.edit(a), { write: true, destructive: true });

  tool("organize_note", "Move and tag a note", "Set which notebooks a note sits in, its tags (the tags property) and its icon. To move a note, give its new notebooks in `notebooks`; an empty list takes it to the top level.", {
    note: noteRef,
    notebooks: z.array(noteRef).optional().describe("The full new list of notebooks (replaces the current ones)"),
    add_to: z.array(noteRef).optional().describe("Notebooks to add it to, keeping the current ones"),
    remove_from: z.array(noteRef).optional().describe("Notebooks to take it out of"),
    tags: z.array(z.string()).optional().describe("The full new list of tags"),
    add_tags: z.array(z.string()).optional(),
    remove_tags: z.array(z.string()).optional(),
    icon: z.string().regex(/^[a-z0-9-]*$/).optional().describe("A Lucide icon name; an empty string removes the icon"),
  }, (a) => vault.organize(a), { write: true });

  tool("reorder_notebook", "Order a notebook's notes", "Set the manual order of the notes in a notebook. Notes not named keep their order after the named ones.", {
    notebook: noteRef,
    order: z.array(noteRef).min(1).describe("Names of notes in the notebook, first to last"),
  }, (a) => vault.reorder(a), { write: true });

  tool("rename_note", "Rename a note", "Rename a note and update every [[link]] to it, the notebooks lists of the notes inside it included.", {
    note: noteRef,
    title: z.string().min(1).describe("The new name"),
  }, (a) => vault.rename(a), { write: true });

  tool("delete_note", "Delete a note", "Delete a note; a copy is kept in the vault's .trash folder. Notes inside it are not deleted, and links to it break. Ask the user before deleting.",
    { note: noteRef }, (a) => vault.remove(a), { write: true, destructive: true });

  tool("add_task", "Add a task", "Create a standalone task or link it to an existing note, as in Capture. Pass dates, note and tags in their own fields.", z.strictObject({
    title: z.string().min(1).describe("What to do, one line"),
    note: noteRef.optional().describe("The existing note to link to (omit for a standalone task)"),
    scheduled: z.string().optional().describe("When to do it. " + when),
    deadline: z.string().optional().describe("When it is due. " + when),
    priority: z.enum(["A", "B", "C"]).optional(),
    tags: z.array(z.string()).default([]).describe("Tags, without #"),
    state: z.enum(STATES).default("todo"),
  }), (a) => vault.addTask(a), { write: true });

  tool("update_task", "Change a task", "Change a task's state, dates, priority, title, tags or note link. Marking a repeating task done moves it to its next date. Identify the task by its stable ID from list_tasks or agenda.", z.strictObject({
    id: z.string().min(1).describe("The task ID returned by list_tasks, agenda or add_task"),
    note: noteRef.nullable().optional().describe("The existing note to link to, or null to remove the link"),
    state: z.enum(STATES).optional().describe("todo, doing (in progress), wait (waiting), done, cancel (cancelled), fwd (forwarded elsewhere)"),
    scheduled: z.string().nullable().optional().describe("New SCHEDULED date, or null to remove it. " + when),
    deadline: z.string().nullable().optional().describe("New DEADLINE date, or null to remove it. " + when),
    priority: z.enum(["A", "B", "C"]).nullable().optional().describe("null removes the priority"),
    new_title: z.string().optional(),
    tags: z.array(z.string()).optional().describe("Replace the task's explicit tags (without #). Hashtags in the title are part of the title."),
  }), (a) => vault.updateTask(a), { write: true });

  tool("daily_note", "Open a daily note", "The daily note of a day (today by default): created empty if it is not there, then returned like read_note. Use edit_note to change its text; pass its name as note to add_task to link a task.", {
    date: z.string().optional().describe("The day (default: today): 2026-11-20, today, yesterday, tomorrow, fri"),
    create: z.boolean().default(true).describe("Create the note when it does not exist"),
  }, async ({ date, create }) => {
    const p = await vault.daily(date, { create: create && !readOnly });
    if (!p) return { content: [{ type: "text", text: "There is no daily note for that day." }] };
    const { meta, text } = vault.read(p);
    return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, { type: "text", text: text || "(the note is empty)" }] };
  }, { creates: true });

  return { server, vault };
}
