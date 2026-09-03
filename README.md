# @hfalconer/pi-history

Loads prompt history across session boundaries while keeping Pi's native editor and navigation logic.

- Resuming a session seeds the newly mounted native editor from that session's user messages.
- A new session adds prompts from all other sessions on the machine, newest session first, with the newest prompt first inside each session.
- The native 100-entry limit, duplicate handling, draft restoration, and arrow-key behavior remain unchanged.

Install from npm:

```sh
pi install npm:@hfalconer/pi-history
```

To test a local checkout:

```sh
pi -e .
```
