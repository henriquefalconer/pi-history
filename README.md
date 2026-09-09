# @hfalconer/pi-history

Loads prompt history across session boundaries while keeping Pi's native editor and navigation logic.

- Resuming a session seeds the newly mounted native editor from that session's user messages.
- A new session adds the 1000 newest prompts from all other interactive sessions on the machine, newest first.
- Duplicate handling, draft restoration, and arrow-key behavior remain unchanged; the native 100-entry history limit is raised to 1000.
- Interactive sessions are marked when Pi's TUI starts them. Headless (`pi -p`) sessions are marked as headless when the extension is loaded, and never contribute prompts.
- `/resume` and its keyboard shortcut list interactive sessions only, using the same classification. The list is built from the cache instead of Pi's own listing, which re-reads every session in full, so a warm listing costs one stat per file. The `pi -r` and `pi -c` flags run before extensions load and are not affected.
- Headless runs launched with `--no-extensions` cannot be marked, so any unmarked session modified after this version first ran is treated as headless. Older unmarked sessions are kept unless they hold a single prompt, the shape of a `pi -p` run.

## How the scan stays cheap

Session stores can grow to gigabytes. The extension never parses a whole session into memory:

- Each session file is streamed line by line, keeping user prompts (capped at 1000 per session) and the summary Pi's session selector shows. Search text and prompts are cached only for sessions that will be listed.
- Results are cached in `<agent dir>/pi-history-cache.json`, keyed by file size and mtime, so later starts only re-read sessions that changed.
- The scan runs in the background after the editor is mounted, so startup never waits on disk. Prompts typed before the scan finishes stay ahead of the seeded ones.

Set `PI_HISTORY_DEBUG=/path/to/log` to append a trace of each scan.

Install from npm:

```sh
pi install npm:@hfalconer/pi-history
```

To test a local checkout:

```sh
pi -e .
```

Run the tests with `npm test`.
