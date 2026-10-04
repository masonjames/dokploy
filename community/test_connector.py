"""No database/process launch: connector validation, framing and process failures."""

from dataclasses import replace
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import observation_connector as connector
from test_observation import TARGET, empty_result
from state_observation import CATALOGS


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.file = tempfile.NamedTemporaryFile()
        self.addCleanup(self.file.close)
        self.binding = connector.Binding(TARGET, 'fixture.hostler.invalid', self.file.name,
                                        connector.Baseline('pg_database_owner', None, None), 'throwaway')

    def output(self, **changes):
        envelope = dict(observation=dict(zip(connector.COLUMNS, empty_result().rows[0])),
                        version='180000', in_recovery=False, is_superuser='off',
                        public_owner='pg_database_owner', public_acl=None,
                        database_acl=None, extra_access=True, extra_objects=0)
        envelope.update(changes)
        return ('BEGIN\nSET\nSET\n' + json.dumps(envelope) + '\nROLLBACK\n').encode()

    def test_complete_framing_and_baseline(self):
        self.assertEqual(connector.decode(self.output(), self.binding).classification, 'NEW_EMPTY_CANDIDATE')
        for data in (b'', self.output()[:-9], b'extra\n' + self.output(), self.output() + b'extra\n',
                     self.output() + self.output(), self.output().replace(b'"version":', b'"version":"180000","version":'),
                     self.output().replace(b'"version": "180000"', b'"version": null'),
                     b'x' * 65537):
            with self.subTest():
                with self.assertRaises((ValueError, UnicodeError)):
                    connector.decode(data, self.binding)
        for changes in ({'version': '170000'}, {'in_recovery': True}, {'in_recovery': 0},
                        {'is_superuser': 'on'}, {'is_superuser': None},
                        {'extra_access': False}, {'extra_objects': True},
                        {'extra_objects': -1}, {'public_owner': 'wrong'}, {'public_acl': '{}'},
                        {'database_acl': '{}'}, {'observation': []}, {'extra': 0}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    connector.decode(self.output(**changes), self.binding)
        self.assertEqual(connector.decode(self.output(extra_objects=1), self.binding).classification, 'REFUSE_EXISTING')

    def test_untrusted_config_never_launches(self):
        changes = ({'tls_hostname': 'host sslmode=disable'}, {'tls_hostname': 'host\n.invalid'},
                   {'ca_file': 'relative'}, {'ca_file': '/definitely-absent-hostler-ca'},
                   {'password': ''}, {'password': 'x\x00'}, {'baseline': None},
                   {'baseline': replace(self.binding.baseline, public_acl=False)})
        targets = ({'server_address': 'localhost'}, {'server_address': '/tmp/socket'},
                   {'server_address': '127.0.0.1,127.0.0.2'}, {'server_port': True},
                   {'database_name': 'db sslmode=disable'}, {'database_name': "x'; DROP TABLE t"},
                   {'observer_role': 'postgres\n'}, {'installation_id': ''})
        with patch.object(connector.subprocess, 'Popen') as launch:
            for values in changes:
                self.assertEqual(connector.inspect(replace(self.binding, **values)).observation.classification, 'REFUSE_UNKNOWN')
            for values in targets:
                self.assertEqual(connector.inspect(replace(self.binding, target=replace(TARGET, **values))).observation.classification,
                                 'REFUSE_UNKNOWN')
            for purpose in ('restart', 'upgrade', None):
                self.assertEqual(connector.inspect(self.binding, purpose).observation.classification, 'REFUSE_EXISTING')
            launch.assert_not_called()
        self.assertNotIn('throwaway', repr(self.binding))

    def test_fixed_process_contract_and_refusals(self):
        owner = self

        class Process:
            def __init__(self, args, **kwargs):
                self.args, self.kwargs = args, kwargs
                self.returncode = None
                self.stdin = None
                self.killed = self.reaped = False
                owner.process = self
                owner.assertEqual(args[0], connector.PSQL)
                owner.assertEqual(args[1:-1], ['-X', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1', '-d'])
                owner.assertIn('sslmode=\'verify-full\'', args[-1])
                owner.assertIn('require_auth=\'scram-sha-256\'', args[-1])
                owner.assertIn('sslcertmode=\'disable\'', args[-1])
                owner.assertIn('channel_binding=\'require\'', args[-1])
                owner.assertIn('hostaddr=\'192.0.2.10\'', args[-1])
                owner.assertIn('client_encoding=\'UTF8\'', args[-1])
                owner.assertNotIn('throwaway', repr(args))
                owner.assertEqual(kwargs['env']['PGPASSWORD'], 'throwaway')
                owner.assertEqual(set(kwargs['env']), {'HOME', 'LC_ALL', 'PGPASSWORD',
                                                       'PGPASSFILE', 'PGSYSCONFDIR', 'PGSERVICEFILE'})
                owner.assertNotIn('PATH', kwargs['env'])
                owner.assertNotIn('PGSERVICE', kwargs['env'])

            def communicate(self, script, timeout):
                owner.assertEqual(script, connector.SQL.encode())
                owner.assertEqual(timeout, 5)
                if owner.failure:
                    raise owner.failure
                self.kwargs['stdout'].write(owner.payload)
                self.kwargs['stderr'].write(owner.error)
                self.returncode = owner.returncode

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

        self.failure, self.cleanup_failure = None, False
        self.payload, self.error, self.returncode = self.output(), b'', 0
        with patch.object(connector.subprocess, 'Popen', Process):
            result = connector.inspect(self.binding)
            self.assertEqual(result.observation.classification, 'NEW_EMPTY_CANDIDATE')
            self.assertTrue(self.process.reaped)
            for payload, error, code in ((b'', b'', 0), (self.output(), b'PRIVATE', 0),
                                         (self.output(), b'', 1), (self.output()[:-9], b'', 0)):
                self.payload, self.error, self.returncode = payload, error, code
                result = connector.inspect(self.binding)
                self.assertEqual(result.observation.classification, 'REFUSE_UNKNOWN')
                self.assertNotIn('PRIVATE', result.observation.reason)
            for failure in (subprocess.TimeoutExpired('fixed', 5), KeyboardInterrupt()):
                self.failure = failure
                if isinstance(failure, KeyboardInterrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        connector.inspect(self.binding)
                else:
                    self.assertEqual(connector.inspect(self.binding).observation.classification, 'REFUSE_UNKNOWN')
                self.assertTrue(self.process.killed and self.process.reaped)
            self.failure = None
            self.payload, self.error, self.returncode = self.output(), b'', 0
            self.cleanup_failure = True
            self.assertEqual(connector.inspect(self.binding).observation.classification, 'REFUSE_UNKNOWN')

    def test_safe_subscription_column_only(self):
        self.assertNotIn('pg_subscription', connector.EXTRA_CATALOGS + CATALOGS)
        self.assertIn("has_column_privilege('pg_catalog.pg_subscription', 'oid', 'SELECT')", connector.SQL)
        self.assertIn('count(oid) FROM pg_catalog.pg_subscription', connector.SQL)
        self.assertNotIn('count(*) FROM pg_catalog.pg_subscription', connector.SQL)


if __name__ == '__main__':
    unittest.main()
