"""Explicit opt-in real PG18 tests. Discovery does not import/start this harness.

Only a newly initialized owned loopback cluster is ever contacted. No operational
configuration, credentials, existing service, socket, or dependency acquisition.
"""

from dataclasses import replace
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import observation_connector as connector
from state_observation import Target

PG = Path('/opt/homebrew/opt/postgresql@18/bin')
OPENSSL = '/opt/homebrew/opt/openssl@3/bin/openssl'


class DisposableCluster:
    def __enter__(self):
        self.root = Path(tempfile.mkdtemp(prefix='hostler-pg18-fixture-'))
        self.server = None
        self.log = None
        self.password = secrets.token_urlsafe(32)
        self.environment = {'HOME': str(self.root), 'LC_ALL': 'C',
                            'PGPASSFILE': '/dev/null', 'PGSYSCONFDIR': str(self.root)}
        try:
            for executable in ('postgres', 'initdb', 'psql'):
                if not (PG / executable).is_file():
                    raise RuntimeError('Explicit PG18 fixture gate requires existing PG18 binaries')
            if not Path(OPENSSL).is_file():
                raise RuntimeError('Explicit PG18 fixture gate requires existing OpenSSL')
            self.command([str(PG / 'postgres'), '--version'])
            password_file = self.root / 'bootstrap-password'
            password_file.write_text(self.password)
            password_file.chmod(0o600)
            self.command([str(PG / 'initdb'), '-D', str(self.root / 'data'), '-U', 'fixture_admin',
                          '--auth-local=reject', '--auth-host=scram-sha-256',
                          '--pwfile=' + str(password_file), '--no-locale', '--encoding=UTF8'])
            password_file.unlink()
            for name in ('server', 'untrusted'):
                self.command([OPENSSL, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                              '-subj', '/CN=fixture.hostler.invalid', '-addext',
                              'subjectAltName=DNS:fixture.hostler.invalid', '-keyout',
                              str(self.root / (name + '.key')), '-out', str(self.root / (name + '.crt'))])
                (self.root / (name + '.key')).chmod(0o600)
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                self.port = reservation.getsockname()[1]
            data = self.root / 'data'
            (data / 'pg_hba.conf').write_text('local all all reject\nhostnossl all all 127.0.0.1/32 reject\nhostssl all all 127.0.0.1/32 scram-sha-256\n')
            with (data / 'postgresql.conf').open('a') as configuration:
                configuration.write("\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n"
                                    f"port = {self.port}\nssl = on\nssl_cert_file = '{self.root}/server.crt'\n"
                                    f"ssl_key_file = '{self.root}/server.key'\n")
            self.log = (self.root / 'server.log').open('wb')
            self.server = subprocess.Popen([str(PG / 'postgres'), '-D', str(data)],
                                           env=self.environment, cwd=self.root,
                                           stdout=self.log, stderr=self.log)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if self.server.poll() is not None:
                    raise RuntimeError('Owned fixture server failed to start (possibly sandbox loopback denial)')
                try:
                    self.admin('SELECT 1')
                    break
                except RuntimeError:
                    time.sleep(.05)
            else:
                raise RuntimeError('Owned fixture readiness timeout')
            # Provisioning identity receipt from this newly created synthetic cluster.
            # ACL baselines below are declared stock expectations, never read/learned.
            self.system_identifier = self.admin('SELECT system_identifier FROM pg_control_system()').strip()
            self.admin("CREATE ROLE fixture_owner NOLOGIN; CREATE ROLE fixture_observer LOGIN "
                       "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + self.password + "';")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def command(self, argv, sql=None):
        environment = self.environment
        if argv[0] == str(PG / 'psql'):
            environment = environment | {'PGPASSWORD': self.password}
        result = subprocess.run(argv, input=sql, text=True, capture_output=True,
                                env=environment, cwd=self.root, timeout=15)
        if result.returncode:
            if 'could not create shared memory segment: Operation not permitted' in result.stderr:
                raise RuntimeError('Sandbox denied PostgreSQL shared memory (shmget); real SQL gate did not run')
            raise RuntimeError('Owned fixture command failed (details intentionally not emitted)')
        return result.stdout

    def admin_args(self, database='postgres'):
        params = dict(host='fixture.hostler.invalid', hostaddr='127.0.0.1', port=str(self.port),
                      dbname=database, user='fixture_admin', sslmode='verify-full',
                      sslrootcert=str(self.root / 'server.crt'), connect_timeout='1')
        return [str(PG / 'psql'), '-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1', '-d',
                ' '.join(key + '=' + connector._quote(value) for key, value in params.items())]

    def admin(self, sql, database='postgres'):
        if self.server is None or self.server.poll() is not None:
            raise RuntimeError('Refuse connection without live owned fixture process')
        return self.command(self.admin_args(database), sql)

    def wait_for_no_observers(self):
        deadline = time.monotonic() + 3
        while self.admin("SELECT count(*) FROM pg_stat_activity WHERE datname='fixture_database'").strip() != '0':
            if time.monotonic() >= deadline:
                raise RuntimeError('Owned fixture clients did not exit')
            time.sleep(.05)

    def reload_authentication(self):
        loaded = self.admin('SELECT pg_conf_load_time()').strip()
        self.admin('SELECT pg_reload_conf()')
        deadline = time.monotonic() + 3
        while self.admin('SELECT pg_conf_load_time()').strip() == loaded:
            if time.monotonic() >= deadline:
                raise RuntimeError('Owned fixture authentication reload did not complete')
            time.sleep(.05)

    def fresh_database(self):
        self.wait_for_no_observers()
        self.admin('DROP DATABASE IF EXISTS fixture_database;')
        self.admin('CREATE DATABASE fixture_database OWNER fixture_owner TEMPLATE template0;')
        self.admin('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC; '
                   'REVOKE SELECT (oid) ON pg_catalog.pg_subscription FROM PUBLIC; '
                   'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fixture_observer; '
                   'GRANT SELECT (oid) ON pg_catalog.pg_subscription TO fixture_observer;', 'fixture_database')
        oid = int(self.admin("SELECT oid FROM pg_database WHERE datname='fixture_database'"))
        return connector.Binding(Target('owned-synthetic-install', self.system_identifier, oid,
                                        'fixture_database', 'fixture_owner', 'fixture_observer',
                                        '127.0.0.1', self.port), 'fixture.hostler.invalid',
                                 str(self.root / 'server.crt'),
                                 connector.Baseline('pg_database_owner',
                                     '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}', None),
                                 self.password)

    def __exit__(self, *ignored):
        try:
            if self.server is not None:
                if self.server.poll() is None:
                    # SIGINT is PostgreSQL fast shutdown, only this exact owned PID.
                    self.server.send_signal(2)
                try:
                    self.server.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.server.kill()
                    self.server.wait(timeout=3)
        finally:
            if self.log is not None:
                self.log.close()
            # Keep the owned fixture intact if shutdown cannot be confirmed.
            if self.server is None or self.server.poll() == 0:
                shutil.rmtree(self.root)
            else:
                raise RuntimeError('Fixture shutdown was not clean; owned directory retained')


class PostgreSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cluster = DisposableCluster().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.cluster.__exit__(None, None, None)

    def setUp(self):
        self.binding = self.cluster.fresh_database()

    def check(self, expected, binding=None):
        result = connector.inspect(binding or self.binding)
        self.assertEqual(result.observation.classification, expected)
        self.assertEqual(result.exit_code, 1)
        self.assertFalse(result.migration_authorized or result.runtime_authorized or
                         result.observation.migration_authorized or result.observation.runtime_authorized)
        return result

    def sql(self, sql):
        return self.cluster.admin(sql, 'fixture_database')

    def test_authenticated_empty_and_no_superuser_or_secret_catalog_grant(self):
        self.assertEqual(self.sql("SELECT rolsuper FROM pg_roles WHERE rolname='fixture_observer'").strip(), 'f')
        self.assertEqual(self.sql("SELECT has_table_privilege('fixture_observer','pg_subscription','SELECT')").strip(), 'f')
        self.assertEqual(self.sql("SELECT has_column_privilege('fixture_observer','pg_subscription','subconninfo','SELECT')").strip(), 'f')
        self.check('NEW_EMPTY_CANDIDATE')
        self.cluster.wait_for_no_observers()

    def test_tls_and_password_failures(self):
        for binding in (replace(self.binding, ca_file=str(self.cluster.root / 'untrusted.crt')),
                        replace(self.binding, tls_hostname='wrong.hostler.invalid'),
                        replace(self.binding, password='incorrect-throwaway-password')):
            with self.subTest():
                self.check('REFUSE_UNKNOWN', binding)
        malformed = self.cluster.root / 'malformed-ca'
        malformed.write_text('not a certificate')
        self.check('REFUSE_UNKNOWN', replace(self.binding, ca_file=str(malformed)))

    def test_authentication_downgrade_refuses(self):
        hba = self.cluster.root / 'data' / 'pg_hba.conf'
        original = hba.read_text()
        try:
            hba.write_text(original.replace('scram-sha-256', 'trust'))
            self.cluster.reload_authentication()
            # Independently prove the server now accepts a wrong password, so
            # refusal below exercises the connector's required SCRAM binding.
            environment = self.cluster.environment | {'PGPASSWORD': 'wrong-throwaway-password'}
            accepted = subprocess.run(self.cluster.admin_args(), input='SELECT 1',
                                      text=True, capture_output=True, env=environment,
                                      cwd=self.cluster.root, timeout=3)
            self.assertEqual(accepted.returncode, 0)
            self.check('REFUSE_UNKNOWN')
        finally:
            hba.write_text(original)
            self.cluster.reload_authentication()

    def test_superuser_observer_refuses(self):
        self.check('REFUSE_UNKNOWN', replace(self.binding, target=replace(
            self.binding.target, observer_role='fixture_admin')))

    def test_external_identity(self):
        for field, value in dict(system_identifier='1', database_oid=1,
                                 database_owner='wrong_owner', installation_id='').items():
            with self.subTest(field=field):
                self.check('REFUSE_UNKNOWN' if field == 'installation_id' else 'REFUSE_IDENTITY',
                           replace(self.binding, target=replace(self.binding.target, **{field: value})))
        self.check('REFUSE_UNKNOWN', replace(self.binding, target=replace(self.binding.target, database_name='absent_db')))
        self.cluster.admin('GRANT EXECUTE ON FUNCTION pg_control_system() TO fixture_observer; '
                           'GRANT SELECT (oid) ON pg_subscription TO fixture_observer;')
        self.check('REFUSE_IDENTITY', replace(self.binding, target=replace(self.binding.target, database_name='postgres')))
        self.check('REFUSE_UNKNOWN', replace(self.binding, target=replace(self.binding.target, observer_role='absent_role')))
        with socket.socket() as owned_unlistening_endpoint:
            owned_unlistening_endpoint.bind(('127.0.0.1', 0))
            self.check('REFUSE_UNKNOWN', replace(self.binding, target=replace(
                self.binding.target, server_port=owned_unlistening_endpoint.getsockname()[1])))

    def test_permissions_and_query_error_then_partial_then_empty(self):
        for sql in ('REVOKE EXECUTE ON FUNCTION pg_control_system() FROM fixture_observer',
                    'REVOKE SELECT (oid) ON pg_subscription FROM fixture_observer',
                    'REVOKE SELECT ON pg_class FROM PUBLIC',
                    'REVOKE USAGE ON SCHEMA public FROM PUBLIC',
                    'REVOKE SELECT ON pg_cast FROM PUBLIC'):
            with self.subTest(sql=sql):
                self.sql(sql)
                self.check('REFUSE_UNKNOWN')
                self.binding = self.cluster.fresh_database()
        self.sql('REVOKE EXECUTE ON FUNCTION pg_control_system() FROM fixture_observer')
        self.check('REFUSE_UNKNOWN')
        self.sql('GRANT EXECUTE ON FUNCTION pg_control_system() TO fixture_observer; CREATE TABLE partial_migration(id int)')
        self.check('REFUSE_EXISTING')
        self.sql('DROP TABLE partial_migration')
        self.check('NEW_EMPTY_CANDIDATE')

    def test_hidden_rls_migration_and_partial_structures(self):
        for sql in ('CREATE TABLE hidden(id int); REVOKE ALL ON hidden FROM PUBLIC',
                    'CREATE TABLE protected(id int); ALTER TABLE protected ENABLE ROW LEVEL SECURITY; '
                    'ALTER TABLE protected FORCE ROW LEVEL SECURITY; INSERT INTO protected VALUES(1)',
                    'CREATE SCHEMA private; REVOKE ALL ON SCHEMA private FROM PUBLIC; CREATE TABLE private.hidden(id int)',
                    'CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id int)',
                    'CREATE TABLE installation_marker(complete bool); INSERT INTO installation_marker VALUES(true)',
                    'CREATE TYPE partial_state AS ENUM (\'partial\')'):
            with self.subTest(sql=sql):
                self.sql(sql)
                self.check('REFUSE_EXISTING')
                self.binding = self.cluster.fresh_database()

    def test_external_acl_ownership_and_metadata(self):
        for sql in ('GRANT CREATE ON SCHEMA public TO fixture_observer',
                    'ALTER SCHEMA public OWNER TO fixture_owner',
                    'GRANT CREATE ON DATABASE fixture_database TO fixture_observer',
                    'REVOKE TEMPORARY ON DATABASE fixture_database FROM PUBLIC'):
            with self.subTest(sql=sql):
                self.sql(sql)
                self.check('REFUSE_UNKNOWN')
                self.binding = self.cluster.fresh_database()
        for sql in ('CREATE COLLATION public.extra (provider = builtin, locale = \'C\')',
                    'CREATE FOREIGN DATA WRAPPER extra',
                    'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO fixture_observer',
                    'ALTER DATABASE fixture_database SET work_mem = \'8MB\''):
            with self.subTest(sql=sql):
                self.sql(sql)
                self.check('REFUSE_EXISTING')
                self.binding = self.cluster.fresh_database()

    def test_inherited_environment_cannot_redirect(self):
        poison = {'PGHOST': '/not-a-socket', 'PGPORT': '1', 'PGDATABASE': 'wrong',
                  'PGUSER': 'wrong', 'PGPASSWORD': 'wrong', 'PGSSLMODE': 'disable',
                  'PGOPTIONS': '-c search_path=public', 'PGSERVICE': 'wrong',
                  'PGSERVICEFILE': '/not-a-file', 'PGPASSFILE': '/not-a-file',
                  'PSQLRC': '/not-a-file', 'HOME': '/not-a-directory',
                  'DYLD_INSERT_LIBRARIES': '/not-a-library'}
        with patch.dict(os.environ, poison):
            self.check('NEW_EMPTY_CANDIDATE')

    def test_real_query_timeout_and_fresh_recovery(self):
        args = self.cluster.admin_args('fixture_database')
        relation_oid = int(self.sql("SELECT 'pg_subscription'::regclass::oid"))
        backend_pid = None
        with tempfile.TemporaryFile() as output:
            lock = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL,
                                    env=self.cluster.environment | {'PGPASSWORD': self.cluster.password},
                                    cwd=self.cluster.root)
            try:
                lock.stdin.write(b'SELECT pg_backend_pid(); BEGIN; LOCK TABLE pg_catalog.pg_subscription IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(12);\n')
                lock.stdin.close()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    output.seek(0)
                    line = output.readline().strip()
                    if line.isdigit():
                        backend_pid = int(line)
                    if backend_pid is not None and self.sql(
                        f"SELECT count(*) FROM pg_locks WHERE pid={backend_pid} AND relation={relation_oid} "
                        "AND mode='AccessExclusiveLock' AND granted").strip() == '1':
                        break
                    time.sleep(.05)
                else:
                    self.fail('Owned fixture lock did not become ready')
                started = time.monotonic()
                self.check('REFUSE_UNKNOWN')
                self.assertLess(time.monotonic() - started, 7)
            finally:
                lock.kill()
                lock.wait(timeout=3)
                if backend_pid is not None:
                    # Exact PID received from our exclusively owned fixture client.
                    self.sql(f'SELECT pg_terminate_backend({backend_pid}, 3000)')
        self.sql('CREATE TABLE partial_migration(id int)')
        self.check('REFUSE_EXISTING')
        self.sql('DROP TABLE partial_migration')
        self.check('NEW_EMPTY_CANDIDATE')

    def test_cancellation_and_wall_timeout_reap_real_owned_client(self):
        original = subprocess.Popen
        for failure in (KeyboardInterrupt(), subprocess.TimeoutExpired('sanitized', 5)):
            owned = []

            def launch(*args, **kwargs):
                process = original(*args, **kwargs)
                owned.append(process)
                process.communicate = lambda *a, **k: (_ for _ in ()).throw(failure)
                return process

            with patch.object(connector.subprocess, 'Popen', side_effect=launch):
                if isinstance(failure, KeyboardInterrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        connector.inspect(self.binding)
                else:
                    self.check('REFUSE_UNKNOWN')
            self.assertEqual(len(owned), 1)
            self.assertIsNotNone(owned[0].poll())
            self.assertEqual(owned[0].wait(timeout=.1), owned[0].returncode)
            self.assertTrue(owned[0].stdin.closed)
        self.check('NEW_EMPTY_CANDIDATE')


if __name__ == '__main__':
    unittest.main(verbosity=2)
