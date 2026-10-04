"""Preparatory PostgreSQL observation contract; no connector or startup authority."""

from dataclasses import dataclass
import re
from typing import Protocol

from state_policy import COUNTS, Decision, classify


@dataclass(frozen=True)
class Target:
    """Trusted external installation binding, never inferred from observed emptiness."""

    installation_id: str
    system_identifier: str
    database_oid: int
    database_name: str
    database_owner: str
    observer_role: str
    server_address: str
    server_port: int


@dataclass(frozen=True)
class Result:
    """Exact column order and fully fetched rows; no truncation/coercion permitted."""

    columns: tuple[str, ...]
    rows: tuple[tuple[object, ...], ...]


class QuerySession(Protocol):
    """Exclusive, fresh idle session to an independently authenticated target.

    execute must send the exact SQL, fetch all rows, preserve native bool/int/text,
    and raise on server, transport, decoding, timeout or incomplete-fetch errors.
    No retries, pooled transaction switching, implicit commits or error-to-empty.
    close must discard the connection, even when rollback failed.
    """

    def execute(self, sql: str) -> Result: ...

    def close(self) -> None: ...


BEGIN = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
SET_PATH = "SET LOCAL search_path = pg_catalog"
ROLLBACK = "ROLLBACK"

# Direct catalogs do not hide relations lacking table SELECT or schema USAGE,
# unlike information_schema.tables. No application row, view or function executes.
CATALOGS = (
    "pg_database", "pg_namespace", "pg_class", "pg_type", "pg_proc",
    "pg_extension", "pg_largeobject_metadata", "pg_event_trigger",
    "pg_foreign_server", "pg_publication", "pg_subscription",
    "pg_default_acl", "pg_db_role_setting", "pg_prepared_xacts",
)
IDENTITY_COLUMNS = (
    "system_identifier", "database_oid", "database_name", "database_owner",
    "observer_role", "session_role", "server_address", "server_port",
)
COUNT_COLUMNS = (
    "public_schemas", "other_schemas", "relations", "types", "routines",
    "extensions", "large_objects", "event_triggers", "foreign_servers",
    "publications", "subscriptions", "default_acls", "database_role_settings",
    "prepared_transactions",
)
COLUMNS = IDENTITY_COLUMNS + (
    "read_only", "isolation", "snapshot", "catalog_access", "database_access",
    "public_access", "search_path",
) + COUNT_COLUMNS

# Only fixed catalog names are interpolated, never target values or database names.
_CATALOG_NAMES = ", ".join("'" + name + "'" for name in CATALOGS)
OBSERVE = """
SELECT
    (SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()) AS system_identifier,
    d.oid::pg_catalog.int8 AS database_oid,
    d.datname::pg_catalog.text AS database_name,
    pg_catalog.pg_get_userbyid(d.datdba)::pg_catalog.text AS database_owner,
    current_user::pg_catalog.text AS observer_role,
    session_user::pg_catalog.text AS session_role,
    pg_catalog.host(pg_catalog.inet_server_addr()) AS server_address,
    pg_catalog.inet_server_port() AS server_port,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.pg_current_snapshot()::pg_catalog.text AS snapshot,
    (SELECT pg_catalog.count(*) = CATALOG_COUNT AND
        pg_catalog.bool_and(pg_catalog.has_table_privilege(c.oid, 'SELECT')
                 AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'pg_catalog' AND c.relname IN (CATALOG_NAMES))
        AND pg_catalog.has_schema_privilege('pg_catalog', 'USAGE') AS catalog_access,
    pg_catalog.has_database_privilege(d.oid, 'CONNECT') AS database_access,
    (SELECT pg_catalog.bool_and(pg_catalog.has_schema_privilege(n.oid, 'USAGE'))
     FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public') AS public_access,
    pg_catalog.current_setting('search_path') AS search_path,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace WHERE nspname = 'public') AS public_schemas,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace
     WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema', 'pg_toast')) AS other_schemas,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        OR c.oid >= 16384) AS relations,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type t
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        OR t.oid >= 16384) AS types,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        OR p.oid >= 16384) AS routines,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql') AS extensions,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_largeobject_metadata) AS large_objects,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_event_trigger) AS event_triggers,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_foreign_server) AS foreign_servers,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_publication) AS publications,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_subscription) AS subscriptions,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_default_acl) AS default_acls,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_db_role_setting
     WHERE setdatabase IN (0, d.oid)) AS database_role_settings,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_prepared_xacts
     WHERE database = d.datname) AS prepared_transactions
FROM pg_catalog.pg_database d
WHERE d.datname = pg_catalog.current_database()
""".replace("CATALOG_COUNT", str(len(CATALOGS))).replace("CATALOG_NAMES", _CATALOG_NAMES).strip()


class InvalidObservation(ValueError):
    pass


def require(condition: bool) -> None:
    if not condition:
        raise InvalidObservation()


def validate_target(target: Target) -> None:
    require(type(target) is Target)
    for value in (target.installation_id, target.system_identifier, target.database_name,
                  target.database_owner, target.observer_role, target.server_address):
        require(type(value) is str and 0 < len(value) <= 256 and "\x00" not in value)
    require(re.fullmatch(r"[1-9][0-9]{0,19}", target.system_identifier) is not None)
    require(type(target.database_oid) is int and 0 < target.database_oid < 2**32)
    require(type(target.server_port) is int and 0 < target.server_port < 65536)


def command(session: QuerySession, sql: str) -> None:
    result = session.execute(sql)
    require(type(result) is Result and type(result.columns) is tuple and
            type(result.rows) is tuple and result.columns == () and result.rows == ())


def interpret(result: Result, target: Target) -> Decision:
    require(type(result) is Result and type(result.columns) is tuple and
            all(type(name) is str for name in result.columns) and result.columns == COLUMNS)
    require(type(result.rows) is tuple and len(result.rows) == 1)
    row = result.rows[0]
    require(type(row) is tuple and len(row) == len(COLUMNS))
    values = dict(zip(COLUMNS, row))
    expected = (
        target.system_identifier, target.database_oid, target.database_name,
        target.database_owner, target.observer_role, target.observer_role,
        target.server_address, target.server_port,
    )
    for name, value in zip(IDENTITY_COLUMNS, expected):
        require(type(values[name]) is type(value))
    if tuple(values[name] for name in IDENTITY_COLUMNS) != expected:
        return Decision("REFUSE_IDENTITY", "Observed database does not match external installation binding")
    require(type(values["read_only"]) is str and values["read_only"] == "on")
    require(type(values["isolation"]) is str and values["isolation"] == "repeatable read")
    require(type(values["search_path"]) is str and values["search_path"] == "pg_catalog")
    require(type(values["snapshot"]) is str and
            re.fullmatch(r"[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?", values["snapshot"]) is not None)
    lower, upper, active = values["snapshot"].split(":")
    xmin, xmax = int(lower), int(upper)
    transactions = [int(value) for value in active.split(",")] if active else []
    require(0 < xmin <= xmax < 2**64 and transactions == sorted(set(transactions)))
    require(all(xmin <= value < xmax for value in transactions))
    require(all(values[name] is True for name in ("catalog_access", "database_access", "public_access")))
    require(all(type(values[name]) is int and values[name] >= 0 for name in COUNT_COLUMNS))
    require(values["public_schemas"] == 1)
    if any(values[name] for name in COUNT_COLUMNS[1:]):
        return Decision("REFUSE_EXISTING", "Existing or partial state; compatibility is unqualified")
    # Structural absence, not guessed per-feature counts or a role compatibility parser.
    supplied = classify({"complete": True, "database_kind": "new", **dict.fromkeys(COUNTS, 0)})
    return Decision(supplied.classification, "Observed application structures absent; no migration or startup authority")


def observe(session: QuerySession, target: Target, purpose: str = "initial") -> Decision:
    """Consume and close a session; candidate only after successful cleanup.

    This is a point-in-time observation, not a lock against future writes, proof
    of historical freshness, installation attestation or a migration capability.
    """
    decision = Decision("REFUSE_UNKNOWN", "Observation failed or was incomplete")
    cleanup_failed = False
    try:
        validate_target(target)
        if type(purpose) is not str or purpose != "initial":
            decision = Decision("REFUSE_EXISTING", "Restart/upgrade admission is out of scope")
        else:
            command(session, BEGIN)
            command(session, SET_PATH)
            decision = interpret(session.execute(OBSERVE), target)
    except Exception:
        # Driver errors can contain credentials or persisted data; never echo them.
        decision = Decision("REFUSE_UNKNOWN", "Observation failed or was incomplete")
    finally:
        try:
            command(session, ROLLBACK)
        except Exception:
            cleanup_failed = True
        finally:
            try:
                session.close()
            except Exception:
                cleanup_failed = True
    if cleanup_failed:
        return Decision("REFUSE_CLEANUP", "Session cleanup failed; discard connection and investigate")
    return decision
