# supstack-mcp

An [MCP](https://modelcontextprotocol.io) server for [Supstack](https://github.com/RuslanGagushin/supstack). It gives Claude (or any MCP client) the notes, notebooks and tasks of a Supstack vault: it can read and search them, write notes, file them into notebooks, and add, schedule and close tasks.

The server works on the vault folder itself, with the same rules as the app: the same frontmatter, the same task grammar, deletes go to `.trash`. The app does not have to be running; if it is, it picks the changes up as it does any change on disk.

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
| `agenda` | The agenda day by day: scheduled tasks, deadlines, overdue items, repeating tasks, events |
| `daily_note` | The daily note of a day, created if it is not there |
| `create_note` | A new note, in notebooks, with tags and an icon; the notebook's template is applied |
| `edit_note` | Replace pieces of a note's text, append to it or to a section, or replace it all |
| `organize_note` | Move a note between notebooks, set its tags and icon |
| `reorder_notebook` | The manual order of a notebook's notes |
| `rename_note` | Rename a note and update the links to it |
| `delete_note` | Delete a note, keeping a copy in `.trash` |
| `add_task` | Add a task, to today's daily note by default, with dates, priority and tags |
| `update_task` | Change a task's state, dates, priority, title or tags; closing writes `CLOSED:`, and a repeating task moves to its next date |

Dates are read as the app's date prompt reads them: `2026-11-20`, `2026-11-20 14:00`, `tomorrow`, `fri`, `+3d`, with an optional repeater (`+1w`, `++1m`, `.+3d`) or deadline warning (`-2d`).

## Good to know

- **Sync.** The server never runs git. Changes it makes go out with the app's next sync.
- **A note open in the app.** If you are editing a note in Supstack while the server changes the same note, the app's next save can overwrite the change. Leave the editor (Done) first.
- **Android.** The server needs the vault as a folder on the computer it runs on, so it works with the desktop vault, or a clone of the vault's git repository.
- **Pins and saved views** that point at a renamed note are not updated: they are kept in the app's settings, which the server does not touch.
- Files in hidden folders (`.trash`, `.supstack`, `.git`) are never read or listed.

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
