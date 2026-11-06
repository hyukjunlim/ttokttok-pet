import base64
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('target', pathlib.Path(__file__).parents[1] / 'src/codex-accounts/target.py')
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)


def auth(name, revision=1):
    claims = {'https://api.openai.com/auth': {'chatgpt_user_id': 'example-user-' + name}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    return {'auth_mode': 'chatgpt', 'OPENAI_API_KEY': None, 'tokens': {
        'id_token': 'example.' + payload + '.signature', 'account_id': 'example-workspace-' + name,
        'access_token': 'example-access-' + str(revision), 'refresh_token': 'example-refresh-' + name + str(revision)}}


class SlotsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = pathlib.Path(self.temp.name)
        self.store = target.Store(base / 'codex', base / 'pet')
        self.a, self.b = auth('a'), auth('b')
        self.ka, self.kb = target.identity(self.a), target.identity(self.b)
        target.atomic_json(self.store.active, self.a)
        target.atomic_json(self.store.slot(self.kb) / 'auth.json', self.b)
        self.history = self.store.home / 'sessions' / 'example.jsonl'
        self.history.parent.mkdir()
        self.history.write_text('example conversation')

    def test_switch_moves_credentials_and_preserves_conversation_location(self):
        result = self.store.commit(self.kb)
        self.assertEqual(target.read_json(self.store.active), self.b)
        self.assertEqual(target.read_json(self.store.slot(self.ka) / 'auth.json'), self.a)
        self.assertFalse((self.store.slot(self.kb) / 'auth.json').exists())
        self.assertEqual(self.history.read_text(), 'example conversation')
        self.assertEqual(self.store.active.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('example-refresh', json.dumps(result))
        self.assertTrue(self.store.commit(self.kb)['unchanged'])
        self.store.commit(self.ka)
        self.assertEqual(target.read_json(self.store.active), self.a)

    def test_current_native_refresh_is_archived_not_a_stale_snapshot(self):
        updated = auth('a', 2)
        def refresh(_slot):
            target.atomic_json(self.store.active, updated)
        self.store.commit(self.kb, refresh)
        self.assertEqual(target.read_json(self.store.slot(self.ka) / 'auth.json'), updated)

    def test_validation_failure_changes_neither_account(self):
        def fail(_slot):
            raise target.Problem('needs_login')
        with self.assertRaises(target.Problem):
            self.store.commit(self.kb, fail)
        self.assertEqual(target.read_json(self.store.active), self.a)
        self.assertEqual(target.read_json(self.store.slot(self.kb) / 'auth.json'), self.b)

    def test_crash_before_active_commit_recovers_old_default(self):
        original = target.atomic_json
        def fail(file, data):
            if file == self.store.active:
                raise OSError('simulated failure')
            original(file, data)
        with patch.object(target, 'atomic_json', fail), self.assertRaises(OSError):
            self.store.commit(self.kb)
        self.assertTrue(self.store.journal.exists())
        self.store.status(self.kb)
        self.assertEqual(target.read_json(self.store.active), self.a)
        self.assertFalse((self.store.slot(self.ka) / 'auth.json').exists())
        self.assertFalse(self.store.journal.exists())

    def test_crash_after_active_commit_finishes_without_duplicating_login(self):
        incoming = self.store.slot(self.kb) / 'auth.json'
        original = pathlib.Path.unlink
        def fail(file, *args, **kwargs):
            if file == incoming:
                raise OSError('simulated failure')
            return original(file, *args, **kwargs)
        with patch.object(pathlib.Path, 'unlink', fail), self.assertRaises(OSError):
            self.store.commit(self.kb)
        self.assertEqual(target.read_json(self.store.active), self.b)
        self.store.status(self.kb)
        self.assertFalse(incoming.exists())
        self.assertEqual(target.read_json(self.store.slot(self.ka) / 'auth.json'), self.a)

    def test_recovery_never_overwrites_a_later_external_login(self):
        target.atomic_json(self.store.journal, {'before': self.a, 'after': self.b, 'previous_slot': None})
        external = auth('c')
        target.atomic_json(self.store.active, external)
        self.store.status(self.kb)
        self.assertEqual(target.read_json(self.store.active), external)
        self.assertEqual(target.read_json(self.store.slot(self.ka) / 'auth.json'), self.a)
        self.assertFalse(self.store.journal.exists())

    def test_recovery_preserves_tokens_refreshed_after_active_commit(self):
        target.atomic_json(self.store.journal, {'before': self.a, 'after': self.b, 'previous_slot': None})
        refreshed = auth('b', 2)
        target.atomic_json(self.store.active, refreshed)
        self.store.status(self.kb)
        self.assertEqual(target.read_json(self.store.active), refreshed)
        self.assertFalse((self.store.slot(self.kb) / 'auth.json').exists())
        self.assertEqual(target.read_json(self.store.slot(self.ka) / 'auth.json'), self.a)
        self.assertFalse(self.store.journal.exists())

    def test_managed_and_nonfile_auth_are_preserved(self):
        for config in ['cli_auth_credentials_store="keyring"', 'forced_login_method="chatgpt"']:
            (self.store.home / 'config.toml').write_text(config)
            with self.assertRaises(target.Problem):
                self.store.commit(self.kb)
            self.assertEqual(target.read_json(self.store.active), self.a)

    def test_invalid_identity_and_symlink_are_rejected(self):
        with self.assertRaises(target.Problem):
            self.store.slot('../escape')
        self.store.active.unlink()
        self.store.active.symlink_to(self.store.slot(self.kb) / 'auth.json')
        with self.assertRaises(target.Problem):
            self.store.status(self.kb)

    def test_wrong_account_in_slot_is_rejected(self):
        target.atomic_json(self.store.slot(self.kb) / 'auth.json', self.a)
        self.assertFalse(self.store.status(self.kb)['ready'])
        with self.assertRaises(target.Problem):
            self.store.commit(self.kb)
        self.assertEqual(target.read_json(self.store.active), self.a)

    def test_inspect_reads_current_login_without_recovering_or_changing_slots(self):
        journal = {'before': self.a, 'after': self.b, 'previous_slot': None}
        target.atomic_json(self.store.journal, journal)
        self.assertEqual(self.store.inspect(), {'current': self.ka})
        self.assertEqual(target.read_json(self.store.journal), journal)
        self.assertEqual(target.read_json(self.store.active), self.a)


if __name__ == '__main__':
    unittest.main()
