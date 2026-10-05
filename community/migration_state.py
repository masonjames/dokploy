"""Pure synthetic-fixture manifest, ledger and catalog contracts; no authority."""

import hashlib
import json
from pathlib import Path
import re


class ContractError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ContractError('duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs,
                          parse_constant=lambda value: (_ for _ in ()).throw(ContractError('nonfinite JSON')))
    except (ValueError, UnicodeError) as error:
        raise ContractError('invalid JSON') from error


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ContractError('expected regular source file')
    return path.read_bytes()


def manifest(folder):
    """Read once: the returned bytes, not mutable source paths, feed both clients."""
    folder = Path(folder)
    if folder.is_symlink() or (folder / 'meta').is_symlink():
        raise ContractError('symlink migration directory')
    journal_bytes = regular(folder / 'meta/_journal.json')
    inventory = {}
    for path in sorted(folder.glob('*.sql')):
        if not re.fullmatch(r'[0-9]{4}_[a-z0-9_-]+\.sql', path.name):
            raise ContractError('SQL path')
        data = regular(path)
        try:
            if data.decode('utf-8').encode('utf-8') != data or b'\r' in data:
                raise ContractError('SQL encoding')
        except UnicodeError as error:
            raise ContractError('SQL encoding') from error
        inventory[path.name] = data
    return manifest_bytes(journal_bytes, inventory)


def manifest_bytes(journal_bytes, inventory):
    journal = decode(journal_bytes)
    if (not isinstance(journal, dict) or set(journal) != {'version', 'dialect', 'entries'}
            or journal['dialect'] != 'pg' or journal['version'] != '5'
            or not isinstance(journal['entries'], list) or not journal['entries']):
        raise ContractError('journal shape')
    if not isinstance(inventory, dict) or not inventory:
        raise ContractError('empty SQL inventory')
    for name, data in inventory.items():
        if (not isinstance(name, str) or not re.fullmatch(r'[0-9]{4}_[a-z0-9_-]+\.sql', name)
                or not isinstance(data, bytes)):
            raise ContractError('snapshot SQL path/bytes')
        try:
            data.decode('utf-8')
        except UnicodeError as error:
            raise ContractError('SQL encoding') from error
    inventory = dict(inventory)
    selected, seen, previous, previous_version = [], set(), -1, 5
    for index, entry in enumerate(journal['entries']):
        if not isinstance(entry, dict) or set(entry) != {'idx', 'version', 'when', 'tag', 'breakpoints'}:
            raise ContractError('entry shape')
        tag, when = entry['tag'], entry['when']
        if (type(entry['idx']) is not int or entry['idx'] != index or entry['version'] not in ('5', '6', '7')
                or int(entry['version']) < previous_version or entry['breakpoints'] is not True or type(when) is not int
                or when <= previous or when > 9007199254740991 or not isinstance(tag, str)
                or not re.fullmatch(r'[0-9]{4}_[a-z0-9_-]+', tag) or tag in seen
                or int(tag[:4]) != index or tag + '.sql' not in inventory):
            raise ContractError('entry path/order/timestamp')
        selected.append({'tag': tag, 'when': when, 'hash': digest(inventory[tag + '.sql'])})
        seen.add(tag)
        previous = when
        previous_version = int(entry['version'])
    return {'journal': journal_bytes, 'files': inventory, 'entries': selected}


def ledger_prefix(entries, rows):
    if not isinstance(rows, list) or len(rows) > len(entries):
        raise ContractError('ledger length')
    for expected, row in zip(entries, rows):
        if (not isinstance(row, dict) or set(row) != {'hash', 'created_at'}
                or type(row['created_at']) is not int
                or row != {'hash': expected['hash'], 'created_at': expected['when']}):
            raise ContractError('ledger gap/order/hash drift')
    return len(rows)


def bootstrap_state(schema, objects, rows):
    """Synthetic-only. All bootstrap states retain/quarantine, never retry/repair."""
    if type(schema) is not bool or not isinstance(objects, list) or not isinstance(rows, list):
        raise ContractError('bootstrap shape')
    if not schema and not objects and not rows:
        return 'none'
    if schema and not objects and not rows:
        return 'schema-only'
    expected = [['__drizzle_migrations', 'r'], ['__drizzle_migrations_id_seq', 'S'],
                ['__drizzle_migrations_pkey', 'i']]
    if schema and objects == expected:
        return 'ledger-present' if rows else 'schema-empty-table-sequence-pk'
    raise ContractError('unexpected bootstrap objects')


SECTIONS = {'schemas', 'relations', 'columns', 'constraints', 'indexes', 'enums',
            'sequences', 'functions', 'triggers', 'extensions', 'owners', 'grants',
            'default_grants', 'policies', 'rows'}
WIDTHS = dict(schemas=1, relations=6, columns=7, constraints=4, indexes=3,
              enums=3, sequences=12, functions=4, triggers=4, extensions=4,
              owners=3, grants=6, default_grants=6, policies=8)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def descriptor(value):
    if (not isinstance(value, dict) or set(value) != SECTIONS | {'version'}
            or type(value['version']) is not int or value['version'] != 1):
        raise ContractError('descriptor sections/version')
    for name in SECTIONS:
        rows = value[name]
        if not isinstance(rows, list) or not all(isinstance(row, list) for row in rows):
            raise ContractError('descriptor rows')
        if name in WIDTHS and any(len(row) != WIDTHS[name] for row in rows):
            raise ContractError('descriptor width')
        for row in rows:
            integer_fields = {'columns': {2}, 'sequences': {3, 4, 5, 6, 7}}.get(name, set())
            boolean_fields = {'relations': {4, 5}, 'policies': {4}, 'columns': {5}, 'sequences': {8}, 'grants': {5}, 'default_grants': {5}}.get(name, set())
            nullable_fields = {'policies': {6, 7}, 'columns': {6}, 'constraints': {1}, 'sequences': {9, 10, 11}}.get(name, set())
            if name == 'rows':
                if any(type(cell) not in (str, int, bool, type(None)) for cell in row):
                    raise ContractError('data row scalar type')
                continue
            for index, cell in enumerate(row):
                if (name == 'enums' and index == 2) or (name == 'policies' and index == 5):
                    valid = isinstance(cell, list) and all(type(label) is str for label in cell)
                elif index in integer_fields:
                    valid = type(cell) is int
                elif index in boolean_fields:
                    valid = type(cell) is bool
                else:
                    valid = type(cell) is str or (cell is None and index in nullable_fields)
                if not valid:
                    raise ContractError('descriptor field type: ' + name)
        if len({canonical(row) for row in rows}) != len(rows):
            raise ContractError('descriptor duplicates')
    return {key: sorted(value[key], key=canonical) if key in SECTIONS else value[key]
            for key in value}


def compare(expected, actual):
    expected, actual = descriptor(expected), descriptor(actual)
    drift = [key for key in sorted(SECTIONS) if canonical(expected[key]) != canonical(actual[key])]
    if drift:
        raise ContractError('descriptor drift: ' + ','.join(drift))
