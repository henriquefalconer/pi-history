# @hfalconer/pi-history

Loads prompt history across session boundaries while keeping Pi's native editor and navigation logic.

- Resuming a session seeds the newly mounted native editor from that session's user messages.
- A new session adds the 100 newest prompts from all other interactive sessions on the machine, newest first.
- The native 100-entry limit, duplicate handling, draft restoration, and arrow-key behavior remain unchanged.
- Headless (`pi -p`) sessions are marked and never contribute prompts.

## How the scan stays cheap

Session stores can grow to gigabytes. The extension never parses a whole session into memory:

- Each session file is streamed line by line and only user prompts are kept, capped at 100 per session.
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
