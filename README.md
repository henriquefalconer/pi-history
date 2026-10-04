# @hfalconer/pi-history

Loads prompt history across session boundaries while keeping Pi's native editor and navigation logic.

- Resuming a session seeds the newly mounted native editor from that session's user messages.
- A new session adds the 1000 newest prompts from all other interactive sessions on the machine, newest first.
- Duplicate handling, draft restoration, and arrow-key behavior remain unchanged; the native 100-entry history limit is raised to 1000.
- Interactive sessions are marked when Pi's TUI starts them. Headless (`pi -p`) sessions are marked as headless when the extension is loaded, and never contribute prompts.
- `/history-recover <absolute .jsonl path>` lets you confirm and resume an unmarked interactive session hidden by the filter. It refuses known headless sessions. Opening the session records its interactive classification, so it returns to `/resume` without changing the filter for other sessions.
- `/resume` and its keyboard shortcut keep compacted sessions only when an interactive marker or saved classification identifies them. Headless and unknown compacted sessions stay hidden, even if they contain several user prompts. The latest summary supplies search text and a title when no user prompt remains. The list is built from the cache instead of Pi's own listing, which re-reads every session in full, so a warm listing costs one stat per file. The `pi -r` and `pi -c` flags run before extensions load and are not affected.
- Headless runs launched with `--no-extensions` cannot be marked, so any unmarked session modified after this version first ran is treated as headless. Older unmarked sessions are kept unless they hold a single prompt, the shape of a `pi -p` run.

## How the scan stays cheap

Session stores can grow to gigabytes. The extension never parses a whole session into memory:

- Each session file is streamed line by line, keeping user prompts (capped at 1000 per session) and the summary Pi's session selector shows. Search text and prompts are cached only for sessions that will be listed.
- Results are cached in `<agent dir>/pi-history-cache.json`, keyed by file size and mtime, so later starts only re-read sessions that changed.
- Session classifications are also stored in `<agent dir>/pi-history-kinds/`, keyed by session path and checked against the session ID. Compaction and cache deletion cannot erase them. Existing cached classifications migrate on the next scan. A session whose marker was already lost and whose classification was never saved stays hidden until explicitly opened in the TUI.
- The scan runs in the background after the editor is mounted, so startup never waits on disk. Prompts typed before the scan finishes stay ahead of the seeded ones.

## Recover a missing conversation

An interactive session can lack a marker if this extension was not loaded when it ran. The filter cannot distinguish that session from unmarked automation. Compaction alone does not prove that a conversation was interactive, and native Pi compaction does not delete its original entries.

Find the session's `.jsonl` file under `~/.pi/agent/sessions/`, then run this inside Pi:

```text
/history-recover /absolute/path/to/session.jsonl
```

Confirm only if you recognize it as an interactive conversation. Pi resumes the session without calling a model. The session-start handler saves its classification and appends an interactive marker, which also invalidates its cached listing. Cancel leaves the session unchanged. Alternatively, start `pi --session /absolute/path/to/session.jsonl` in its project directory.

Set `PI_HISTORY_DEBUG=/path/to/log` to append a trace of each scan.

Install from npm:

```sh
pi install npm:@hfalconer/pi-history
```

To install a local checkout instead of the npm copy:

```sh
pi remove npm:@hfalconer/pi-history
pi install /absolute/path/to/pi-history
```

Keep only one copy configured. Different package sources can load separately, and the first copy to patch the session list owns it until Pi exits.

To test a checkout without other extensions:

```sh
pi -ne -e .
```

Run the tests with `npm test` and typecheck with `npm run typecheck`.

With Pi installed, run `python3 test/resume-ui.py` to check the filtered `/resume` picker in an isolated agent directory. It runs offline without model calls. It checks filtering, rejected recovery requests, cancellation, and confirmed recovery into a warm `/resume` list.

Restart Pi after installing an updated version. The process-wide session-list replacement remains attached to the version loaded at startup.
