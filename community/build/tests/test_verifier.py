"""Small verifier trust-boundary checks, without compilers or application execution."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).parents[1] / "verify_export.py"
spec = importlib.util.spec_from_file_location("source_verifier", SOURCE)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)

class VerifierBoundary(unittest.TestCase):
    def test_first_party_requires_receipt_membership_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "added.ts"
            file.write_text("export const value = 1;\n")
            with self.assertRaisesRegex(AssertionError, "Unbound first-party"):
                verifier.bound_first_party(root, file, {})
            with self.assertRaisesRegex(AssertionError, "First-party input drift"):
                verifier.bound_first_party(root, file, {"added.ts": "0" * 64})
            verifier.bound_first_party(root, file, {"added.ts": verifier.sha(file)})

    def test_first_party_symlink_cannot_hide_as_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            dependency = root / "node_modules" / "dependency.js"
            dependency.parent.mkdir()
            dependency.write_text("export const value = 1;\n")
            link = root / "unbound.js"
            link.symlink_to(dependency)
            with self.assertRaisesRegex(AssertionError, "Unbound first-party"):
                verifier.bound_first_party(root, link, {})

    def test_inventory_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "inventory.json"
            file.write_text(json.dumps({"files": []}))
            with self.assertRaisesRegex(AssertionError, "Restricted inventory drift"):
                verifier.bound_inventory(file, {"inventory_sha256": "0" * 64})

    def test_reused_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = Path(directory) / "gate"
            verifier.require_fresh_prefix(prefix)
            (prefix.parent / "gate-tests.json").write_text("{}")
            with self.assertRaisesRegex(AssertionError, "Fresh evidence"):
                verifier.require_fresh_prefix(prefix)

    def test_optimized_entry_refuses_before_argument_or_child_processing(self):
        result = subprocess.run([sys.executable, "-O", str(SOURCE)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Optimized Python is refused", result.stderr)
