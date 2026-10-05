"""Explicit real gate, run only after parent inspection of the static oracle.

No installed/live/imported target arguments. Failure retains owned evidence.
"""

import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

from maintenance_fixture import OwnedFixture, FixtureError, PG, SOURCE, node_startup_smoke
from migration_state import (canonical, compare, decode, descriptor, digest,
                             ledger_prefix, manifest, regular)


CONTROL_SQLSTATES = {
    "COPY (SELECT 1) TO PROGRAM 'true'": '42501',
    "ALTER SYSTEM SET work_mem='8MB'": '0A000',  # Fixed allow_alter_system=off.
}


def assert_control_error(statement, error):
    """Only these fixture controls, with fixed psql verbose output and C locale."""
    expected = CONTROL_SQLSTATES.get(statement)
    # Only anchored error headers decide the control; ignore auxiliary text.
    headers = [line for line in error.splitlines()
               if re.match(r'^(?:ERROR|FATAL|PANIC)\b', line)]
    match = re.fullmatch(r'ERROR:  ([0-9A-Z]{5}): .+', headers[0]) if len(headers) == 1 else None
    if expected is None or match is None or match[1] != expected:
        raise FixtureError('unexpected negative-control error class')


def controls(fixture):
    for statement in CONTROL_SQLSTATES:
        assert_control_error(statement, fixture.sql(statement, expect_error=True))
    error = fixture.sql('SELECT 1', 'hostler_wrong', expect_error=True)
    if 'pg_hba.conf rejects connection' not in error:
        raise FixtureError('wrong-role HBA control')
    rc, out, err = fixture.command(['/usr/sbin/lsof', '-nP', '-a', '-p', str(fixture.server.pid), '-iTCP'])
    if rc != 1 or out or err:
        raise FixtureError('no-TCP listener assertion failed')
    if fixture.read('SELECT current_user') != 'hostler_observer':
        raise FixtureError('independent observer identity')
    error = fixture.sql('CREATE TABLE public.observer_denied(id integer)', 'hostler_observer', expect_error=True)
    if '42501' not in error:
        raise FixtureError('observer mutation control')


def psql_chain(fixture, selected):
    """Separate client derivation. Bootstrap autocommits; chain is one transaction."""
    fixture.verify()
    if fixture.state() != 'none':
        raise FixtureError('psql requires fresh fixture')
    fixture.sql('CREATE SCHEMA drizzle')
    fixture.sql('CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)')
    script = ['BEGIN;']
    for entry in selected['entries']:
        for index, statement in enumerate(selected['files'][entry['tag'] + '.sql'].decode().split('--> statement-breakpoint')):
            script.append('\\echo BOUNDARY ' + entry['tag'] + ' ' + str(index))
            script.append(statement)
        script.append("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('" + entry['hash'] + "'," + str(entry['when']) + ');')
    script.append('COMMIT;')
    args = [str(PG / 'psql'), '-X', '-qAtw', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
            '-h', str(fixture.root / 's'), '-p', '5432', '-U', 'hostler_migrator', '-d', 'hostler_fixture']
    rc, out, err = fixture.command(args, '\n'.join(script), timeout=180)
    boundaries = re.findall(r'^BOUNDARY (\S+) (\d+)$', out, re.M)
    states = re.findall(r'ERROR:\s+([0-9A-Z]{5}):', err)
    result = {'status': 'failed' if rc else 'applied', 'sqlstate': states[-1] if states else None,
              'boundary': boundaries[-1] if boundaries else None}
    (fixture.root / 'psql-result.json').write_text(canonical(result) + '\n')
    fixture.verify()
    return result


class WriterFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node_startup_smoke()  # Must pass before any fixture can start initdb.
        cls.evidence = Path(tempfile.mkdtemp(prefix='hostler-writer-evidence-', dir='/private/tmp'))
        print('Retained gate evidence:', cls.evidence, flush=True)

    def retain(self, fixture, name, extra):
        output = self.evidence / name
        output.mkdir()
        for file in fixture.root.iterdir():
            if file.is_file():
                (output / file.name).write_bytes(regular(file))
        (output / 'result.json').write_text(canonical(extra) + '\n')

    def test_01_small_hand_authored_oracle(self):
        selected = manifest(SOURCE / 'writer_fixture')
        oracle_bytes = regular(SOURCE / 'writer_fixture/oracle.json')
        expected = descriptor(decode(oracle_bytes))
        with OwnedFixture() as fixture:
            controls(fixture)
            fixture.snapshot(selected, oracle_bytes)
            result = fixture.drizzle()
            actual = fixture.catalog(small=result['status'] == 'applied')
            ledger = fixture.ledger()
            self.retain(fixture, 'small', {'executor': result, 'catalog': actual,
                                        'ledger': ledger, 'bootstrap': fixture.state()})
            self.assertEqual(result['status'], 'applied', result)
            self.assertEqual(ledger_prefix(selected['entries'], ledger), 2)
            compare(expected, actual)
            self.assertIn('42501', fixture.sql('UPDATE public.fixture_item SET label=\'denied\'',
                                               'hostler_observer', expect_error=True))
            # Verify mutable role defaults are caught rather than assumed overridden.
            fixture.sql("ALTER ROLE hostler_observer SET work_mem='8MB'", 'hostler_admin')
            with self.assertRaisesRegex(FixtureError, 'role/database setting override'):
                fixture.verify()
            fixture.success = True
        (self.evidence / 'small-cleanup.json').write_text('{"clean_exit_and_removal":true}\n')

    def test_02_current196_differential_attempt(self):
        selected = manifest(SOURCE.parent / 'apps/dokploy/drizzle')
        pins = decode(regular(SOURCE / 'writer_fixture/maintained-source.json'))
        self.assertEqual(digest(selected['journal']), pins['journal'])
        self.assertEqual({name: digest(data) for name, data in selected['files'].items()}, pins['sql_files'])
        for name, expected in pins['source'].items():
            self.assertEqual(digest(regular(SOURCE.parent / name)), expected)
        self.assertEqual(len(selected['entries']), 196)
        self.assertEqual(len(selected['files']), 197)
        unselected = set(selected['files']) - {entry['tag'] + '.sql' for entry in selected['entries']}
        self.assertEqual(unselected, {'0130_abandoned_dagger.sql'})
        counterpart = [entry for entry in selected['entries'] if entry['tag'].startswith('0130_')]
        self.assertEqual(len(counterpart), 1)
        inventory = {'unselected': {'0130_abandoned_dagger.sql': digest(selected['files']['0130_abandoned_dagger.sql'])},
                     'selected_same_index': counterpart, 'evidence_class': 'differential equivalence only'}
        (self.evidence / 'maintained-inventory.json').write_text(canonical(inventory) + '\n')
        # Both attempts run even when the maintained chain fails; no SQL repairs.
        with OwnedFixture() as drizzle_fixture, OwnedFixture() as psql_fixture:
            for fixture in (drizzle_fixture, psql_fixture):
                controls(fixture)
                fixture.snapshot(selected, canonical(inventory).encode())
            drizzle_result = drizzle_fixture.drizzle()
            psql_result = psql_chain(psql_fixture, selected)
            actual, differential = drizzle_fixture.catalog(), psql_fixture.catalog()
            left, right = drizzle_fixture.ledger(), psql_fixture.ledger()
            for fixture, name, result, catalog, ledger in [
                    (drizzle_fixture, 'maintained-drizzle', drizzle_result, actual, left),
                    (psql_fixture, 'maintained-psql', psql_result, differential, right)]:
                self.retain(fixture, name, {'execution': result, 'catalog': catalog,
                                          'ledger': ledger, 'bootstrap': fixture.state()})
            self.assertEqual(drizzle_result['status'], 'applied', drizzle_result)
            self.assertEqual(psql_result['status'], 'applied', psql_result)
            self.assertEqual(ledger_prefix(selected['entries'], left), 196)
            self.assertEqual(ledger_prefix(selected['entries'], right), 196)
            compare(actual, differential)
            drizzle_fixture.success = psql_fixture.success = True
        (self.evidence / 'maintained-cleanup.json').write_text('{"clean_exit_and_removal":true}\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
