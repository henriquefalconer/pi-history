"""Offline smoke test of the extension-filtered /resume UI. Requires Pi and a POSIX PTY."""
import os, pty, subprocess, select, time, re, tempfile, pathlib, json, fcntl, termios, struct, hashlib, shutil
repo = str(pathlib.Path(__file__).resolve().parents[1])
pi = shutil.which('pi')
assert pi, 'Install Pi before running this UI smoke test'
with tempfile.TemporaryDirectory(prefix='pi-history-ui-') as temp:
    root = pathlib.Path(temp).resolve()
    agent = root / 'agent'
    cwd = root / 'project'
    cwd.mkdir()
    folder = agent / 'sessions' / ('--' + str(cwd)[1:].replace('/', '-') + '--')
    folder.mkdir(parents=True)
    (agent / 'settings.json').write_text(json.dumps({'packages': [repo], 'quietStartup': True}))
    (agent / 'pi-history-cache.json').write_text(json.dumps({'version': 4, 'markerSince': 1, 'sessions': {}}))
    kinds = agent / 'pi-history-kinds'
    kinds.mkdir()
    for name, headless in [('COMPACTED-INTERACTIVE-CHECK', False), ('HEADLESS-MUST-NOT-APPEAR', True), ('HEADLESS-MARKER-LOST', True), ('UNKNOWN-COMPACTED', None)]:
        entries = [
            {'type': 'session', 'version': 3, 'id': name, 'cwd': str(cwd), 'timestamp': '2026-10-01T00:00:00Z'},
            {'type': 'compaction', 'id': 'c', 'parentId': None, 'firstKeptEntryId': 'c', 'tokensBefore': 1000, 'summary': name, 'timestamp': '2026-10-03T00:00:00Z'},
        ]
        if name == 'HEADLESS-MUST-NOT-APPEAR':
            entries.append({'type': 'custom', 'id': 'h', 'parentId': 'c', 'timestamp': '2026-10-03T00:00:01Z', 'customType': 'hfalconer/pi-history:headless'})
        path = folder / (name + '.jsonl')
        path.write_text(''.join(json.dumps(e, separators=(',', ':')) + '\n' for e in entries))
        if headless is not None:
            key = hashlib.sha256(str(path).encode()).hexdigest()
            (kinds / (key + '.json')).write_text(json.dumps({'id': name, 'kind': 'headless' if headless else 'interactive'}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 150, 0, 0))
    env = dict(os.environ, TERM='xterm-256color', PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1', PI_HISTORY_DEBUG=str(root / 'debug.log'))
    process = subprocess.Popen([pi, '--offline', '--no-session', '--no-skills', '--no-prompt-templates'], cwd=cwd, stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    def receive_until(needle, timeout=15):
        data = b''
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data += os.read(master, 65536)
                except OSError:
                    break
                if needle in data:
                    return data
        raise AssertionError('Missing ' + repr(needle) + '\n' + data.decode(errors='replace'))
    def settle():
        # Discard repaint bytes from the previous screen before asserting on
        # the next one. Ctrl+C is unambiguous, unlike Escape followed by text.
        time.sleep(0.15)
        while select.select([master], [], [], 0)[0]:
            os.read(master, 65536)
    try:
        receive_until(b'No models available')
        os.write(master, b'/resume\r')
        output = receive_until(b'COMPACTED-INTERACTIVE-CHECK')
        assert b'HEADLESS-MUST-NOT-APPEAR' not in output
        assert b'HEADLESS-MARKER-LOST' not in output
        assert b'UNKNOWN-COMPACTED' not in output
        print('PASS: extension-filtered /resume shows the known interactive compacted session, excludes headless with and without markers, and excludes unknown compactions.')
        debug = (root / 'debug.log').read_text()
        assert re.search(r'list listed 1 in \d+ms', debug), debug
        print(debug)
        os.write(master, b'\x03')  # Ctrl+C cancels without Escape's Alt-key ambiguity.
        settle()
        # A missing file is reported without creating or switching sessions.
        os.write(master, ('/history-recover ' + str(folder / 'absent.jsonl') + '\r').encode())
        receive_until(b'Cannot recover session:')
        for name in ['HEADLESS-MUST-NOT-APPEAR', 'HEADLESS-MARKER-LOST']:
            os.write(master, ('/history-recover ' + str(folder / (name + '.jsonl')) + '\r').encode())
            receive_until(b'Known headless sessions cannot be recovered')
        unknown = folder / 'UNKNOWN-COMPACTED.jsonl'
        before = unknown.read_bytes()
        command = ('/history-recover ' + str(unknown) + '\r').encode()
        os.write(master, command)
        receive_until(b'Recover interactive session?')
        os.write(master, b'\x03')
        settle()
        os.write(master, b'/resume\r')
        output = receive_until(b'COMPACTED-INTERACTIVE-CHECK')
        assert b'UNKNOWN-COMPACTED' not in output
        assert unknown.read_bytes() == before
        os.write(master, b'\x03')
        settle()
        os.write(master, command)
        receive_until(b'Recover interactive session?')
        os.write(master, b'\r')
        receive_until(b'Resumed session')
        settle()
        os.write(master, b'/resume\r')
        output = receive_until(b'UNKNOWN-COMPACTED')
        assert b'HEADLESS-MUST-NOT-APPEAR' not in output
        assert b'HEADLESS-MARKER-LOST' not in output
        debug = (root / 'debug.log').read_text()
        assert re.search(r'list listed 2 in \d+ms', debug), debug
        key = hashlib.sha256(str(unknown).encode()).hexdigest()
        assert json.loads((kinds / (key + '.json')).read_text())['kind'] == 'interactive'
        print('PASS: recovery rejects missing/headless sessions, cancel changes nothing, and confirmed recovery restores warm /resume listing.')
    finally:
        if (root / 'debug.log').exists():
            print('DEBUG:', (root / 'debug.log').read_text())
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
