"""Host-local Codex login slots. Credentials never leave this process's host."""
import base64
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import tomllib


class Problem(Exception):
    def __init__(self, code, blockers=None):
        self.code = code
        self.blockers = blockers or []


def identity(auth):
    try:
        tokens = auth['tokens']
        token = tokens['id_token'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)))
        user = claims.get('https://api.openai.com/auth', {}).get('chatgpt_user_id')
        account = tokens['account_id']
        if not isinstance(account, str) or not account or not isinstance(tokens['refresh_token'], str):
            raise ValueError()
        if auth.get('auth_mode', 'chatgpt') != 'chatgpt' or auth.get('OPENAI_API_KEY'):
            raise ValueError()
        return hashlib.sha256(json.dumps([user, account], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    except (KeyError, TypeError, ValueError, IndexError):
        raise Problem('unsupported_auth') from None


def read_json(file):
    try:
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 2 * 1024 * 1024:
            raise Problem('unsafe_file')
        return json.loads(file.read_text())
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeError):
        raise Problem('invalid_store') from None


def atomic_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.auth-', dir=file.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out, separators=(',', ':'))
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def lock(file):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Problem('busy') from None
                time.sleep(.05)
        yield
    finally:
        os.close(fd)


class Store:
    def __init__(self, home, root):
        self.home = pathlib.Path(home)
        self.root = pathlib.Path(root)
        self.active = self.home / 'auth.json'
        self.journal = self.root / 'transaction.json'

    def slot(self, key):
        if not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key):
            raise Problem('invalid_identity')
        return self.root / 'slots' / key

    def check_config(self):
        try:
            config = tomllib.loads((self.home / 'config.toml').read_text())
        except FileNotFoundError:
            config = {}
        except (ValueError, UnicodeError):
            raise Problem('invalid_config') from None
        if config.get('cli_auth_credentials_store', 'file') != 'file':
            raise Problem('unsupported_store')
        if any(config.get(k) for k in ['forced_login_method', 'forced_chatgpt_workspace_id', 'chatgpt_base_url']):
            raise Problem('managed_auth')
        if any(os.environ.get(k) for k in ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']):
            raise Problem('environment_auth')
        # Managed authentication requirements are not overridden by this helper.
        for file in [pathlib.Path('/etc/codex/requirements.toml'), self.home / 'requirements.toml', self.home / 'managed_config.toml']:
            if file.exists():
                raise Problem('managed_auth')

    def recover(self):
        journal = read_json(self.journal)
        if not journal:
            return
        before, after = journal['before'], journal['after']
        outgoing = self.slot(identity(before)) / 'auth.json' if before else None
        incoming = self.slot(identity(after)) / 'auth.json'
        with contextlib.ExitStack() as locks:
            for directory in sorted({p.parent for p in [outgoing, incoming] if p is not None}):
                locks.enter_context(lock(directory / 'auth.lock'))
            current = read_json(self.active)
            current_id = identity(current) if current else None
            before_id = identity(before) if before else None
            after_id = identity(after)
            previous = journal['previous_slot']
            stored_outgoing = read_json(outgoing) if outgoing else None
            if before_id and current_id == before_id:
                # Native refresh may have advanced this login; preserve the active file.
                if outgoing and stored_outgoing in [before, previous, None]:
                    if previous is None:
                        outgoing.unlink(missing_ok=True)
                    else:
                        atomic_json(outgoing, previous)
            else:
                # Finish only the slot side. Never overwrite a later login or logout.
                if outgoing and stored_outgoing in [before, previous, None]:
                    atomic_json(outgoing, before)
                if current_id == after_id:
                    if read_json(incoming) == after:
                        incoming.unlink(missing_ok=True)
                elif not incoming.exists():
                    atomic_json(incoming, after)
            self.journal.unlink()

    def status(self, key):
        self.slot(key)
        self.check_config()
        with lock(self.root / 'slots.lock'), lock(self.home / 'auth.lock'):
            self.recover()
            active = read_json(self.active)
            current = identity(active) if active else None
            saved = read_json(self.slot(key) / 'auth.json')
            saved_matches = bool(saved) and identity(saved) == key
            return {'current': current, 'ready': current == key or saved_matches}

    def inspect(self):
        # Reading the selected login must work even when switching is blocked.
        self.check_config()
        with lock(self.home / 'auth.lock'):
            active = read_json(self.active)
            return {'current': identity(active) if active else None}

    def commit(self, key, validate=None, guard=None):
        self.slot(key)
        self.check_config()
        with lock(self.root / 'slots.lock'):
            with lock(self.home / 'auth.lock'):
                self.recover()
                active = read_json(self.active)
                if active and identity(active) == key:
                    return {'current': key, 'applied': True, 'unchanged': True}
            incoming = self.slot(key) / 'auth.json'
            saved = read_json(incoming)
            if not saved:
                raise Problem('needs_login')
            if identity(saved) != key:
                raise Problem('wrong_account')
            # Validate/refresh the inactive login before changing the default login.
            if validate:
                validate(self.slot(key))
            with lock(self.home / 'auth.lock'), lock(self.slot(key) / 'auth.lock'):
                before = read_json(self.active)
                if before and identity(before) == key:
                    return {'current': key, 'applied': True, 'unchanged': True}
                if guard:
                    guard()
                after = read_json(incoming)
                if not after or identity(after) != key:
                    raise Problem('needs_login')
                outgoing = self.slot(identity(before)) / 'auth.json' if before else None
                with contextlib.ExitStack() as locks:
                    if outgoing:
                        locks.enter_context(lock(outgoing.parent / 'auth.lock'))
                    previous = read_json(outgoing) if outgoing else None
                    blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGHUP})
                    try:
                        atomic_json(self.journal, {'before': before, 'after': after, 'previous_slot': previous})
                        if outgoing:
                            atomic_json(outgoing, before)
                        atomic_json(self.active, after)
                        incoming.unlink()
                        self.journal.unlink()
                    finally:
                        signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
                if identity(read_json(self.active)) != key:
                    raise Problem('verification_failed')
                return {'current': key, 'applied': True, 'unchanged': False}


class Rpc:
    def __init__(self, executable, home):
        env = {k: v for k, v in os.environ.items() if not re.match(r'^(OPENAI|CODEX)_.*(KEY|TOKEN|BASE_URL)$', k)}
        env['CODEX_HOME'] = str(home)
        self.child = subprocess.Popen([executable, 'app-server', '-c', 'cli_auth_credentials_store="file"'],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        self.sequence = 0
        self.buffer = b''
        self.messages = []
        self.notifications = []
        try:
            self.request('initialize', {'clientInfo': {'name': 'ttokttok_apply', 'version': '1'}})
            self.send({'method': 'initialized'})
        except BaseException:
            self.close()
            raise

    def send(self, message):
        self.child.stdin.write(json.dumps(message).encode() + b'\n')
        self.child.stdin.flush()

    def receive(self, deadline):
        while not self.messages:
            if time.monotonic() >= deadline:
                raise Problem('timeout')
            ready, _, _ = select.select([self.child.stdout, sys.stdin], [], [], .2)
            if sys.stdin in ready and not os.read(sys.stdin.fileno(), 1):
                raise Problem('cancelled')
            if self.child.stdout in ready:
                data = os.read(self.child.stdout.fileno(), 65536)
                if not data:
                    raise Problem('codex_closed')
                self.buffer += data
                if len(self.buffer) > 8 * 1024 * 1024:
                    raise Problem('invalid_response')
                while b'\n' in self.buffer:
                    line, self.buffer = self.buffer.split(b'\n', 1)
                    try:
                        message = json.loads(line)
                        if not isinstance(message, dict):
                            raise ValueError()
                        self.messages.append(message)
                    except ValueError:
                        raise Problem('invalid_response') from None
        return self.messages.pop(0)

    def request(self, method, params=None):
        self.sequence += 1
        seq = self.sequence
        self.send({'id': seq, 'method': method, 'params': params or {}})
        deadline = time.monotonic() + 60
        while True:
            message = self.receive(deadline)
            if message.get('id') == seq and 'method' not in message:
                if 'error' in message:
                    raise Problem('codex_request_failed')
                return message.get('result', {})
            if 'method' in message and 'id' not in message:
                self.notifications.append(message)
            elif 'id' in message and 'method' in message:
                self.send({'id': message['id'], 'error': {'code': -32601, 'message': 'Unsupported client request'}})

    def login(self):
        response = self.request('account/login/start', {'type': 'chatgptDeviceCode'})
        from urllib.parse import urlparse
        url = response.get('verificationUrl', '')
        parsed = urlparse(url)
        code = response.get('userCode')
        if parsed.scheme != 'https' or parsed.hostname not in ['auth.openai.com', 'chatgpt.com'] or not isinstance(code, str) or len(code) > 100:
            raise Problem('invalid_response')
        send({'event': 'login', 'url': url, 'code': code})
        deadline = time.monotonic() + 600
        while True:
            message = self.notifications.pop(0) if self.notifications else self.receive(deadline)
            if message.get('method') == 'account/login/completed':
                if message.get('params', {}).get('success'):
                    return
                raise Problem('login_failed')

    def close(self):
        if self.child.poll() is not None:
            return
        try:
            self.child.stdin.close()
            self.child.wait(timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
                self.child.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.child.pid, signal.SIGKILL)
                except OSError:
                    pass
                self.child.wait()


def codex_executable():
    executable = shutil.which('codex') or str(pathlib.Path.home() / '.local/bin/codex')
    try:
        result = subprocess.run([executable, '--version'], capture_output=True, timeout=10, text=True)
    except (OSError, subprocess.TimeoutExpired):
        raise Problem('codex_missing') from None
    if not re.search(r'codex-cli 0\.(166|167)\.', result.stdout):
        raise Problem('unsupported_version')
    return executable


def check_running_writers(home):
    versions = {}
    blockers = []
    home = pathlib.Path(home).resolve()
    for process in pathlib.Path('/proc').iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            name = (process / 'comm').read_text().strip()
            if name not in ['codex', 'codex-app-serve']:
                continue
            # Only this key is interpreted; no process environment is printed or retained.
            configured = next((entry[len(b'CODEX_HOME='):].decode() for entry in (process / 'environ').read_bytes().split(b'\0') if entry.startswith(b'CODEX_HOME=')), None)
            process_home = pathlib.Path(configured) if configured else pathlib.Path.home() / '.codex'
            if not process_home.is_absolute():
                process_home = pathlib.Path(os.readlink(process / 'cwd')) / process_home
            if process_home.resolve() != home:
                continue
            executable = process / 'exe'
            client = 'VS Code extension' if 'vscode' in os.readlink(executable) else 'Codex'
            image = executable.stat()
            key = (image.st_dev, image.st_ino)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            blockers.append({'pid': int(process.name), 'version': 'unverified', 'client': 'Codex'})
            continue
        if key not in versions:
            try:
                result = subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=10)
                found = re.search(r'codex-cli ([0-9A-Za-z.\-]+)', result.stdout)
                versions[key] = found.group(1) if found else 'unverified'
            except (OSError, subprocess.TimeoutExpired):
                versions[key] = 'unverified'
        version = versions[key]
        if not re.fullmatch(r'0\.(166|167)\..*', version):
            blockers.append({'pid': int(process.name), 'version': version, 'client': client})
    if blockers:
        raise Problem('unknown_running_version', blockers)


def validate(executable, home):
    rpc = Rpc(executable, home)
    try:
        rpc.request('account/rateLimits/read')
    finally:
        rpc.close()


def send(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def main():
    request = json.loads(sys.stdin.readline())
    key = request.get('identity')
    operation = request.get('operation')
    if operation not in ['inspect', 'status', 'enroll', 'apply']:
        raise Problem('invalid_operation')
    home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
    store = Store(home, pathlib.Path.home() / '.ttokttok-pet' / 'codex-target-accounts')
    if operation == 'inspect':
        send({'result': store.inspect()})
        return
    executable = codex_executable()
    state = store.status(key)
    if state['current'] != key:
        check_running_writers(home)
    if operation == 'status':
        send({'result': state})
        return
    if operation == 'enroll':
        if state['ready']:
            send({'result': state})
            return
        with lock(store.root / 'slots.lock'):
            slot = store.slot(key)
            slot.mkdir(parents=True, exist_ok=True, mode=0o700)
            rpc = Rpc(executable, slot)
            try:
                rpc.login()
                auth = read_json(slot / 'auth.json')
                if identity(auth) != key:
                    try:
                        rpc.request('account/logout')
                    finally:
                        with lock(slot / 'auth.lock'):
                            (slot / 'auth.json').unlink(missing_ok=True)
                    raise Problem('wrong_account')
                rpc.request('account/rateLimits/read')
            finally:
                rpc.close()
        send({'result': store.status(key)})
        return
    send({'result': store.commit(key, lambda slot: validate(executable, slot), lambda: check_running_writers(home))})


if __name__ == '__main__':
    def interrupted(_sig, _frame):
        raise Problem('cancelled')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except Problem as error:
        send({'error': error.code, 'blockers': error.blockers})
    except (Exception, KeyboardInterrupt):
        send({'error': 'target_failed'})
