"""Synthetic psql protocol tests; never opens a database or starts a client."""

from dataclasses import fields, replace
import ast
import io
import hashlib
import os
import shlex
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import observation_connector as connector
import prestate_boundary as boundary
from test_observation import TARGET, empty_result


def output(**changes):
    envelope = dict(observation=dict(zip(connector.COLUMNS, empty_result().rows[0])),
                    version='180000', in_recovery=False, is_superuser='off',
                    public_owner='pg_database_owner', public_acl=None,
                    database_acl=None, extra_access=True, extra_objects=0)
    envelope.update(changes)
    return ('BEGIN\nSET\nSET\n' + json.dumps(envelope) + '\nROLLBACK\n').encode()


class PrestateTests(unittest.TestCase):
    def setUp(self):
        self.ca = tempfile.NamedTemporaryFile()
        self.addCleanup(self.ca.close)
        self.ca_bytes = b'externally trusted synthetic CA bytes'
        self.ca.write(self.ca_bytes)
        self.ca.flush()
        self.binding = connector.Binding(TARGET, 'fixture.hostler.invalid', self.ca.name,
                                        connector.Baseline('pg_database_owner', None, None), 'secret-fixture',
                                        hashlib.sha256(self.ca_bytes).hexdigest())
        self.payload = output()
        digest = connector.decode_evidence(self.payload, self.binding).prestate_sha256
        self.expected = boundary.Expected(TARGET, self.binding.baseline, self.binding.tls_hostname,
                                          self.ca.name, 'a' * 64, digest, self.binding.ca_sha256)
        self.processes = []
        self.responses = [self.payload, self.payload]
        self.cleanup_failure = False
        owner = self

        class Process:
            def __init__(self, args, **kwargs):
                parameters = dict(item.split('=', 1) for item in shlex.split(args[-1]))
                self.snapshot = Path(parameters['sslrootcert'])
                owner.assertNotEqual(str(self.snapshot), owner.binding.ca_file)
                owner.assertEqual(self.snapshot.read_bytes(), owner.ca_bytes)
                owner.assertEqual(self.snapshot.stat().st_mode & 0o777, 0o600)
                owner.assertEqual(self.snapshot.parent.stat().st_mode & 0o777, 0o700)
                self.stdout = kwargs['stdout']
                self.stdin = io.BytesIO()
                self.returncode = None
                self.killed = self.reaped = False
                owner.processes.append(self)

            def communicate(self, sql, timeout):
                owner.assertEqual(sql, connector.SQL.encode())
                response = owner.responses.pop(0)
                if isinstance(response, BaseException):
                    raise response
                self.stdout.write(response)
                self.returncode = 0

            def poll(self):
                return self.returncode

            def kill(self):
                self.killed = True
                self.returncode = -9

            def wait(self, timeout):
                self.reaped = True
                if owner.cleanup_failure:
                    raise OSError('PRIVATE')
                return self.returncode

        self.launch = self.enterContext(patch.object(connector.subprocess, 'Popen', side_effect=Process))

    def check(self, **kwargs):
        args = dict(binding=self.binding, candidate_sha256='a' * 64, expected=self.expected)
        args.update(kwargs)
        result = boundary.check(**args)
        self.assertEqual(result.result.exit_code, 1)
        self.assertIs(result.result.migration_authorized, False)
        self.assertIs(result.result.runtime_authorized, False)
        self.assertIs(result.result.observation.migration_authorized, False)
        self.assertIs(result.result.observation.runtime_authorized, False)
        self.assertIs(result.writer_exclusion_established, False)
        self.assertTrue(all(not p.snapshot.parent.exists() for p in self.processes))
        return result

    def test_matching_prerequisite_still_refuses_exclusion(self):
        result = self.check()
        self.assertTrue(result.observations_match)
        self.assertEqual(result.result.observation.classification, 'REFUSE_WRITER_EXCLUSION')
        self.assertEqual(len(self.processes), 2)
        self.assertIsNot(self.processes[0], self.processes[1])
        self.assertTrue(all(p.reaped and p.stdin.closed for p in self.processes))
        self.assertNotIn('secret-fixture', repr(result))

    def test_each_external_target_component_and_candidate_substitution(self):
        for field in fields(TARGET):
            value = getattr(TARGET, field.name)
            changed = value + 1 if type(value) is int else value + 'x'
            expected = replace(self.expected, target=replace(TARGET, **{field.name: changed}))
            with self.subTest(field=field.name):
                self.assertIn(self.check(expected=expected).result.observation.classification,
                              ('REFUSE_SCOPE', 'REFUSE_UNKNOWN'))
        for expected in (replace(self.expected, tls_hostname='other.invalid'),
                         replace(self.expected, ca_file='/other-ca'),
                         replace(self.expected, baseline=replace(self.binding.baseline, public_acl='{}')),
                         replace(self.expected, candidate_sha256='b' * 64)):
            self.assertEqual(self.check(expected=expected).result.observation.classification, 'REFUSE_SCOPE')
        self.assertEqual(self.check(candidate_sha256='b' * 64).result.observation.classification, 'REFUSE_SCOPE')
        self.launch.assert_not_called()

    def test_old_digest_cannot_move_to_another_installation_or_tls_scope(self):
        for binding in (replace(self.binding, target=replace(TARGET, installation_id='another-install')),
                        replace(self.binding, tls_hostname='another.invalid')):
            self.responses = [self.payload]
            expected = replace(self.expected, target=binding.target, tls_hostname=binding.tls_hostname)
            self.assertEqual(self.check(binding=binding, expected=expected).result.observation.classification,
                             'REFUSE_PRESTATE')

    def test_invalid_expected_and_distinct_operation_refusal(self):
        for expected in (None, {}, replace(self.expected, prestate_sha256=''),
                         replace(self.expected, candidate_sha256=True)):
            self.assertEqual(self.check(expected=expected).result.observation.classification, 'REFUSE_UNKNOWN')
        for purpose in ('initial', 'restart', 'upgrade', 'recovery', None, True):
            self.assertEqual(self.check(purpose=purpose).result.observation.classification, 'REFUSE_OPERATION')
        self.launch.assert_not_called()

    def test_expected_native_types_cannot_hide_behind_equality(self):
        binding = replace(self.binding, target=replace(TARGET, database_oid=1))
        expected = replace(self.expected, target=replace(binding.target, database_oid=True))
        self.assertEqual(self.check(binding=binding, expected=expected).result.observation.classification,
                         'REFUSE_UNKNOWN')
        self.launch.assert_not_called()

    def test_all_expected_fields_reject_custom_values_before_comparison_or_open(self):
        comparisons = []

        class Hostile:
            def __eq__(self, other):
                comparisons.append(other)
                return True

        class Text(str):
            def __eq__(self, other):
                comparisons.append(other)
                return True

        cases = []
        for field in fields(self.expected):
            for value in (Hostile(), True, 1, Text('lookalike')):
                cases.append(replace(self.expected, **{field.name: value}))
        for field in fields(TARGET):
            for value in (Hostile(), True, Text(str(getattr(TARGET, field.name)))):
                cases.append(replace(self.expected, target=replace(TARGET, **{field.name: value})))
        for field in fields(self.binding.baseline):
            for value in (Hostile(), True, Text('owner'), '', 'bad\x00value'):
                cases.append(replace(self.expected, baseline=replace(
                    self.binding.baseline, **{field.name: value})))
        with patch.object(connector.os, 'open', side_effect=AssertionError('filesystem accessed')) as opened:
            for expected in cases:
                with self.subTest(expected_field_types=[type(getattr(expected, f.name)).__name__
                                                       for f in fields(expected)]):
                    result = self.check(expected=expected)
                    self.assertEqual(result.result.observation.classification, 'REFUSE_UNKNOWN')
                    self.assertFalse(result.observations_match)
            opened.assert_not_called()
        self.assertEqual(comparisons, [])
        self.launch.assert_not_called()

    def test_ca_missing_malformed_changed_empty_oversize_and_special_refuse(self):
        for digest in (None, '', 'A' * 64, 'g' * 64, True, '0' * 63):
            self.assertFalse(self.check(binding=replace(self.binding, ca_sha256=digest)).observations_match)
        for data in (b'changed CA at same pathname', b'', b'x' * (connector.MAX_CA_BYTES + 1)):
            Path(self.ca.name).write_bytes(data)
            self.assertEqual(self.check().result.observation.classification, 'REFUSE_UNKNOWN')
        with tempfile.TemporaryDirectory() as root:
            symlink = Path(root) / 'link'
            symlink.symlink_to(self.ca.name)
            fifo = Path(root) / 'fifo'
            os.mkfifo(fifo)
            for path in (symlink, fifo, Path(root), Path(root) / 'missing'):
                self.assertEqual(self.check(binding=replace(self.binding, ca_file=str(path)),
                    expected=replace(self.expected, ca_file=str(path))).result.observation.classification,
                    'REFUSE_UNKNOWN')
        self.launch.assert_not_called()

    def test_source_replacement_after_pin_cannot_switch_psql_trust(self):
        original = connector._snapshot_ca
        snapshots = []

        def snapshot(binding, home):
            path = original(binding, home)
            snapshots.append(Path(path))
            Path(binding.ca_file).unlink()
            Path(binding.ca_file).write_bytes(b'replacement untrusted CA')
            return path

        with patch.object(connector, '_snapshot_ca', side_effect=snapshot):
            result = self.check()
        # First psql consumed verified bytes, second read refuses the replaced source.
        self.assertEqual(len(self.processes), 1)
        self.assertEqual(result.result.observation.classification, 'REFUSE_UNKNOWN')
        self.assertFalse(result.observations_match)
        self.assertTrue(all(not path.parent.exists() for path in snapshots))

    def test_snapshot_write_failure_cleans_owned_directory_before_refusal(self):
        original = connector.os.open
        homes = []

        def open_file(path, flags, *args, **kwargs):
            if flags & os.O_CREAT:
                homes.append(Path(path).parent)
                raise OSError('PRIVATE snapshot creation failure')
            return original(path, flags, *args, **kwargs)

        with patch.object(connector.os, 'open', side_effect=open_file):
            self.assertEqual(self.check().result.observation.classification, 'REFUSE_UNKNOWN')
        self.assertEqual(len(homes), 1)
        self.assertFalse(homes[0].exists())
        self.launch.assert_not_called()

    def test_snapshot_creation_launch_and_directory_cleanup_failures(self):
        snapshots = []
        original_snapshot = connector._snapshot_ca

        def snapshot(binding, home):
            path = original_snapshot(binding, home)
            snapshots.append(Path(path))
            return path

        with patch.object(connector, '_snapshot_ca', side_effect=snapshot), \
                patch.object(connector.subprocess, 'Popen', side_effect=OSError('PRIVATE')):
            self.assertFalse(self.check().observations_match)
        self.assertEqual(len(snapshots), 1)
        self.assertFalse(snapshots[0].parent.exists())
        original = connector.tempfile.TemporaryDirectory
        homes = []

        class CleanupFailure:
            def __enter__(self):
                self.directory = original(prefix='hostler-test-cleanup-')
                homes.append(Path(self.directory.name))
                return self.directory.__enter__()

            def __exit__(self, *args):
                self.directory.__exit__(*args)
                raise OSError('PRIVATE cleanup failure')

        with patch.object(connector.tempfile, 'TemporaryDirectory', side_effect=lambda **k: CleanupFailure()):
            self.assertFalse(self.check().observations_match)
        self.assertTrue(all(not home.exists() for home in homes))
        original_snapshot = connector._snapshot_ca

        def interrupted(binding, home):
            original_snapshot(binding, home)
            homes.append(Path(home))
            raise KeyboardInterrupt()

        with patch.object(connector, '_snapshot_ca', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.check()
        self.assertTrue(all(not home.exists() for home in homes))

    def test_stale_expected_stops_after_first_read(self):
        result = self.check(expected=replace(self.expected, prestate_sha256='b' * 64))
        self.assertEqual(result.result.observation.classification, 'REFUSE_PRESTATE')
        self.assertFalse(result.observations_match)
        self.assertEqual(len(self.processes), 1)

    def test_reobservation_drift_and_errors(self):
        row = dict(zip(connector.COLUMNS, empty_result().rows[0]))
        cases = [(output(observation={**row, 'snapshot': '101:101:'}), 'REFUSE_PRESTATE'),
                 (output(version='180001'), 'REFUSE_PRESTATE'),
                 (output(observation={**row, 'database_oid': TARGET.database_oid + 1}), 'REFUSE_IDENTITY'),
                 (output(observation={**row, 'relations': 1}), 'REFUSE_EXISTING'),
                 (output(public_acl='{}'), 'REFUSE_UNKNOWN'),
                 (output(extra_objects=1), 'REFUSE_EXISTING'),
                 (b'partial crash output', 'REFUSE_UNKNOWN'),
                 (OSError('PRIVATE'), 'REFUSE_UNKNOWN')]
        for payload, classification in cases:
            with self.subTest(classification=classification):
                self.responses = [self.payload, payload]
                result = self.check()
                self.assertEqual(result.result.observation.classification, classification)
                self.assertFalse(result.observations_match)
                self.assertNotIn('PRIVATE', repr(result))
                self.assertTrue(all(p.reaped and p.stdin.closed for p in self.processes))

    def test_cancellation_then_partial_state_and_fresh_recovery(self):
        for position in (0, 1):
            self.responses = [self.payload] * position + [KeyboardInterrupt()]
            with self.assertRaises(KeyboardInterrupt):
                self.check()
            self.assertTrue(self.processes[-1].killed and self.processes[-1].reaped)
            self.assertTrue(self.processes[-1].stdin.closed)
            self.assertFalse(self.processes[-1].snapshot.parent.exists())
        row = dict(zip(connector.COLUMNS, empty_result().rows[0]))
        self.responses = [output(observation={**row, 'relations': 1})]
        self.assertEqual(self.check().result.observation.classification, 'REFUSE_EXISTING')
        self.responses = [self.payload, self.payload]
        self.assertTrue(self.check().observations_match)
        self.assertEqual(len(self.responses), 0)

    def test_cleanup_failure_cannot_publish_evidence(self):
        self.cleanup_failure = True
        result = self.check()
        self.assertEqual(result.result.observation.classification, 'REFUSE_UNKNOWN')
        self.assertFalse(result.observations_match)
        self.assertEqual(len(self.processes), 1)
        self.assertTrue(self.processes[0].stdin.closed)

    def test_invisible_concurrency_never_becomes_exclusion(self):
        # A writer's uncommitted/rolled-back work need not change either payload.
        # This intentionally identical trace must never produce writer authority.
        self.assertEqual(self.check().result.observation.classification, 'REFUSE_WRITER_EXCLUSION')
        self.responses = [self.payload, self.payload]
        # Replaying serialized diagnostic expectation still requires two new reads.
        saved = json.loads(json.dumps({'prestate_sha256': self.expected.prestate_sha256}))
        self.assertTrue(self.check(expected=replace(self.expected, **saved)).observations_match)
        self.assertEqual(len(self.processes), 4)

    def test_digest_covers_entire_envelope_and_is_canonical(self):
        digest = connector.decode_evidence(self.payload, self.binding).prestate_sha256
        row = dict(zip(connector.COLUMNS, empty_result().rows[0]))
        for payload in (output(version='180001'), output(observation={**row, 'snapshot': '101:101:'})):
            self.assertNotEqual(connector.decode_evidence(payload, self.binding).prestate_sha256, digest)
        self.assertIsNone(connector.decode_evidence(output(extra_objects=1), self.binding).prestate_sha256)
        lines = self.payload.decode().splitlines()
        envelope = json.loads(lines[3])
        lines[3] = json.dumps(dict(reversed(list(envelope.items()))), separators=(',', ':'))
        self.assertEqual(connector.decode_evidence('\n'.join(lines).encode(), self.binding).prestate_sha256, digest)
        self.launch.assert_not_called()

    def test_imports_inert_and_no_runtime_dependency(self):
        allowed = {'dataclasses', 're', 'observation_connector', 'observe_entry',
                   'state_observation', 'state_policy'}
        path = Path(boundary.__file__)
        source = path.read_text()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.ImportFrom):
                self.assertIn(node.module, allowed)
            elif isinstance(node, ast.Import):
                self.assertTrue(all(item.name in allowed for item in node.names))
        with patch.object(connector, 'inspect_evidence', side_effect=AssertionError('import observed')):
            exec(compile(source, str(path), 'exec'), {'__name__': boundary.__name__})
        self.launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
