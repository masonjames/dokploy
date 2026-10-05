"""Synthetic receipt parsing only; no fixture main, app, or database execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import io

BUILD = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pg18_result_runner", BUILD / "pg18_fixture.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
CONTRACT = json.loads((BUILD / "pg18-contract.json").read_text())


def successful_result():
    # Mirrors invitations.test.ts success(), concurrency, fault, and refusal output.
    def success(case, winner="I1"):
        return dict(case=case, membership_count=1,
                    role="member" if winner == "I1" else "admin", winner=winner,
                    response_cookie_count=1, cookie_continuity=True,
                    active_organization="A", protected_hash="a" * 64, after_hash="b" * 64)

    observations = [success("single")]
    for case, winner, rule in (("same-invitation", "I1", "not_pending"),
                               ("distinct-invitations", "I2", "existing_member")):
        observations.append(dict(case=case, overlap=True, blocked_connections=2,
                                 nonlocking_negative_control_completed=True))
        observations.append(dict(success(case, winner), statuses=[200, 403],
                                 loser=CONTRACT["http"][rule].copy(), transactions_completed=True))
    observations.append(dict(case="transaction-failure", **CONTRACT["http"]["write_failure"],
                             before_hash="c" * 64, after_hash="c" * 64,
                             sqlstate_class=CONTRACT["fault_sqlstate_class"],
                             rollback_observed_from_separate_connection=True,
                             membership_attempt_observed=True))
    observations.append(success("separate-recovery"))
    for case in ("unauthenticated", "wrong_email", "expired", "custom_role",
                 "invalid_organization", "malformed"):
        observations.append(dict(case=case, **CONTRACT["http"]["refusal"],
                                 before_hash="d" * 64, after_hash="d" * 64))
    return dict(passed=True, case="malformed", oracle_sha256=CONTRACT["oracle_sha256"],
                observations=observations, startup=False, admission=False, runtime=False)


class ReadResult(unittest.TestCase):
    def read(self, result):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic-result.json"
            path.write_text(json.dumps(result))
            return RUNNER.read_result(path, CONTRACT)

    def test_complete_successful_observations(self):
        result = successful_result()
        self.assertEqual({o["case"] for o in result["observations"]}, set(CONTRACT["cases"]))
        parsed = self.read(result)
        self.assertEqual(parsed, result)
        fault = parsed["observations"][5]
        self.assertIs(fault["rollback_observed_from_separate_connection"], True)
        self.assertIs(fault["membership_attempt_observed"], True)

    def test_new_fields_require_booleans(self):
        for field in ("rollback_observed_from_separate_connection", "membership_attempt_observed"):
            for invalid in (1, 0, "true", None):
                with self.subTest(field=field, value=invalid):
                    result = successful_result()
                    result["observations"][5][field] = invalid
                    with self.assertRaisesRegex(RuntimeError, "Result boolean refused"):
                        self.read(result)

    def test_unknown_observation_field_refused(self):
        result = successful_result()
        result["observations"][5]["unexpected_field"] = True
        with self.assertRaisesRegex(RuntimeError, "Unknown result field"):
            self.read(result)

    def test_unknown_nested_loser_field_refused(self):
        result = successful_result()
        result["observations"][2]["loser"]["unexpected_field"] = True
        with self.assertRaisesRegex(RuntimeError, "Result loser refused"):
            self.read(result)

    def test_success_requires_exact_cases_and_observation_multiplicity(self):
        for change in ("missing", "extra", "duplicate", "missing-overlap", "duplicate-outcome"):
            with self.subTest(change=change):
                result = successful_result()
                if change == "missing":
                    result["observations"].pop()
                elif change == "extra":
                    result["observations"].append({"case": "setup"})
                elif change == "duplicate":
                    result["observations"].append(result["observations"][0].copy())
                elif change == "missing-overlap":
                    result["observations"].pop(1)
                else:
                    result["observations"][1] = result["observations"][2].copy()
                with self.assertRaisesRegex(RuntimeError, "Result (case|contention)"):
                    self.read(result)

    def test_failed_partial_observations_retained(self):
        result = successful_result()
        result.update(passed=False, case="setup", observations=result["observations"][:2])
        self.assertEqual(self.read(result), result)
        self.assertNotIn("failure_check_sha256", self.read(result))

    def test_failed_check_hash_retained(self):
        result = successful_result()
        result.update(passed=False, case="transaction-failure",
                      observations=result["observations"][:5],
                      failure_check_sha256=hashlib.sha256(b"seed login").hexdigest())
        self.assertEqual(self.read(result), result)

    def test_failure_check_hash_requires_lowercase_sha256(self):
        for invalid in (None, True, 1, [], {}, "", "a" * 63, "a" * 65,
                        "A" * 64, "g" * 64, "a" * 63 + "\n", "a" * 64 + "\n"):
            with self.subTest(value=invalid):
                result = successful_result()
                result.update(passed=False, failure_check_sha256=invalid)
                with self.assertRaisesRegex(RuntimeError, "Result failure check hash refused"):
                    self.read(result)

    def test_failure_check_hash_refused_on_success(self):
        result = successful_result()
        result["failure_check_sha256"] = "a" * 64
        with self.assertRaisesRegex(RuntimeError, "Result failure check hash refused"):
            self.read(result)

    def test_failure_check_hash_refused_in_observation(self):
        result = successful_result()
        result["passed"] = False
        result["observations"][0]["failure_check_sha256"] = "a" * 64
        with self.assertRaisesRegex(RuntimeError, "Result failure check hash refused"):
            self.read(result)


class LauncherStubs(unittest.TestCase):
    def test_interrupt_in_popen_registration_window_is_deferred_until_cleanable(self):
        state = {"launching": False, "pending": False}
        children, entry, events = [], {}, []
        class Child:
            pid = 4242
            stdout = io.BytesIO(b"synthetic bounded output")
            def wait(self, timeout):
                events.append("reaped")
        child = Child()
        def popen(*args, **kwargs):
            self.assertEqual(children, [])
            self.assertTrue(state["launching"])
            self.assertNotIn("preexec_fn", kwargs)
            RUNNER.interrupted(state)
            events.append("popen-returned")
            return child
        with patch.object(RUNNER.subprocess, "Popen", side_effect=popen):
            with self.assertRaises(KeyboardInterrupt):
                RUNNER.launch_owned(["stub"], Path("/"), {}, children, entry, state)
        self.assertEqual(len(children), 1)
        self.assertIs(children[0][0], child)
        self.assertEqual(entry, {"pid": child.pid, "pgid": child.pid})
        thread = children[0][2]
        self.assertIsNotNone(thread.ident)
        child.wait(timeout=1)
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(events, ["popen-returned", "reaped"])
        self.assertEqual(state, {"launching": False, "pending": False})
        with self.assertRaises(KeyboardInterrupt):
            RUNNER.interrupted(state)

    def test_group_settle_is_bounded_and_only_probes(self):
        class Child:
            pid = 4242
            def poll(self): return 0
        for settles in (True, False):
            clock = [0.0]
            probes = []
            def killpg(pid, sig):
                self.assertEqual(sig, 0)
                probes.append((pid, sig))
                if settles and clock[0] >= .1:
                    raise ProcessLookupError()
            with patch.object(RUNNER.time, "monotonic", side_effect=lambda: clock[0]), \
                 patch.object(RUNNER.time, "sleep", side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)), \
                 patch.object(RUNNER.os, "killpg", side_effect=killpg):
                self.assertEqual(RUNNER.group_stopped(Child()), settles)
            self.assertLessEqual(clock[0], 2.05)
            self.assertGreater(len(probes), 1)

    def test_both_library_contexts_bound_and_escape_refused(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory).resolve()
            for context in ("apps/dokploy", "packages/server"):
                for name in ("better-auth", "drizzle-orm", "postgres", "bcrypt"):
                    library = root / context / "node_modules" / name
                    library.mkdir(parents=True)
                    (library / "package.json").write_text(json.dumps({"version": "1.synthetic"}))
                    (library / "index.js").write_text(context)
            identities = RUNNER.library_identities(root)
            self.assertEqual(set(identities), {"apps/dokploy", "packages/server"})
            self.assertNotEqual(identities["apps/dokploy"]["better-auth"]["realpath"], identities["packages/server"]["better-auth"]["realpath"])
            self.assertNotEqual(identities["apps/dokploy"]["better-auth"]["files"]["index.js"], identities["packages/server"]["better-auth"]["files"]["index.js"])
            escaped = root / "apps/dokploy/node_modules/bcrypt/index.js"
            escaped.unlink()
            target = Path(outside) / "outside.js"
            target.write_text("outside")
            escaped.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "Library file escape"):
                RUNNER.library_identities(root)


if __name__ == "__main__":
    unittest.main()
