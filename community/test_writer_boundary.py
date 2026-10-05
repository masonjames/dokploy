"""Offline contract tests. Never initializes or connects to a database."""

import copy
import importlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import maintenance_fixture as fixture
import pg18_writer_fixture_tests as writer_gate
from migration_state import (ContractError, bootstrap_state, compare, decode,
                             descriptor, ledger_prefix, manifest, manifest_bytes)

HERE = Path(__file__).resolve().parent


class ChildEnvironment(unittest.TestCase):
    def test_actual_installed_node24_startup(self):
        fixture.node_startup_smoke()

    def test_synthetic_platform_and_exact_name_boundary(self):
        # All hostile names are synthetic object properties, never subprocess env.
        script = """
import assert from 'node:assert/strict';
import {checkFixtureChildEnvironment as check} from HELPER;
const home = '/synthetic-owned-home';
const clean = () => ({HOME: home, LC_ALL: 'C'});
for (const platform of ['darwin', 'linux', 'win32']) {
  const env = clean();
  check(env, platform, home);
  assert.deepEqual(env, clean());
  const cf = clean();
  Object.defineProperty(cf, '__CF_USER_TEXT_ENCODING', {
    enumerable: true, configurable: true,
    get() { throw new Error('must never read value'); }
  });
  if (platform === 'darwin') {
    check(cf, platform, home);
    assert.deepEqual(cf, clean());
  } else {
    assert.throws(() => check(cf, platform, home), /ambient child environment/);
    assert.ok(Object.hasOwn(cf, '__CF_USER_TEXT_ENCODING'));
  }
  for (const name of ['__CF_USER_TEXT_ENCODING_EXTRA', '__CF_USER_TEXT_ENCODIN',
      '__CF_OTHER', 'UNKNOWN', 'PGHOST', 'PGOPTIONS', 'PGPASSFILE', 'PG',
      'USER', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
    const env = {...clean(), [name]: 'synthetic'};
    assert.throws(() => check(env, platform, home), /ambient child environment/);
    assert.ok(Object.hasOwn(env, name));
  }
  for (const env of [{LC_ALL: 'C'}, {HOME: home}, {...clean(), HOME: '/wrong'},
      {...clean(), LC_ALL: 'wrong'}]) {
    assert.throws(() => check(env, platform, home), /fixture child environment inputs/);
  }
}
process.stdout.write('synthetic-environment-ok');
""".replace('HELPER', json.dumps((HERE / 'migrate_owned.mjs').as_uri()))
        with tempfile.TemporaryDirectory(prefix='hostler-node-test-', dir='/private/tmp') as home:
            result = subprocess.run([str(fixture.NODE), '--input-type=module', '-e', script],
                                    env={'HOME': home, 'LC_ALL': 'C'}, cwd=home,
                                    capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, 'synthetic environment boundary failed')
        self.assertEqual(result.stdout, 'synthetic-environment-ok')
        self.assertEqual(result.stderr, '')

    def test_preflight_refusal_precedes_fixture_or_evidence_creation(self):
        with patch.object(writer_gate, 'node_startup_smoke',
                          side_effect=fixture.FixtureError('preflight refused')) as smoke, \
                patch.object(writer_gate, 'OwnedFixture') as owned, \
                patch.object(writer_gate.tempfile, 'mkdtemp') as mkdir:
            with self.assertRaisesRegex(fixture.FixtureError, 'preflight refused'):
                writer_gate.WriterFixtureTests.setUpClass()
            smoke.assert_called_once_with()
            owned.assert_not_called()
            mkdir.assert_not_called()

    def test_smoke_exact_launch_and_sanitized_failure(self):
        with patch.object(fixture.subprocess, 'run', return_value=Mock(
                returncode=1, stdout='private-output', stderr='private-error')) as run:
            with self.assertRaisesRegex(fixture.FixtureError, '^offline Node24 startup smoke failed$'):
                fixture.node_startup_smoke()
        args, kwargs = run.call_args
        self.assertEqual(args[0][:3], [str(fixture.NODE), '--input-type=module', '-e'])
        self.assertEqual(kwargs['env'], {'HOME': kwargs['cwd'], 'LC_ALL': 'C'})
        self.assertIn('migrate_owned.mjs', args[0][3])
        self.assertNotIn('runFixtureChild', args[0][3])
        self.assertFalse(Path(kwargs['cwd']).exists())


class NegativeControls(unittest.TestCase):
    EXPECTED = {
        "COPY (SELECT 1) TO PROGRAM 'true'": '42501',
        "ALTER SYSTEM SET work_mem='8MB'": '0A000',
    }

    def test_exact_statement_mapping_and_controls_wiring(self):
        obj = Mock()
        def reply(statement, *args, **kwargs):
            self.assertEqual(kwargs, {'expect_error': True})
            if statement not in self.EXPECTED:
                raise RuntimeError('past explicit SQLSTATE controls')
            return (f'ERROR:  {self.EXPECTED[statement]}: denied\n'
                    'DETAIL:  mentions XX000\nHINT:  mentions 55000\n'
                    'LOCATION:  routine, source.c:1\n')
        obj.sql.side_effect = reply
        with self.assertRaisesRegex(RuntimeError, 'past explicit SQLSTATE controls'):
            writer_gate.controls(obj)
        self.assertEqual([call.args[0] for call in obj.sql.call_args_list[:2]], list(self.EXPECTED))
        with self.assertRaises(fixture.FixtureError):
            writer_gate.assert_control_error('SELECT 1', 'ERROR:  42501: denied\n')

    def test_wrong_and_swapped_codes_refuse(self):
        for statement, expected in self.EXPECTED.items():
            for code in {'42501', '0A000', '55000', 'XX000'} - {expected}:
                with self.subTest(statement=statement, code=code), self.assertRaises(fixture.FixtureError):
                    writer_gate.assert_control_error(statement, f'ERROR:  {code}: denied\n')

    def test_complete_captured_control_outputs(self):
        # Fixed sanitized stderr, including libpq's single-space WARNING.
        outputs = {
            "COPY (SELECT 1) TO PROGRAM 'true'": (
                'WARNING: password file "/dev/null" is not a plain file\n'
                'ERROR:  42501: permission denied to COPY to or from an external program\n'
                'DETAIL:  Only roles with privileges of the "pg_execute_server_program" role may COPY to or from an external program.\n'
                "HINT:  Anyone can COPY to stdout or from stdin. psql's \\copy command also works for anyone.\n"
                'LOCATION:  DoCopy, copy.c:88\n'
            ),
            "ALTER SYSTEM SET work_mem='8MB'": (
                'WARNING: password file "/dev/null" is not a plain file\n'
                'ERROR:  0A000: ALTER SYSTEM is not allowed in this environment\n'
                'LOCATION:  AlterSystemSetConfigFile, guc.c:4626\n'
            ),
        }
        for statement, output in outputs.items():
            with self.subTest(statement=statement):
                writer_gate.assert_control_error(statement, output)

    def test_unrelated_line_formatting_is_ignored(self):
        for statement, expected in self.EXPECTED.items():
            for text in ['unrecognized text\n', '\n', 'WARNING: single space\n',
                         'DETAIL:\nHINT: one space\nLOCATION:\tany format\n',
                         f' ERROR:  {expected}: quoted\n',
                         f'psql: ERROR:  {expected}: quoted\n',
                         'DETAIL:  ERROR:  XX000: quoted\n']:
                with self.subTest(statement=statement, text=text):
                    writer_gate.assert_control_error(statement, text + f'ERROR:  {expected}: denied\n' + text)

    def test_duplicate_conflicting_and_malformed_headers_refuse(self):
        for statement, expected in self.EXPECTED.items():
            valid = f'ERROR:  {expected}: denied\n'
            malformed = ['ERROR: denied\n', f'ERROR:  {expected} denied\n',
                         f'ERROR:  {expected}0: denied\n', f'ERROR:  {expected[:4]}: denied\n',
                         f'ERROR:  {expected.lower().replace("0", "x")}: denied\n',
                         f'ERROR:  {expected}:\n', 'ERROR without colon\n',
                         f'FATAL:  {expected}: denied\n', f'PANIC:  {expected}: denied\n',
                         'FATAL malformed\n', 'PANIC malformed\n']
            for output in [valid + valid, valid + 'ERROR:  XX000: other\n', *malformed,
                           *(valid + header for header in malformed)]:
                with self.subTest(statement=statement, output=output), self.assertRaises(fixture.FixtureError):
                    writer_gate.assert_control_error(statement, output)

    def test_expected_code_in_other_text_never_satisfies_control(self):
        for statement, expected in self.EXPECTED.items():
            for text in [f'unrelated {expected}\n', '',
                         f' ERROR:  {expected}: denied\n',
                         f'psql: ERROR:  {expected}: denied\n',
                         *(f'{label}:  ERROR:  {expected}: misleading\n'
                           for label in ['DETAIL', 'HINT', 'WARNING', 'LOCATION'])]:
                for output in [text, 'ERROR:  XX000: other\n' + text]:
                    with self.subTest(statement=statement, output=output), self.assertRaises(fixture.FixtureError):
                        writer_gate.assert_control_error(statement, output)


class WriterContracts(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.folder = Path(self.temp)
        (self.folder / 'meta').mkdir()
        self.journal = json.loads((HERE / 'writer_fixture/meta/_journal.json').read_bytes())
        for name in ['0000_seed.sql', '0001_upgrade.sql']:
            (self.folder / name).write_bytes((HERE / 'writer_fixture' / name).read_bytes())
        self.write_journal()

    def write_journal(self):
        (self.folder / 'meta/_journal.json').write_text(json.dumps(self.journal))

    def setting_rows(self):
        settings = fixture.SETTINGS | {'unix_socket_directories': str(self.folder / 's')}
        rows = [dict(name=name, setting='(disabled)' if name == 'archive_command' else value,
                     source='configuration file', sourcefile=str(self.folder / 'data/postgresql.conf'),
                     pending=False, boot='') for name, value in settings.items()]
        rows += [dict(name=name, setting=value, boot=value, source='default',
                      sourcefile=None, pending=False) for name, value in
                 [('max_connections', '100'), ('max_locks_per_transaction', '64')]]
        return settings, rows

    def test_archive_disabled_display_with_empty_configuration(self):
        settings, rows = self.setting_rows()
        self.assertEqual(settings['archive_mode'], 'off')
        self.assertEqual(settings['archive_command'], '')
        self.assertEqual(settings['archive_library'], '')
        fixture.verify_settings(rows, settings, self.folder)

    def test_archive_settings_drift_refuses(self):
        settings, valid = self.setting_rows()
        changes = [('archive_mode', 'setting', 'on'), ('archive_mode', 'setting', 'always'),
                   ('archive_command', 'setting', ''), ('archive_command', 'setting', 'true'),
                   ('archive_command', 'setting', '(disabled) '),
                   ('archive_library', 'setting', 'unexpected')]
        for name in ['archive_mode', 'archive_command', 'archive_library']:
            changes += [(name, 'source', 'default'), (name, 'sourcefile', None),
                        (name, 'sourcefile', str(self.folder / 'other.conf')),
                        (name, 'pending', True)]
        for name, field, value in changes:
            rows = copy.deepcopy(valid)
            next(row for row in rows if row['name'] == name)[field] = value
            with self.subTest(name=name, field=field, value=value), self.assertRaises(fixture.FixtureError):
                fixture.verify_settings(rows, settings, self.folder)
        for name, value in [('archive_mode', 'on'), ('archive_command', 'true')]:
            with self.subTest(config=name), self.assertRaises(fixture.FixtureError):
                fixture.verify_settings(valid, settings | {name: value}, self.folder)

    def test_archive_config_bytes_drift_refuses_before_query(self):
        obj = fixture.OwnedFixture()
        obj.root = self.folder
        (self.folder / 'data').mkdir()
        config = ''.join(f"{key} = '{value}'\n" for key, value in fixture.SETTINGS.items()).encode()
        self.assertIn(b"archive_command = ''\n", config)
        obj.fixed = {'postgresql.conf': config}
        for original, altered in [(b"archive_command = ''", b"archive_command = 'true'"),
                                  (b"archive_mode = 'off'", b"archive_mode = 'on'"),
                                  (b"archive_command = ''", b"archive_command = '(disabled)'")]:
            (self.folder / 'data/postgresql.conf').write_bytes(config.replace(original, altered))
            with self.subTest(altered=altered), patch.object(fixture, 'verify_owned'), \
                    patch.object(obj, 'sql', side_effect=AssertionError('query attempted')) as sql:
                with self.assertRaisesRegex(fixture.FixtureError, 'fixed configuration drift'):
                    obj.verify()
                sql.assert_not_called()

    def test_exact_session_visibility_projection(self):
        settings, rows = self.setting_rows()
        fixture.verify_settings(rows, settings, self.folder)
        hidden = {'session_preload_libraries', 'shared_preload_libraries', 'unix_socket_directories'}
        self.assertEqual(fixture.SESSION_HIDDEN_SETTINGS, hidden)
        visible = {row['name']: row['setting'] for row in rows if row['name'] not in hidden}
        self.assertEqual(len(visible), 14)
        self.assertEqual(visible['local_preload_libraries'], '')
        self.assertEqual(visible['archive_command'], '(disabled)')
        fixture.verify_session_settings(visible, rows)
        for name in visible:
            for changed in [{key: value for key, value in visible.items() if key != name},
                            visible | {name: None}, visible | {name: 'unexpected'}]:
                with self.subTest(name=name, changed=changed), self.assertRaises(fixture.FixtureError):
                    fixture.verify_session_settings(changed, rows)
        for name in hidden | {'unexpected_setting'}:
            with self.subTest(extra=name), self.assertRaises(fixture.FixtureError):
                fixture.verify_session_settings(visible | {name: ''}, rows)
        for invalid in [None, {}, [], '']:
            with self.subTest(invalid=invalid), self.assertRaises(fixture.FixtureError):
                fixture.verify_session_settings(invalid, rows)

    def test_hidden_settings_still_require_full_admin_validation(self):
        settings, rows = self.setting_rows()
        for name in fixture.SESSION_HIDDEN_SETTINGS:
            missing = [row for row in rows if row['name'] != name]
            variants = [missing, missing + [rows[0]]]
            for value in [None, 'unexpected']:
                variants.append([row | {'setting': value} if row['name'] == name else row for row in rows])
            for changed in variants:
                with self.subTest(name=name, rows=changed), self.assertRaises(fixture.FixtureError):
                    fixture.verify_settings(changed, settings, self.folder)

    def test_parameter_acl_refuses_before_any_nonsuperuser_query(self):
        obj = fixture.OwnedFixture()
        obj.root = self.folder
        obj.fixed = {}
        obj.settings, rows = self.setting_rows()
        identity = {'system': 'synthetic', 'start': 'synthetic'}
        obj.provision = json.dumps({'directories': {}, 'identity': identity}).encode()
        files = [[str(self.folder / 'data/postgresql.conf'), name, True, None] for name in obj.settings]
        # Everything before the ACL guard passes through the actual verifier.
        for count in ['1', '2', '', 'null']:
            replies = [json.dumps(identity), str(self.folder / 'data'), '0',
                       json.dumps(rows), json.dumps(files), '0', count]
            def admin_only(query, role='hostler_migrator'):
                self.assertEqual(role, 'hostler_admin', 'non-superuser SQL attempted')
                return replies.pop(0)
            with self.subTest(count=count), patch.object(fixture, 'verify_owned'), \
                    patch.object(obj, 'sql', side_effect=admin_only) as sql, \
                    patch.object(obj, 'read', side_effect=AssertionError('observer query attempted')) as read:
                with self.assertRaisesRegex(fixture.FixtureError, 'parameter ACL override'):
                    obj.verify()
                self.assertEqual(sql.call_count, 7)
                self.assertEqual(replies, [])
                sql.assert_called_with('SELECT count(*) FROM pg_parameter_acl', 'hostler_admin')
                read.assert_not_called()
            self.assertFalse((self.folder / 'session-settings.json').exists())

    def test_verifier_checks_both_role_projections_and_records_scope(self):
        obj = fixture.OwnedFixture()
        obj.root, obj.fixed = self.folder, {}
        obj.settings, rows = self.setting_rows()
        identity = {'system': 'synthetic', 'start': 'synthetic'}
        obj.provision = json.dumps({'directories': {}, 'identity': identity}).encode()
        files = [[str(self.folder / 'data/postgresql.conf'), name, True, None] for name in obj.settings]
        roles = [[name] + [name == 'hostler_admin'] * 5 + [True] for name in
                 ['hostler_admin', 'hostler_migrator', 'hostler_observer']]
        visible = {row['name']: row['setting'] for row in rows
                   if row['name'] not in fixture.SESSION_HIDDEN_SETTINGS}
        for drift_role in [None, 'hostler_migrator', 'hostler_observer']:
            replies = [json.dumps(identity), str(self.folder / 'data'), '0',
                       json.dumps(rows), json.dumps(files), '0', '0']
            def respond(query, role='hostler_migrator'):
                if role == 'hostler_admin':
                    return replies.pop(0)
                self.assertEqual(replies, [], 'non-superuser query preceded admin guards')
                self.assertIn('FROM pg_settings', query)
                return json.dumps(visible | {'local_preload_libraries': 'drift'}
                                  if role == drift_role else visible)
            with self.subTest(drift_role=drift_role), patch.object(fixture, 'verify_owned'), \
                    patch.object(obj, 'sql', side_effect=respond) as sql, \
                    patch.object(obj, 'read', side_effect=[roles, 0, True, False]):
                if drift_role:
                    with self.assertRaisesRegex(fixture.FixtureError, 'session setting override'):
                        obj.verify()
                else:
                    obj.verify()
                    evidence = json.loads((self.folder / 'session-settings.json').read_bytes())
                    self.assertEqual(evidence, {'hidden_requested_settings': sorted(fixture.SESSION_HIDDEN_SETTINGS),
                                               'parameter_acl_rows': 0,
                                               'sessions': dict.fromkeys(['hostler_migrator', 'hostler_observer'], visible)})
                    self.assertEqual(sql.call_count, 9)

    def test_manifest_journal_selection_and_snapshot(self):
        (self.folder / '0000_unselected.sql').write_text('SELECT 9;')
        result = manifest(self.folder)
        self.assertEqual(len(result['entries']), 2)
        self.assertEqual(len(result['files']), 3)
        (self.folder / '0000_seed.sql').write_text('changed')
        self.assertNotEqual(result['files']['0000_seed.sql'], b'changed')
        self.assertNotEqual(result['entries'][0]['hash'], manifest(self.folder)['entries'][0]['hash'])

    def test_manifest_rejects_paths_duplicate_tags_order_types(self):
        valid = copy.deepcopy(self.journal)
        for field, value in [('tag', '../escape'), ('tag', '/tmp/foreign'), ('tag', '0000_seed'),
                             ('tag', '0001_absent'), ('when', 1000), ('when', True),
                             ('idx', 3), ('idx', True), ('breakpoints', False), ('version', '8')]:
            with self.subTest(field=field, value=value):
                self.journal = copy.deepcopy(valid)
                self.journal['entries'][1][field] = value
                self.write_journal()
                with self.assertRaises(ContractError):
                    manifest(self.folder)

    def test_symlinks_and_duplicate_json_keys_refuse(self):
        file = self.folder / '0000_seed.sql'
        file.unlink()
        file.symlink_to(HERE / 'writer_fixture/0000_seed.sql')
        with self.assertRaises(ContractError):
            manifest(self.folder)
        with self.assertRaises(ContractError):
            decode('{"x":1,"x":2}')
        with self.assertRaises(ContractError):
            decode('{"x":NaN}')

    def test_snapshot_rejects_forged_paths_and_hashes(self):
        selected = manifest(self.folder)
        for name in ['../escape.sql', '/tmp/escape.sql', '0000_bad.sql/extra']:
            with self.assertRaises(ContractError):
                manifest_bytes(selected['journal'], selected['files'] | {name: b'SELECT 1;'})
        obj = fixture.OwnedFixture()
        obj.root = self.folder
        selected['entries'][0]['hash'] = 'not-a-digest'
        with patch.object(fixture, 'verify_owned'), self.assertRaises(fixture.FixtureError):
            obj.snapshot(selected, b'{}')
        self.assertFalse((self.folder / 'migrations').exists())

    def test_full_ledger_prefix_gaps_hash_order_and_native_types(self):
        entries = manifest(self.folder)['entries']
        valid = [dict(hash=e['hash'], created_at=e['when']) for e in entries]
        self.assertEqual(ledger_prefix(entries, valid), 2)
        self.assertEqual(ledger_prefix(entries, valid[:1]), 1)
        for rows in [valid[1:], valid[::-1], valid + valid[:1],
                     [valid[0] | {'hash': '0'*64}], [valid[0] | {'created_at': '1000'}],
                     [valid[0] | {'id': 1}], [valid[0], valid[0]]]:
            with self.subTest(rows=rows), self.assertRaises(ContractError):
                ledger_prefix(entries, rows)

    def test_bootstrap_is_distinct_and_never_repaired(self):
        self.assertEqual(bootstrap_state(False, [], []), 'none')
        self.assertEqual(bootstrap_state(True, [], []), 'schema-only')
        objects = [['__drizzle_migrations', 'r'], ['__drizzle_migrations_id_seq', 'S'], ['__drizzle_migrations_pkey', 'i']]
        self.assertEqual(bootstrap_state(True, objects, []), 'schema-empty-table-sequence-pk')
        for bad in [objects[:1], objects[::-1], objects + [['extra', 'r']]]:
            with self.assertRaises(ContractError):
                bootstrap_state(True, bad, [])

    def test_hand_authored_oracle_and_empty_sections(self):
        expected = descriptor(decode((HERE / 'writer_fixture/oracle.json').read_bytes()))
        compare(expected, copy.deepcopy(expected))
        self.assertEqual(expected['rows'], [[1, 'seed-upgraded', 'new', 2], [2, 'second', 'ready', 1]])
        for section, row in [('functions', ['public','unexpected','','body']),
                             ('rows', [3,'intruder','new',1]), ('extensions', ['x','1','public','hostler_migrator'])]:
            changed = copy.deepcopy(expected)
            changed[section].append(row)
            with self.assertRaises(ContractError):
                compare(expected, changed)
        for section in expected:
            changed = copy.deepcopy(expected)
            del changed[section]
            with self.assertRaises(ContractError):
                descriptor(changed)
        changed = copy.deepcopy(expected)
        changed['columns'][0][5] = 1  # bool/int equality must not hide catalog drift.
        with self.assertRaises(ContractError):
            compare(expected, changed)

    def test_foreign_and_forged_provisioning_refuse_before_process(self):
        obj = fixture.OwnedFixture()
        obj.root = Path(self.temp)
        obj.identity = (obj.root.stat().st_dev, obj.root.stat().st_ino)
        obj.provision = b'{"initdb":"completed"}'
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('process launched')):
            with self.assertRaises(fixture.FixtureError):
                fixture.verify_owned(obj)
            with self.assertRaises(fixture.FixtureError):
                fixture.cleanup(obj)
            with self.assertRaises(fixture.FixtureError):
                obj.command(['/bin/true'])

    def test_cleanup_unknown_child_or_server_retains(self):
        obj = fixture.OwnedFixture()
        obj.root = Path(self.temp)
        obj.success = True
        class Server:
            def poll(self):
                return None
        obj.server = Server()
        with patch.object(fixture, 'verify_owned'), patch.object(fixture.shutil, 'rmtree') as remove:
            with self.assertRaises(fixture.FixtureError):
                fixture.cleanup(obj)
            obj.server = None
            obj.children.add(object())
            with self.assertRaises(fixture.FixtureError):
                fixture.cleanup(obj)
            remove.assert_not_called()
        self.assertTrue(obj.root.exists())

    def test_imports_inert_and_no_authority_fields(self):
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('import launched process')) as spawn:
            importlib.reload(fixture)
            import runpy
            runpy.run_path(str(HERE / 'migration_state.py'))
            spawn.assert_not_called()
        for file in ['maintenance_fixture.py','migration_state.py','migrate_owned.mjs']:
            source = (HERE / file).read_text()
            self.assertNotIn('__main__', source)
            for field in ['migration_authorized','runtime_authorized','writer_exclusion_established']:
                self.assertNotIn(field, source)

    def test_maintained_exact_manifest_inventory(self):
        selected = manifest(HERE.parent / 'apps/dokploy/drizzle')
        self.assertEqual(len(selected['entries']), 196)
        self.assertEqual(len(selected['files']), 197)
        self.assertEqual(set(selected['files']) - {e['tag']+'.sql' for e in selected['entries']}, {'0130_abandoned_dagger.sql'})

    def test_security_descriptor_drift(self):
        expected = descriptor(decode((HERE / 'writer_fixture/oracle.json').read_bytes()))
        self.assertEqual(expected['policies'], [])
        for row in expected['relations']:
            self.assertEqual(row[3:], ['p', False, False])
        additions = [
            ('policies', ['public', 'fixture_item', 'unexpected', '*', True, ['PUBLIC'], 'true', None]),
            ('owners', ['function', 'public.unexpected(integer)', 'intruder']),
            ('grants', ['function', 'public.unexpected(integer)', 'PUBLIC', 'hostler_migrator', 'EXECUTE', False]),
            ('grants', ['type', 'public.fixture_state', 'PUBLIC', 'hostler_migrator', 'USAGE', False])]
        for section, row in additions:
            changed = copy.deepcopy(expected)
            changed[section].append(row)
            with self.subTest(section=section), self.assertRaisesRegex(ContractError, 'descriptor drift'):
                compare(expected, changed)
        for index, value in [(3, 'u'), (3, 't'), (4, True), (5, True), (4, 1), (5, 'false')]:
            for relation in range(len(expected['relations'])):
                changed = copy.deepcopy(expected)
                changed['relations'][relation][index] = value
                with self.subTest(index=index, relation=relation), self.assertRaises(ContractError):
                    compare(expected, changed)
        changed = copy.deepcopy(expected)
        changed['owners'][0][2] = 'intruder'
        with self.assertRaisesRegex(ContractError, 'owners'):
            compare(expected, changed)
        # A nonempty policy remains fully comparable, including roles and nullable expressions.
        expected['policies'] = [additions[0][1]]
        for index, value in [(2, 'other'), (3, 'r'), (4, False), (5, ['hostler_observer']),
                             (6, 'false'), (7, 'true'), (4, 1), (5, [0])]:
            changed = copy.deepcopy(expected)
            changed['policies'][0][index] = value
            with self.subTest(policy_field=index), self.assertRaises(ContractError):
                compare(expected, changed)

    def test_child_diagnostics_nonzero_are_private_and_bounded(self):
        obj = fixture.OwnedFixture()
        obj.root, obj.env = self.folder, {}
        child = Mock(pid=123, returncode=2)
        child.poll.return_value = 2
        child.communicate.return_value = ('prefix' + 'x' * 40000 + 'suffix', 'specific failure')
        with patch.object(fixture, 'verify_owned'), patch.object(subprocess, 'Popen', return_value=child):
            rc, _, _ = obj.command([str(fixture.PG / 'psql')], 'SELECT bad')
        self.assertEqual(rc, 2)
        file, = self.folder.glob('child-*.json')
        record = decode(file.read_bytes())
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(record['exit'], 2)
        self.assertEqual(record['purpose']['argv'], [str(fixture.PG / 'psql')])
        self.assertEqual(record['purpose']['stdin_sha256'], fixture.digest(b'SELECT bad'))
        self.assertTrue(record['stdout']['truncated'])
        self.assertTrue(record['stdout']['head'].startswith('prefix'))
        self.assertTrue(record['stdout']['tail'].endswith('suffix'))
        self.assertEqual(record['stderr']['head'], 'specific failure')
        self.assertFalse(obj.children)

    def test_child_timeout_interruption_and_unknown_exit_evidence(self):
        for error in [subprocess.TimeoutExpired('synthetic', 1, output=b'partial', stderr=b'error'),
                      KeyboardInterrupt()]:
            for known in [True, False]:
                with self.subTest(error=type(error).__name__, known=known):
                    obj = fixture.OwnedFixture()
                    obj.root = self.folder
                    child = Mock(pid=123)
                    child.poll.side_effect = [None, -9 if known else None]
                    child.communicate.side_effect = [error, ('drained', 'details') if known else
                        subprocess.TimeoutExpired('synthetic', 5, output=b'partial', stderr=b'error')]
                    obj.children.add(child)
                    before = set(self.folder.glob('child-*.json'))
                    with self.assertRaises(type(error)):
                        obj._communicate(child, {'operation': 'synthetic-test'})
                    file, = set(self.folder.glob('child-*.json')) - before
                    record = decode(file.read_bytes())
                    self.assertEqual(record['exception'], type(error).__name__)
                    self.assertEqual(record['exit'], -9 if known else None)
                    self.assertEqual(record['stdout']['head'], 'drained' if known else 'partial')
                    self.assertEqual(child in obj.children, not known)
                    child.kill.assert_called_once()
                    obj.success = True
                    with patch.object(fixture, 'verify_owned'), patch.object(fixture.shutil, 'rmtree') as remove:
                        if not known:
                            with self.assertRaises(fixture.FixtureError):
                                fixture.cleanup(obj)
                            remove.assert_not_called()

    def test_drizzle_nonzero_retains_output_before_refusal(self):
        obj = fixture.OwnedFixture()
        obj.root, obj.provision = self.folder, b'provision'
        obj.manifest = manifest(self.folder)
        child = Mock(pid=456, returncode=7)
        child.poll.return_value = 7
        child.communicate.return_value = ('child progress', 'loader failure')
        parent, endpoint = Mock(), Mock()
        endpoint.fileno.return_value = 9
        lock = (HERE.parent / 'pnpm-lock.yaml').read_bytes()
        with patch.object(obj, 'verify'), patch.object(obj, 'state', return_value='none'), \
                patch.object(obj, 'ledger', return_value=[]), patch.object(fixture, 'regular', return_value=lock), \
                patch.object(fixture.socket, 'socketpair', return_value=(parent, endpoint)), \
                patch.object(subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(fixture.FixtureError, 'internal executor failure'):
                obj.drizzle()
        file, = self.folder.glob('child-*.json')
        record = decode(file.read_bytes())
        self.assertEqual(record['purpose']['operation'], 'installed-drizzle-journal')
        self.assertEqual(record['exit'], 7)
        self.assertEqual(record['stdout']['head'], 'child progress')
        self.assertEqual(record['stderr']['head'], 'loader failure')
        self.assertFalse(obj.success)
        parent.close.assert_called_once()
