"""Source-only byte and dependency separation checks; no application imports."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
ROOT = Path(__file__).resolve().parents[3]
class Preservation(unittest.TestCase):
 def test_pinned_bytes(self):
  for entry in json.loads((Path(__file__).parent / "preservation-before.json").read_text())["preserved"]:
   self.assertEqual(hashlib.sha256((ROOT / entry["path"]).read_bytes()).hexdigest(), entry["sha256"], entry["path"])
 def test_maintained_and_legacy_bytes(self):
  diff = subprocess.check_output(["git", "-C", str(ROOT), "diff", "--name-only", "aebf69526ed168e985f50f9a973a85ea1f7519f9"]).decode().splitlines()
  self.assertTrue(all(p.startswith("community/build/") for p in diff), diff)
 def test_writer_dependencies(self):
  paths = ["prestate_boundary", "observation_connector", "observe_entry", "state_observation", "state_policy", "pg18_fixture_tests", "export_source"]
  for name in paths:
   text = (ROOT / "community" / (name + ".py")).read_text()
   tree = ast.parse(text)
   for node in ast.walk(tree):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
     self.assertNotIn("audit", ast.unparse(node))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {"run", "Popen", "check_output"}:
     self.assertNotIn("audit", ast.unparse(node))
   self.assertNotIn("api/utils/audit", text)
if __name__ == "__main__": unittest.main()
