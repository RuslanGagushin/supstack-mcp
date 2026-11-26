# supstack-mcp

An [MCP](https://modelcontextprotocol.io) server for [Supstack](https://github.com/RuslanGagushin/supstack). It gives Claude (or any MCP client) the notes, notebooks and tasks of a Supstack vault: it can read and search them, write notes, file them into notebooks, and add, schedule and close tasks.

The server works on the vault folder itself. It uses the app's Markdown frontmatter and task file format, and puts deleted notes in `.trash`. The app does not have to be running; if it is, it picks the changes up from disk.

## Set up

You need [Node.js](https://nodejs.org) 20 or newer and the path of your vault folder (the one with `cards/` in it).

**Claude Code**

```bash
claude mcp add supstack -- npx -y github:RuslanGagushin/supstack-mcp "/path/to/vault"
```

**Claude Desktop** — add to `claude_desktop_config.json` (Settings › Developer › Edit Config):

```json
{
  "mcpServers": {
    "supstack": {
      "command": "npx",
      "args": ["-y", "github:RuslanGagushin/supstack-mcp", "/path/to/vault"]
    }
  }
}
```

Any other MCP client: run `npx -y github:RuslanGagushin/supstack-mcp <vault folder>` as a stdio server.

Options:

| | |
|---|---|
| `--read-only` (or `SUPSTACK_READ_ONLY=1`) | Leave out every tool that changes the vault |
| `SUPSTACK_VAULT` | The vault folder, when it is not given as an argument |

## Tools

| Tool | What it does |
|---|---|
| `vault_info` | Today's date, the top-level notebooks, the tags, and how many tasks are open, overdue and due today |
| `list_notes` | The notes in a notebook, in the app's order, any number of levels down |
| `read_note` | A note's Markdown, its notebooks, the notes inside it and the notes that link to it |
| `search_notes` | Notes with every word of a query, with `+tag` / `-tag` filters; title matches first |
| `list_tasks` | Tasks by state, note, notebook, tag, priority, or due date |
| `agenda` | The agenda day by day: scheduled tasks, deadlines, overdue items, repeating tasks, events and tasks on the day they closed |
| `daily_note` | The daily note of a day, created if it is not there |
| `create_note` | A new note, in notebooks, with tags and an icon; the notebook's template is applied |
| `edit_note` | Replace pieces of a note's text, append to it or to a section, or replace it all |
| `organize_note` | Move a note between notebooks, set its tags and icon |
| `reorder_notebook` | The manual order of a notebook's notes |
| `rename_note` | Rename a note and update the links to it |
| `delete_note` | Delete a note, keeping a copy in `.trash` |
| `add_task` | Add a standalone task or link it to an existing note; accepts dates, priority and tags |
| `update_task` | Change a task by `id`: state, dates, priority, title, tags or note link; marking a repeating task done advances it |

Dates are read as the app's date prompt reads them: `2026-11-20`, `2026-11-20 14:00`, `tomorrow`, `fri`, `+3d`, with an optional repeater (`+1w`, `++1m`, `.+3d`) or deadline warning (`-2d`).

## Tasks in Supstack 0.38 and later

MCP 0.2 uses `.supstack/tasks.jsonl`, the active task store. Markdown boxes remain checklists. `list_tasks` and `agenda` return a stable `id`, which replaces the old note-and-line selector. To link a task, pass `note` to `add_task` or `update_task`; `note: null` in `update_task` removes the link. The first link assigns the note a frontmatter `id` if needed. If the linked note disappears, the task survives (`note_missing: true`) and reconnects if the note returns.

Pass `title`, `scheduled`, `deadline`, `tags` and `note` separately; inline parsing of dates, `#tags` and `@notes` is the app's Capture UI. There are no `heading` or `notes` arguments on `add_task`. The previous `agenda.closed` switch is no longer needed.

For a pre-0.38 vault, run **Move tasks from notes to the agenda…** in the app. Until then, if there is no task file and legacy entries are detected, `vault_info` reports `task_migration_required: true` and the MCP server leaves migration to the app.

## Good to know

- **Sync.** The server never runs git. Changes it makes go out with the app's next sync.
- **A note open in the app.** If you are editing a note in Supstack while the server changes the same note, the app's next save can overwrite the change. Leave the editor (Done) first.
- **Android.** The server needs the vault as a folder on the computer it runs on, so it works with the desktop vault, or a clone of the vault's git repository.
- **Pins and saved views** that point at a renamed note are not updated: they are kept in the app's settings, which the server does not touch.
- Note tools skip hidden folders. The task tools read the active task file and leave `.supstack/tasks-archive.jsonl` alone.

## Develop

```bash
npm install
```

```bash
npm test
```

`src/core/` holds the parts taken from the app (`web/src/js/core/`): frontmatter, links, search ranking, and the task grammar with its agenda. When the app changes those, bring the change over. `src/vault.js` is the vault on disk, `src/server.js` the tools.

## License

MIT
