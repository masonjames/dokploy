"""One fixed PG18 observation; external caller supplies trust, never admission."""

from dataclasses import dataclass, field
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import tempfile

from observe_entry import Exit
from state_observation import BEGIN, SET_PATH, OBSERVE, COLUMNS, Result, Target, interpret, require, validate_target
from state_policy import Decision

PSQL = '/opt/homebrew/opt/postgresql@18/bin/psql'


@dataclass(frozen=True)
class Baseline:
    """Reviewed provisioning values, NOT a baseline learned from this observation.

    ACLs are exact PostgreSQL aclitem[] text, or None for a NULL catalog ACL.
    NULL and an explicitly stored default ACL intentionally differ.
    """

    public_owner: str
    public_acl: str | None
    database_acl: str | None


@dataclass(frozen=True)
class Binding:
    """Caller attests the full installation association and provisioning baseline.

    The TLS CA/name authenticates a peer; neither it nor a caller-created Binding
    independently attests installation identity. No untrusted config-file loader.
    """

    target: Target
    tls_hostname: str
    ca_file: str
    baseline: Baseline
    password: str = field(repr=False)


# Fixed normal-object OID boundary is conservative for non-stock templates.
METADATA = ('pg_cast', 'pg_operator', 'pg_opclass', 'pg_opfamily', 'pg_collation',
            'pg_conversion', 'pg_ts_config', 'pg_ts_dict', 'pg_ts_parser',
            'pg_ts_template', 'pg_language', 'pg_am', 'pg_transform')
EXTRA_CATALOGS = METADATA + ('pg_foreign_data_wrapper', 'pg_seclabel',
                             'pg_shseclabel', 'pg_replication_slots')
_NAMES = ', '.join("'" + name + "'" for name in EXTRA_CATALOGS)
_COUNTS = ' + '.join('(SELECT pg_catalog.count(*) FROM pg_catalog.' + name +
                     (' WHERE oid >= 16384)' if name in METADATA else ')')
                     for name in EXTRA_CATALOGS)
SQL = BEGIN + ';\n' + SET_PATH + """;
SET LOCAL statement_timeout = '2s';
SELECT pg_catalog.json_build_object(
    'observation', pg_catalog.row_to_json(o),
    'version', pg_catalog.current_setting('server_version_num'),
    'in_recovery', pg_catalog.pg_is_in_recovery(),
    'is_superuser', pg_catalog.current_setting('is_superuser'),
    'public_owner', pg_catalog.pg_get_userbyid(n.nspowner),
    'public_acl', n.nspacl::pg_catalog.text,
    'database_acl', d.datacl::pg_catalog.text,
    'extra_access', (SELECT pg_catalog.count(*) = EXTRA_COUNT AND
        pg_catalog.bool_and(pg_catalog.has_table_privilege(c.oid, 'SELECT')
            AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'pg_catalog' AND c.relname IN (EXTRA_NAMES)),
    'extra_objects', EXTRA_OBJECTS)
FROM (
""" + OBSERVE + """
) o JOIN pg_catalog.pg_database d ON d.oid = o.database_oid
JOIN pg_catalog.pg_namespace n ON n.nspname = 'public';
ROLLBACK;
"""
SQL = SQL.replace('EXTRA_COUNT', str(len(EXTRA_CATALOGS))).replace('EXTRA_NAMES', _NAMES).replace('EXTRA_OBJECTS', _COUNTS)


def validate(binding: Binding) -> None:
    require(type(binding) is Binding)
    validate_target(binding.target)
    require('%' not in binding.target.server_address and
            str(ipaddress.ip_address(binding.target.server_address)) == binding.target.server_address)
    for value in (binding.target.database_name, binding.target.database_owner,
                  binding.target.observer_role, binding.baseline.public_owner if type(binding.baseline) is Baseline else ''):
        require(type(value) is str and re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', value) is not None)
    require(type(binding.tls_hostname) is str and len(binding.tls_hostname) <= 253 and
            all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
                for part in binding.tls_hostname.split('.')))
    require(type(binding.ca_file) is str and binding.ca_file.startswith('/') and
            '\x00' not in binding.ca_file and len(binding.ca_file) <= 4096)
    require(Path(binding.ca_file).is_file())
    require(type(binding.baseline) is Baseline)
    for value in (binding.baseline.public_acl, binding.baseline.database_acl):
        require(value is None or (type(value) is str and 0 < len(value) <= 16384 and '\x00' not in value))
    require(type(binding.password) is str and 0 < len(binding.password) <= 1024 and
            '\x00' not in binding.password)


def _quote(value: str) -> str:
    # libpq keyword-value escaping, not shell/SQL escaping. No shell is invoked.
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"


def _unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def decode(output: bytes, binding: Binding) -> Decision:
    require(len(output) <= 65536)
    lines = output.decode('utf-8', errors='strict').splitlines()
    require(len(lines) == 5 and lines[:3] == ['BEGIN', 'SET', 'SET'] and lines[-1] == 'ROLLBACK')
    envelope = json.loads(lines[3], object_pairs_hook=_unique)
    require(type(envelope) is dict and set(envelope) == {
        'observation', 'version', 'in_recovery', 'is_superuser', 'public_owner',
        'public_acl', 'database_acl', 'extra_access', 'extra_objects'})
    require(type(envelope['version']) is str and re.fullmatch(r'18[0-9]{4}', envelope['version']) is not None)
    require(envelope['in_recovery'] is False and envelope['is_superuser'] == 'off')
    require(envelope['extra_access'] is True)
    require(type(envelope['extra_objects']) is int and envelope['extra_objects'] >= 0)
    row = envelope['observation']
    require(type(row) is dict and tuple(row) == COLUMNS)
    decision = interpret(Result(COLUMNS, (tuple(row.values()),)), binding.target)
    baseline = binding.baseline
    require(envelope['public_owner'] == baseline.public_owner and
            envelope['public_acl'] == baseline.public_acl and envelope['database_acl'] == baseline.database_acl)
    if envelope['extra_objects']:
        return Decision('REFUSE_EXISTING', 'Additional catalog state; compatibility is unqualified')
    return decision


def inspect(binding: Binding, purpose: str = 'initial') -> Exit:
    """Fresh physical connection, confirmed rollback and reaped psql before result.

    Fixed 2s connect/statement limits, 5s wall limit, then kill/reap on failure or
    cancellation. A failed query closes/aborts its transaction, never a candidate.
    No SQL, DSN, executable, timeout, environment or process injection surface.
    """
    refused = Exit(Decision('REFUSE_UNKNOWN', 'Authenticated observation failed or was incomplete'))
    if type(purpose) is not str or purpose != 'initial':
        return Exit(Decision('REFUSE_EXISTING', 'Restart/upgrade admission is out of scope'))
    try:
        validate(binding)
        target = binding.target
        with tempfile.TemporaryDirectory(prefix='hostler-observe-') as home:
            parameters = dict(host=binding.tls_hostname, hostaddr=target.server_address,
                              port=str(target.server_port), dbname=target.database_name,
                              user=target.observer_role, sslmode='verify-full',
                              sslrootcert=binding.ca_file, sslcertmode='disable',
                              sslcert='', sslkey='', sslcrl='', sslcrldir='',
                              sslsni='1', gssencmode='disable', channel_binding='require',
                              client_encoding='UTF8',
                              require_auth='scram-sha-256', connect_timeout='2',
                              application_name='hostler-source-observation',
                              options='-c default_transaction_read_only=on -c search_path=pg_catalog '
                                      '-c statement_timeout=2000 -c lock_timeout=1000 '
                                      '-c idle_in_transaction_session_timeout=3000')
            connection = ' '.join(key + '=' + _quote(value) for key, value in parameters.items())
            # No inherited variables, home configs, passfiles, service selection or rc.
            environment = {'HOME': home, 'LC_ALL': 'C', 'PGPASSWORD': binding.password,
                           'PGPASSFILE': '/dev/null', 'PGSYSCONFDIR': home, 'PGSERVICEFILE': '/dev/null'}
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                process = subprocess.Popen([PSQL, '-X', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1',
                                            '-d', connection], stdin=subprocess.PIPE,
                                           stdout=output, stderr=errors, env=environment, cwd=home)
                try:
                    process.communicate(SQL.encode('utf-8'), timeout=5)
                finally:
                    try:
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=2)
                    finally:
                        if process.stdin is not None:
                            process.stdin.close()
                require(process.returncode == 0)
                errors.seek(0)
                require(not errors.read(1))
                output.seek(0)
                return Exit(decode(output.read(65537), binding))
    except Exception:
        return refused
