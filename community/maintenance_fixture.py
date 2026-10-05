"""New initdb-owned synthetic clusters only. No loader, CLI, retry or reentry."""

import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time

from migration_state import (ContractError, SECTIONS, bootstrap_state, canonical,
                             decode, descriptor, digest, ledger_prefix, manifest_bytes, regular, compare)

PG = Path('/opt/homebrew/opt/postgresql@18/bin')
NODE = Path('/opt/homebrew/opt/node@24/bin/node')
SOURCE = Path(__file__).resolve().parent
PRIMARY = Path('/Users/masonjames/Projects/dokploy')
HBA = '''local postgres hostler_admin peer map=hostler_fixture
local hostler_fixture hostler_migrator peer map=hostler_fixture
local hostler_fixture hostler_observer peer map=hostler_fixture
local all all reject
host all all 0.0.0.0/0 reject
host all all ::0/0 reject
'''
SETTINGS = {'listen_addresses': '', 'unix_socket_permissions': '0700',
            'max_prepared_transactions': '0', 'shared_preload_libraries': '',
            'session_preload_libraries': '', 'local_preload_libraries': '',
            'max_logical_replication_workers': '0', 'max_wal_senders': '0',
            'max_worker_processes': '0', 'max_parallel_workers': '0',
            'archive_mode': 'off', 'archive_command': '', 'archive_library': '',
            'allow_alter_system': 'off'}
# REL_18_6 guc_tables.c / guc_funcs.c: exactly these requested settings are
# GUC_SUPERUSER_ONLY and absent without pg_read_all_settings membership.
SESSION_HIDDEN_SETTINGS = frozenset({'session_preload_libraries',
                                     'shared_preload_libraries', 'unix_socket_directories'})
_OWNED = {}


class FixtureError(RuntimeError):
    pass


def node_startup_smoke():
    """Offline fixed installed Node24 preflight; imports only the inert env check."""
    with tempfile.TemporaryDirectory(prefix='hostler-node-smoke-', dir='/private/tmp') as home:
        launcher = ("import {checkFixtureChildEnvironment} from "
                    + json.dumps((SOURCE / 'migrate_owned.mjs').as_uri())
                    + "; if (process.versions.node.split('.')[0] !== '24') process.exit(1);"
                    + " checkFixtureChildEnvironment(process.env, process.platform, "
                    + json.dumps(home) + "); process.stdout.write('node-startup-ok\\n');")
        try:
            result = subprocess.run([str(NODE), '--input-type=module', '-e', launcher],
                                    env={'HOME': home, 'LC_ALL': 'C'}, cwd=home,
                                    capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            raise FixtureError('offline Node24 startup smoke failed') from None
        if result.returncode or result.stdout != 'node-startup-ok\n' or result.stderr:
            raise FixtureError('offline Node24 startup smoke failed')


def verify_settings(rows, settings, root):
    if settings['archive_mode'] != 'off' or settings['archive_command'] != '':
        raise FixtureError('fixed archive configuration drift')
    # PG18 show_archive_command renders inactive archiving, not the configured bytes.
    # REL_18_6: xlog.c show_archive_command; xlog.h XLogArchivingActive.
    displayed = settings | {'archive_command': '(disabled)'}
    names = set(settings) | {'max_connections', 'max_locks_per_transaction'}
    if len(rows) != len(names) or {row['name'] for row in rows} != names:
        raise FixtureError('missing setting')
    for row in rows:
        if row['name'] in settings:
            if (row['setting'] != displayed[row['name']] or row['source'] != 'configuration file'
                    or row['sourcefile'] != str(root / 'data/postgresql.conf') or row['pending']):
                raise FixtureError('effective setting drift: ' + row['name'])
        elif row['setting'] != row['boot'] or row['source'] != 'default' or row['pending']:
            raise FixtureError('nonrepresentative capacity')


def verify_session_settings(effective, admin_rows):
    # The caller validates the full administrator rows before projecting them.
    expected = {row['name']: row['setting'] for row in admin_rows
                if row['name'] not in SESSION_HIDDEN_SETTINGS}
    if (not isinstance(effective, dict) or any(value is None for value in effective.values())
            or effective != expected):
        raise FixtureError('session setting override or visibility drift')


def verify_owned(fixture):
    root = fixture.root
    if (_OWNED.get(id(fixture)) != (root, fixture.identity) or root.is_symlink()
            or root.parent != Path('/private/tmp') or not re.fullmatch(r'hw-[a-z0-9_]+', root.name)):
        raise FixtureError('foreign fixture handle/root')
    stat = root.stat()
    if (stat.st_dev, stat.st_ino) != fixture.identity or stat.st_uid != os.getuid() or stat.st_mode & 0o777 != 0o700:
        raise FixtureError('fixture root identity/mode')
    if fixture.provision is not None and regular(root / 'provision.json') != fixture.provision:
        raise FixtureError('provision record drift')


def cleanup(fixture):
    verify_owned(fixture)
    if fixture.server is not None and fixture.server.poll() != 0:
        raise FixtureError('cleanup refused: server exit not confirmed clean; retained ' + str(fixture.root))
    if fixture.children:
        raise FixtureError('cleanup refused: unconfirmed child exit')
    if not fixture.success:
        return  # Failed or uncertain execution retains all evidence, even after clean shutdown.
    shutil.rmtree(fixture.root)
    del _OWNED[id(fixture)]


class OwnedFixture:
    def __init__(self):
        self.root = None
        self.server = None
        self.children = set()
        self.provision = None
        self.success = False
        self.log = None

    def __enter__(self):
        self.root = Path(tempfile.mkdtemp(prefix='hw-', dir='/private/tmp'))
        stat = self.root.stat()
        self.identity = (stat.st_dev, stat.st_ino)
        _OWNED[id(self)] = (self.root, self.identity)
        self.env = {'HOME': str(self.root), 'LC_ALL': 'C', 'PATH': '/usr/bin:/bin',
                    'PGPASSFILE': '/dev/null', 'PGSYSCONFDIR': str(self.root)}
        try:
            self._provision()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def command(self, argv, sql=None, timeout=30):
        verify_owned(self)
        if argv[0] not in {str(PG / name) for name in ['initdb', 'postgres', 'psql']} | {'/usr/sbin/lsof'}:
            raise FixtureError('executable outside fixed fixture tools')
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, env=self.env, cwd=self.root)
        self.children.add(child)
        return self._communicate(child, {'argv': argv, 'stdin_sha256':
                                 digest(sql.encode()) if sql is not None else None}, sql, timeout)

    def _communicate(self, child, purpose, sql=None, timeout=180):
        """Private bounded evidence only; unknown exit stays tracked and refuses cleanup."""
        out, err, failure, drain_failure = b'', b'', None, None
        try:
            out, err = child.communicate(sql, timeout=timeout)
            return child.returncode, out, err
        except BaseException as error:
            failure = type(error).__name__
            out, err = getattr(error, 'output', b''), getattr(error, 'stderr', b'')
            try:
                if child.poll() is None:
                    child.kill()
                out, err = child.communicate(timeout=5)
            except BaseException as drain_error:
                drain_failure = type(drain_error).__name__
                out = getattr(drain_error, 'output', None) or out
                err = getattr(drain_error, 'stderr', None) or err
            raise
        finally:
            exit_code = child.poll()
            if exit_code is not None:
                self.children.discard(child)
            def bounded(value):
                data = value.encode('utf-8', errors='replace') if isinstance(value, str) else (value or b'')
                return {'bytes': len(data), 'truncated': len(data) > 32768,
                        'head': data[:16384].decode('utf-8', errors='replace'),
                        'tail': data[16384:].decode('utf-8', errors='replace') if len(data) <= 32768
                        else data[-16384:].decode('utf-8', errors='replace')}
            record = {'purpose': purpose, 'pid': child.pid, 'exit': exit_code,
                      'exception': failure, 'drain_exception': drain_failure,
                      'stdout': bounded(out), 'stderr': bounded(err)}
            # mkstemp supplies exclusive creation and 0600 inside the verified 0700 root.
            fd, _ = tempfile.mkstemp(prefix='child-', suffix='.json', dir=self.root)
            with os.fdopen(fd, 'w') as output:
                output.write(canonical(record) + '\n')

    def sql(self, sql, role='hostler_migrator', expect_error=False):
        verify_owned(self)
        if role not in ('hostler_migrator', 'hostler_observer', 'hostler_admin', 'hostler_wrong'):
            raise FixtureError('role outside fixture')
        if self.server is None or self.server.poll() is not None:
            raise FixtureError('no live owned postmaster')
        database = 'postgres' if role == 'hostler_admin' else 'hostler_fixture'
        args = [str(PG / 'psql'), '-X', '-qAtw', '-v', 'ON_ERROR_STOP=1',
                '-v', 'VERBOSITY=verbose', '-h', str(self.root / 's'), '-p', '5432',
                '-U', role, '-d', database]
        rc, out, err = self.command(args, sql, timeout=120)
        if expect_error:
            if rc == 0:
                raise FixtureError('negative control unexpectedly succeeded')
            return err
        if rc:
            states = re.findall(r'(?:ERROR|FATAL):\s+([0-9A-Z]{5}):', err)
            raise FixtureError('psql failed SQLSTATE=' + ','.join(states))
        return out.strip()

    def read(self, query):
        result = self.sql('BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; '
                          'SET LOCAL statement_timeout=10000; SELECT to_json(q.value) FROM (' + query + ') q(value); ROLLBACK;',
                          'hostler_observer')
        return decode(result)

    def _provision(self):
        account = pwd.getpwuid(os.getuid()).pw_name
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*', account):
            raise FixtureError('unsupported peer account spelling')
        rc, version, _ = self.command([str(PG / 'postgres'), '--version'])
        if rc or not re.search(r'\b18\.', version):
            raise FixtureError('requires installed PG18')
        self.initdb_argv = [str(PG / 'initdb'), '-D', str(self.root / 'data'),
                           '-U', 'hostler_admin', '--auth-local=reject', '--auth-host=reject',
                           '--no-locale', '--encoding=UTF8']
        rc, out, err = self.command(self.initdb_argv)
        (self.root / 'initdb.log').write_text(out + err)
        if rc:
            raise FixtureError('initdb failed; retained ' + str(self.root))
        (self.root / 's').mkdir(mode=0o700)
        self.settings = SETTINGS | {'unix_socket_directories': str(self.root / 's')}
        if len(str(self.root / 's/.s.PGSQL.5432').encode()) >= 104:
            raise FixtureError('socket path too long')
        config = ''.join(f"{key} = '{value}'\n" for key, value in self.settings.items())
        ident = ''.join(f'hostler_fixture {account} {role}\n' for role in
                        ('hostler_admin', 'hostler_migrator', 'hostler_observer'))
        self.fixed = {'postgresql.conf': config.encode(), 'pg_hba.conf': HBA.encode(),
                      'pg_ident.conf': ident.encode(), 'postgresql.auto.conf': b''}
        for name, data in self.fixed.items():
            (self.root / 'data' / name).write_bytes(data)
        self.log = (self.root / 'server.log').open('wb')
        self.server = subprocess.Popen([str(PG / 'postgres'), '-D', str(self.root / 'data')],
                                      env=self.env, cwd=self.root, stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                self.sql('SELECT 1', 'hostler_admin')
                break
            except FixtureError:
                if self.server.poll() is not None:
                    raise FixtureError('postmaster startup failed')
                time.sleep(.05)
        else:
            raise FixtureError('postmaster readiness timeout')
        self.sql('CREATE ROLE hostler_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
                 'NOREPLICATION NOBYPASSRLS; CREATE ROLE hostler_observer LOGIN NOSUPERUSER '
                 'NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;', 'hostler_admin')
        self.sql('CREATE DATABASE hostler_fixture OWNER hostler_migrator TEMPLATE template0;', 'hostler_admin')
        self.sql('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO hostler_observer; '
                 'ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO hostler_observer;')
        identity = decode(self.sql("SELECT json_build_object('system',system_identifier::text,"
                                  "'start',pg_postmaster_start_time()::text) FROM pg_control_system()", 'hostler_admin'))
        record = dict(root=str(self.root), dev=self.identity[0], ino=self.identity[1],
                      parent=os.getpid(), initdb='completed', initdb_argv=self.initdb_argv,
                      socket=str(self.root / 's'), database='hostler_fixture', identity=identity,
                      postgres_version=version.strip(), postgres_realpath=str((PG / 'postgres').resolve()),
                      config_hashes={key: digest(value) for key, value in self.fixed.items()})
        record['directories'] = {name: [self.root.joinpath(name).stat().st_dev, self.root.joinpath(name).stat().st_ino]
                                 for name in ['data', 's']}
        self.provision = (canonical(record) + '\n').encode()
        (self.root / 'provision.json').write_bytes(self.provision)
        self.verify()

    def verify(self):
        verify_owned(self)
        for name, expected in self.fixed.items():
            if regular(self.root / 'data' / name) != expected:
                raise FixtureError('fixed configuration drift')
        record = decode(self.provision)
        for name, identity in record['directories'].items():
            directory = self.root / name
            if directory.is_symlink() or [directory.stat().st_dev, directory.stat().st_ino] != identity:
                raise FixtureError('owned subdirectory drift')
        identity = decode(self.sql("SELECT json_build_object('system',system_identifier::text,"
                                   "'start',pg_postmaster_start_time()::text) FROM pg_control_system()", 'hostler_admin'))
        if identity != record['identity']:
            raise FixtureError('running postmaster identity drift')
        if self.sql('SHOW data_directory', 'hostler_admin') != str(self.root / 'data'):
            raise FixtureError('postmaster data directory drift')
        if self.sql('SELECT count(*) FROM pg_prepared_xacts', 'hostler_admin') != '0':
            raise FixtureError('prepared transaction drift')
        keys = list(self.settings) + ['max_connections', 'max_locks_per_transaction']
        quoted = ','.join("'" + key + "'" for key in keys)
        rows = decode(self.sql('SELECT json_agg(json_build_object(\'name\',name,\'setting\',setting,'
                              "'source',source,'sourcefile',sourcefile,'pending',pending_restart,'boot',boot_val)) "
                              'FROM pg_settings WHERE name IN (' + quoted + ')', 'hostler_admin'))
        verify_settings(rows, self.settings, self.root)
        files = decode(self.sql("SELECT COALESCE(json_agg(json_build_array(sourcefile,name,applied,error)), '[]') FROM pg_file_settings", 'hostler_admin'))
        if len(files) != len(self.settings) or any(row[0] != str(self.root / 'data/postgresql.conf') or not row[2] or row[3] for row in files):
            raise FixtureError('file settings/include drift')
        if self.sql('SELECT count(*) FROM pg_db_role_setting', 'hostler_admin') != '0':
            raise FixtureError('role/database setting override')
        # POSTMASTER values cannot change in-session; SUSET session preload needs
        # parameter SET privilege. Refuse all parameter ACL rows before any
        # non-superuser verification query, not just before migration dispatch.
        if self.sql('SELECT count(*) FROM pg_parameter_acl', 'hostler_admin') != '0':
            raise FixtureError('parameter ACL override')
        roles = self.read("SELECT json_agg(json_build_array(rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'hostler_%'")
        expected = [[name, name == 'hostler_admin', name == 'hostler_admin', name == 'hostler_admin',
                     name == 'hostler_admin', name == 'hostler_admin', True]
                    for name in ['hostler_admin', 'hostler_migrator', 'hostler_observer']]
        if roles != expected:
            raise FixtureError('role attributes drift')
        if self.read('SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname LIKE \'hostler_%\')') != 0:
            raise FixtureError('role membership drift')
        if self.read("SELECT pg_get_userbyid(datdba)::text='hostler_migrator' FROM pg_database WHERE datname=current_database()") is not True:
            raise FixtureError('database owner drift')
        # Exact visibility projection; hidden values remain checked by admin.
        sessions = {}
        for role in ['hostler_migrator', 'hostler_observer']:
            effective = decode(self.sql('SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN (' + quoted + ')', role))
            verify_session_settings(effective, rows)
            sessions[role] = effective
        (self.root / 'settings.json').write_text(canonical(rows) + '\n')
        (self.root / 'session-settings.json').write_text(canonical({
            'hidden_requested_settings': sorted(SESSION_HIDDEN_SETTINGS),
            'parameter_acl_rows': 0, 'sessions': sessions}) + '\n')
        if self.read("SELECT to_regclass('public.migrations') IS NOT NULL"):
            raise FixtureError('public.migrations refused')

    def snapshot(self, manifest, oracle_bytes):
        verify_owned(self)
        validated = manifest_bytes(manifest['journal'], manifest['files'])
        if validated['entries'] != manifest['entries']:
            raise FixtureError('manifest hash/order drift')
        manifest = validated
        folder = self.root / 'migrations'
        folder.mkdir(mode=0o700)
        (folder / 'meta').mkdir()
        (folder / 'meta/_journal.json').write_bytes(manifest['journal'])
        for name, data in manifest['files'].items():
            (folder / name).write_bytes(data)
        self.manifest = manifest
        self.oracle_bytes = oracle_bytes
        record = {'provision': digest(self.provision), 'oracle': digest(oracle_bytes),
                  'journal': digest(manifest['journal']),
                  'files': {name: digest(data) for name, data in manifest['files'].items()},
                  'source': {name: digest(regular(SOURCE / name)) for name in
                             ['maintenance_fixture.py', 'migrate_owned.mjs', 'migration_state.py',
                              'writer_catalog.sql', 'pg18_writer_fixture_tests.py']}}
        (self.root / 'dispatch.json').write_text(canonical(record) + '\n')
        (self.root / 'oracle.json').write_bytes(oracle_bytes)

    def ledger(self):
        if not self.read("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL"):
            return []
        return self.read("SELECT COALESCE(json_agg(json_build_object('hash',hash,'created_at',created_at) ORDER BY created_at),'[]') FROM drizzle.__drizzle_migrations")

    def state(self):
        schema = self.read("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='drizzle')")
        objects = self.read("SELECT COALESCE(json_agg(json_build_array(c.relname,c.relkind) ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='drizzle'")
        state = bootstrap_state(schema, objects, self.ledger())
        if state != 'ledger-present':
            expected = decode(regular(SOURCE / 'writer_fixture/oracle.json'))
            expected['rows'] = []
            for key in ['relations', 'columns', 'constraints', 'indexes', 'enums', 'sequences']:
                expected[key] = [row for row in expected[key] if row[0] == 'drizzle'
                                 and state == 'schema-empty-table-sequence-pk']
            expected['schemas'] = [['public']] + ([['drizzle']] if schema else [])
            expected['owners'] = [row for row in expected['owners'] if row[1] == 'public'
                                  or (schema and row[0] == 'schema' and row[1] == 'drizzle')
                                  or (state == 'schema-empty-table-sequence-pk' and row[1].startswith('drizzle.'))]
            expected['grants'] = [row for row in expected['grants'] if row[1] == 'public'
                                  or (schema and row[1] == 'drizzle')
                                  or (state == 'schema-empty-table-sequence-pk' and row[1].startswith('drizzle.'))]
            compare(expected, self.catalog())
        return state

    def catalog(self, small=False):
        result = self.read(regular(SOURCE / 'writer_catalog.sql').decode().rstrip().removesuffix(';'))
        value = {'version': 1, **{key: [] for key in SECTIONS}, **result}
        if small:
            value['rows'] = self.read('SELECT json_agg(json_build_array(id,label,state,generation) ORDER BY id) FROM public.fixture_item')
        return descriptor(value)

    def drizzle(self):
        self.verify()
        if self.state() != 'none' or ledger_prefix(self.manifest['entries'], self.ledger()) != 0:
            raise FixtureError('fresh fixture required; bootstrap never retried')
        for relative in ['apps/dokploy/package.json', 'pnpm-lock.yaml']:
            if regular(SOURCE.parent / relative) != regular(PRIMARY / relative):
                raise FixtureError('installed dependency source disagreement')
        lock = regular(SOURCE.parent / 'pnpm-lock.yaml').decode()
        integrity = {}
        for package in ['drizzle-orm@0.45.2', 'postgres@3.4.4']:
            match = re.search(r'^  ' + re.escape(package) + r':\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}', lock, re.M)
            if not match:
                raise FixtureError('lock integrity expectation missing')
            integrity[package] = match[1]
        parent, child_socket = socket.socketpair()
        # FD number is passed as a dedicated inherited descriptor, never an endpoint argument.
        child_fd = child_socket.fileno()
        launcher = ("import {runFixtureChild} from " + json.dumps((SOURCE / 'migrate_owned.mjs').as_uri())
                    + "; await runFixtureChild(" + str(child_fd) + ");")
        child = None
        captured = False
        try:
            child = subprocess.Popen([str(NODE), '--input-type=module', '-e', launcher],
                                     pass_fds=(child_fd,), env={'HOME': str(self.root), 'LC_ALL': 'C'},
                                     cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True)
            self.children.add(child)
            child_socket.close()
            parent.sendall((canonical({'root': str(self.root), 'provisionHash': digest(self.provision),
                                      'journalHash': digest(self.manifest['journal']),
                                      'hashes': {name: digest(data) for name, data in self.manifest['files'].items()}}) + '\n').encode())
            captured = True
            rc, out, err = self._communicate(child, {'operation': 'installed-drizzle-journal',
                                                       'journal_sha256': digest(self.manifest['journal'])})
            if rc:
                raise FixtureError('internal executor failure; retained ' + str(self.root))
            result = decode(out)
            result['lock_integrity_expectations'] = integrity
            result['registry_integrity_verified'] = False
            (self.root / 'executor.json').write_text(canonical(result) + '\n')
            self.verify()
            return result
        finally:
            try:
                if child is not None and not captured:
                    # Includes interrupted/failed control handoff before communicate began.
                    self._communicate(child, {'operation': 'interrupted-drizzle-handoff'}, timeout=0)
            finally:
                parent.close()
                child_socket.close()

    def __exit__(self, *ignored):
        verify_owned(self)
        if self.server is not None:
            if self.server.poll() is None:
                self.server.send_signal(signal.SIGINT)
            try:
                self.server.wait(timeout=15)
            except subprocess.TimeoutExpired as error:
                raise FixtureError('shutdown unknown; retained ' + str(self.root)) from error
        if self.log is not None:
            self.log.close()
        cleanup(self)
