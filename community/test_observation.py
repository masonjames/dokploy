"""Synthetic protocol/denial evidence only; does not execute PostgreSQL SQL."""

from contextlib import ExitStack
from dataclasses import replace
import ast
import importlib
import io
from pathlib import Path
import unittest
from unittest.mock import patch

import observe_entry
import state_observation as obs


TARGET = obs.Target("synthetic-install", "7312345678901234567", 16400,
                    "synthetic_database", "synthetic_owner", "synthetic_observer",
                    "192.0.2.10", 5432)


def empty_result():
    identity = (TARGET.system_identifier, TARGET.database_oid, TARGET.database_name,
                TARGET.database_owner, TARGET.observer_role, TARGET.observer_role,
                TARGET.server_address, TARGET.server_port)
    return obs.Result(obs.COLUMNS, (identity + (
        "on", "repeatable read", "100:100:", True, True, True, "pg_catalog",
        1, *([0] * (len(obs.COUNT_COLUMNS) - 1)),
    ),))


def changed(**values):
    row = dict(zip(obs.COLUMNS, empty_result().rows[0]))
    row.update(values)
    return obs.Result(obs.COLUMNS, (tuple(row[name] for name in obs.COLUMNS),))


class SyntheticSession:
    """Strict protocol driver, not a PostgreSQL emulator or real connector."""

    def __init__(self, result=None, fail=None, fail_close=False):
        self.result = empty_result() if result is None else result
        self.fail = fail
        self.fail_close = fail_close
        self.calls = []
        self.closed = False
        self.phase = 0
        self.violated = False

    def execute(self, sql):
        self.calls.append(sql)
        if sql == self.fail:
            raise PermissionError("SYNTHETIC PRIVATE ERROR MUST NOT ESCAPE")
        if sql == obs.ROLLBACK:
            self.phase = 0
            return obs.Result((), ())
        expected = (obs.BEGIN, obs.SET_PATH, obs.OBSERVE)
        if self.closed or self.phase >= len(expected) or sql != expected[self.phase]:
            self.violated = True
            raise AssertionError("Out-of-order, duplicate or unapproved query")
        self.phase += 1
        if sql == obs.OBSERVE:
            return self.result
        return obs.Result((), ())

    def close(self):
        self.calls.append("CLOSE")
        self.closed = True
        if self.fail_close:
            raise OSError("SYNTHETIC CLOSE FAILURE")


class ObservationTests(unittest.TestCase):
    def check(self, session, classification, target=TARGET, purpose="initial"):
        result = observe_entry.run(session, target, purpose)
        self.assertEqual(result.observation.classification, classification)
        self.assertEqual(result.exit_code, 1)
        self.assertFalse(result.migration_authorized or result.runtime_authorized)
        self.assertFalse(result.observation.migration_authorized or result.observation.runtime_authorized)
        self.assertTrue(session.closed)
        self.assertFalse(session.violated)
        self.assertEqual(session.calls[-2:], [obs.ROLLBACK, "CLOSE"])
        self.assertNotIn("PRIVATE", result.observation.reason)
        return result

    def test_positive_empty_complete_snapshot_without_authority(self):
        session = SyntheticSession()
        self.check(session, "NEW_EMPTY_CANDIDATE")
        self.assertEqual(session.calls, [obs.BEGIN, obs.SET_PATH, obs.OBSERVE, obs.ROLLBACK, "CLOSE"])
        self.assertEqual(session.phase, 0)

    def test_independent_identity_mismatch_for_every_observed_component(self):
        for name in obs.IDENTITY_COLUMNS:
            with self.subTest(name=name):
                original = dict(zip(obs.COLUMNS, empty_result().rows[0]))[name]
                wrong = original + 1 if type(original) is int else original + "-wrong"
                self.check(SyntheticSession(changed(**{name: wrong})), "REFUSE_IDENTITY")
        self.check(SyntheticSession(), "REFUSE_IDENTITY", replace(TARGET, database_oid=16401))

    def test_binding_required_before_observation(self):
        for target in (None, {}, replace(TARGET, installation_id=""),
                       replace(TARGET, database_oid=True), replace(TARGET, server_port=0),
                       replace(TARGET, system_identifier="unknown")):
            with self.subTest(target=target):
                session = SyntheticSession()
                self.check(session, "REFUSE_UNKNOWN", target)
                self.assertEqual(session.calls, [obs.ROLLBACK, "CLOSE"])

    def test_target_text_never_interpolated_into_sql(self):
        session = SyntheticSession()
        self.check(session, "REFUSE_IDENTITY", replace(TARGET, database_name="'; DROP DATABASE x; --"))
        self.assertNotIn("DROP DATABASE", "\n".join(session.calls))

    def test_access_and_query_failures_never_become_empty(self):
        for sql in (obs.BEGIN, obs.SET_PATH, obs.OBSERVE):
            with self.subTest(sql=sql):
                session = SyntheticSession(fail=sql)
                self.check(session, "REFUSE_UNKNOWN")
                self.assertEqual(session.calls.count(sql), 1)
        for name in ("catalog_access", "database_access", "public_access"):
            for value in (False, None, 1, "true"):
                self.check(SyntheticSession(changed(**{name: value})), "REFUSE_UNKNOWN")

    def test_malformed_rows_columns_types_and_partial_fetch(self):
        good = empty_result()
        bad = [obs.Result((), ()), obs.Result(good.columns, ()),
               obs.Result(good.columns, good.rows * 2),
               obs.Result(good.columns[:-1], (good.rows[0][:-1],)),
               obs.Result(good.columns + ("complete",), (good.rows[0] + (True,),)),
               obs.Result(tuple(reversed(good.columns)), good.rows),
               obs.Result(good.columns, (good.rows[0][:-1],)),
               obs.Result(list(good.columns), good.rows),
               obs.Result(good.columns, [good.rows[0]]),
               obs.Result(good.columns, (list(good.rows[0]),)),
               {"complete": True}, "SYNTHETIC MALICIOUS RESULT"]
        for result in bad:
            with self.subTest(result=result):
                self.check(SyntheticSession(result), "REFUSE_UNKNOWN")
        for name in obs.COUNT_COLUMNS:
            for value in (-1, True, 0.0, "0", None):
                self.check(SyntheticSession(changed(**{name: value})), "REFUSE_UNKNOWN")
        for name in obs.IDENTITY_COLUMNS:
            self.check(SyntheticSession(changed(**{name: None})), "REFUSE_UNKNOWN")

    def test_native_column_command_and_purpose_types_required(self):
        class Equal:
            def __eq__(self, other):
                return True

        good = empty_result()
        columns = tuple(Equal() for _ in obs.COLUMNS)
        self.check(SyntheticSession(obs.Result(columns, good.rows)), "REFUSE_UNKNOWN")
        session = SyntheticSession()
        execute = session.execute

        def wrong_command(sql):
            result = execute(sql)
            return obs.Result(Equal(), Equal()) if sql == obs.BEGIN else result

        session.execute = wrong_command
        self.check(session, "REFUSE_UNKNOWN")
        session = SyntheticSession()
        self.check(session, "REFUSE_EXISTING", purpose=Equal())
        self.assertNotIn(obs.OBSERVE, session.calls)

    def test_read_consistency_settings_and_snapshot_required(self):
        for values in ({"read_only": "off"}, {"isolation": "read committed"},
                       {"search_path": "public"}, {"search_path": None},
                       {"snapshot": None}, {"snapshot": "missing"},
                       {"snapshot": "100:100:; SELECT 1"},
                       {"snapshot": "105:100:"}, {"snapshot": "0:0:"},
                       {"snapshot": "100:105:105"}, {"snapshot": "100:105:101,101"}):
            self.check(SyntheticSession(changed(**values)), "REFUSE_UNKNOWN")
        self.check(SyntheticSession(changed(snapshot="100:105:101,103")), "NEW_EMPTY_CANDIDATE")

    def test_hidden_empty_partial_and_crashed_migration_state_refuses(self):
        # One nonzero relation count covers the structural refusal only;
        # table-specific and hidden-row SQL semantics need PostgreSQL execution.
        self.check(SyntheticSession(changed(relations=1)), "REFUSE_EXISTING")
        for name in obs.COUNT_COLUMNS[1:]:
            with self.subTest(partial_object=name):
                self.check(SyntheticSession(changed(**{name: 1})), "REFUSE_EXISTING")
        for count in (0, 2):
            self.check(SyntheticSession(changed(public_schemas=count)), "REFUSE_UNKNOWN")

    def test_restart_upgrade_and_marker_grant_nothing(self):
        for purpose in ("restart", "upgrade", "unknown", None, True):
            session = SyntheticSession()
            self.check(session, "REFUSE_EXISTING", purpose=purpose)
            self.assertNotIn(obs.OBSERVE, session.calls)
        self.check(SyntheticSession(changed(relations=1)), "REFUSE_EXISTING")

    def test_rollback_and_close_failures_override_candidate_and_refusal(self):
        for result in (empty_result(), changed(relations=1)):
            for rollback, close in ((True, False), (False, True), (True, True)):
                self.check(SyntheticSession(result, obs.ROLLBACK if rollback else None, close),
                           "REFUSE_CLEANUP")
        self.check(SyntheticSession(fail=obs.OBSERVE, fail_close=True), "REFUSE_CLEANUP")

    def test_invalid_command_response_and_cancellation_cleanup(self):
        session = SyntheticSession()
        execute = session.execute

        def wrong_command(sql):
            result = execute(sql)
            return obs.Result(("unexpected",), ((True,),)) if sql == obs.BEGIN else result

        session.execute = wrong_command
        self.check(session, "REFUSE_UNKNOWN")
        session = SyntheticSession()
        execute = session.execute

        def interrupt(sql):
            if sql == obs.OBSERVE:
                raise KeyboardInterrupt()
            return execute(sql)

        session.execute = interrupt
        with self.assertRaises(KeyboardInterrupt):
            observe_entry.run(session, TARGET)
        self.assertTrue(session.closed)
        self.assertFalse(session.violated)
        self.assertEqual(session.calls[-2:], [obs.ROLLBACK, "CLOSE"])

    def test_failed_observation_then_fresh_retry_is_only_an_observation(self):
        self.check(SyntheticSession(fail=obs.OBSERVE), "REFUSE_UNKNOWN")
        self.check(SyntheticSession(changed(types=1)), "REFUSE_EXISTING")
        self.check(SyntheticSession(), "NEW_EMPTY_CANDIDATE")

    def test_sql_contract_uses_catalogs_and_one_snapshot_not_visibility_views(self):
        self.assertNotIn("information_schema.tables", obs.OBSERVE)
        self.assertNotIn("pg_table_is_visible", obs.OBSERVE)
        self.assertNotIn("LIMIT", obs.OBSERVE)
        for name in obs.CATALOGS:
            self.assertIn("pg_catalog." + name, obs.OBSERVE)
        self.assertIn("has_table_privilege", obs.OBSERVE)
        self.assertIn("NOT c.relrowsecurity", obs.OBSERVE)
        self.assertIn("pg_control_system()", obs.OBSERVE)
        self.assertIn("pg_catalog.host(pg_catalog.inet_server_addr())", obs.OBSERVE)
        self.assertIn("pg_catalog.pg_current_snapshot()", obs.OBSERVE)
        self.assertNotIn("txid_current_snapshot", obs.OBSERVE)

    def test_protocol_violation_cannot_hide_behind_unknown_refusal(self):
        session = SyntheticSession()
        execute = session.execute

        def duplicate(sql):
            result = execute(sql)
            if sql == obs.BEGIN:
                execute(sql)
            return result

        session.execute = duplicate
        with self.assertRaises(AssertionError):
            self.check(session, "REFUSE_UNKNOWN")
        self.assertTrue(session.violated)

    def test_dependency_closure_contains_no_application_or_connector_imports(self):
        for filename in ("state_observation.py", "observe_entry.py", "state_policy.py"):
            tree = ast.parse(Path(__file__).with_name(filename).read_text())
            imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
            imports.update(alias.name for node in ast.walk(tree) if isinstance(node, ast.Import)
                           for alias in node.names)
            self.assertLessEqual(imports, {"dataclasses", "re", "typing", "json",
                                           "state_observation", "state_policy"})

    def test_imports_and_all_outcomes_have_no_runtime_side_effects(self):
        observation_code = compile(Path(obs.__file__).read_text(), obs.__file__, "exec")
        # Tripwires cover Python's launch/network/write/thread routes. The seam
        # has no maintained runtime imports or migration/startup callback slots.
        forbidden = AssertionError("Prohibited runtime side effect")
        with ExitStack() as stack:
            probes = [stack.enter_context(patch(path, side_effect=forbidden)) for path in (
                "builtins.open", "os.open", "os.mkdir", "os.makedirs", "os.system",
                "subprocess.Popen", "socket.socket", "socket.create_connection",
                "threading.Thread.start",
            )]
            exec(observation_code, {"__name__": "state_observation"})
            importlib.reload(observe_entry)
            for session in (SyntheticSession(), SyntheticSession(changed(relations=1)),
                            SyntheticSession(fail=obs.OBSERVE),
                            SyntheticSession(changed(database_name="wrong"))):
                result = observe_entry.run(session, TARGET)
                self.assertEqual(result.exit_code, 1)
                self.assertFalse(result.runtime_authorized or result.migration_authorized)
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(observe_entry.main(), 1)
                self.assertIn("REFUSE_UNCONFIGURED", output.getvalue())
            for probe in probes:
                probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
