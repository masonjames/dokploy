"""Committed-input exporter gates, using metadata-only fault injection."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("build_exporter", Path(__file__).parents[1] / "export_source.py")
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)
ROOT = Path(__file__).resolve().parents[3]
OVERLAYS = Path(os.environ.get("COMMUNITY_OVERLAY_SOURCE", "/private/tmp/hostler-auth-build-overlay-revisions"))
REVISION = os.environ.get("COMMUNITY_OVERLAY_REVISION")

@unittest.skipUnless(REVISION, "An explicit committed overlay revision is required")
class ExportTests(unittest.TestCase):
 def setUp(self):
  self.temp = tempfile.TemporaryDirectory(dir="/private/tmp", prefix="community-export-test-")
  self.addCleanup(self.temp.cleanup)
  self.destination = Path(self.temp.name) / "export"
 def run_export(self):
  return exporter.export(ROOT, self.destination, OVERLAYS, REVISION)
 def test_deterministic(self):
  first = self.run_export()
  self.destination = self.destination.with_name("second")
  second = self.run_export()
  self.assertEqual(first, second)
  self.assertTrue(all("proprietary" not in Path(row["path"]).parts for row in first["files"]))
  self.assertFalse(first["runtime"])
 def test_materialized_modes(self):
  receipt = self.run_export()
  executables = 0
  for entry in receipt["files"]:
   mode = (self.destination / "source" / entry["path"]).stat().st_mode & 0o777
   self.assertEqual(mode, int(entry["export_mode"], 8) & 0o777)
   if entry["mode"] == "100755":
    executables += 1
    self.assertEqual(mode, 0o755)
  self.assertGreater(executables, 0)
 def test_uncommitted_overlay_refused_before_output(self):
  isolated = Path(self.temp.name) / "overlay"
  subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(OVERLAYS), str(isolated)], check=True)
  subprocess.run(["git", "-C", str(isolated), "checkout", "--quiet", "--detach", REVISION], check=True)
  with (isolated / "community/build/qualification.md").open("a") as dirty:
   dirty.write("\nUncommitted synthetic change\n")
  with self.assertRaisesRegex(exporter.Refusal, "Dirty/untracked"):
   exporter.export(ROOT, self.destination, isolated, REVISION)
  self.assertFalse(self.destination.exists())
 def test_mismatched_exporter_revision_before_output(self):
  # The preserved initial candidate is a real committed, clean, different exporter.
  with self.assertRaisesRegex(exporter.Refusal, "Exporter revision drift"):
   exporter.export(ROOT, self.destination, OVERLAYS, "8119868293b60faea5970edbe1872c3c13cc3b27")
  self.assertFalse(self.destination.exists())
 def test_dirty_target(self):
  self.destination.mkdir()
  with self.assertRaisesRegex(exporter.Refusal, "fresh"):
   self.run_export()
 def fault(self, mutate, message):
  original = exporter.git
  manifest = json.loads(original(OVERLAYS, "show", REVISION + ":community/build/overlays/manifest.json"))
  contract = json.loads(original(OVERLAYS, "show", REVISION + ":community/build/export-contract.json"))
  mutate(manifest, contract)
  manifest_bytes = exporter.encoded(manifest)
  contract["manifest_sha256"] = exporter.sha(manifest_bytes)
  def git(source, *args):
   if args == ("show", REVISION + ":community/build/overlays/manifest.json"): return manifest_bytes
   if args == ("show", REVISION + ":community/build/export-contract.json"): return exporter.encoded(contract)
   return original(source, *args)
  with patch.object(exporter, "git", git), self.assertRaisesRegex(exporter.Refusal, message): self.run_export()
  self.assertFalse(self.destination.exists())
 def test_source_tree_drift(self):
  self.fault(lambda m,c: c.update(input_tree="0"*40), "Source tree drift")
 def test_original_blob_drift(self):
  def mutate(m,c):
   op = next(o for o in m["operations"] if o["operation"] == "replace")
   op["before"]["git_blob"] = "0"*40
  self.fault(mutate, "Original identity drift")
 def test_payload_drift(self):
  self.fault(lambda m,c: next(o for o in m["operations"] if "payload" in o).update(after_sha256="0"*64), "Payload drift")
 def test_restricted_destination(self):
  self.fault(lambda m,c: m["operations"][0].update(path="packages/server/src/services/proprietary/copy.ts"), "Unsafe/duplicate")
 def test_duplicate_target(self):
  self.fault(lambda m,c: m["operations"].append(m["operations"][0]), "Unsafe/duplicate")
 def test_arbitrary_payload(self):
  self.fault(lambda m,c: next(o for o in m["operations"] if "payload" in o).update(payload="apps/dokploy/pages/index.tsx"), "Unexpected input")
 def test_nonregular_payload(self):
  original = exporter.git
  def git(source, *args):
   result = original(source, *args)
   if args and args[0] == "ls-tree" and args[-1].endswith(".payload"): return result.replace(b"100644", b"120000", 1)
   return result
  with patch.object(exporter, "git", git), self.assertRaisesRegex(exporter.Refusal, "nonregular"):
   self.run_export()
 def test_untracked_overlay_input(self):
  original = exporter.git
  def git(source, *args):
   if args and args[0] == "status": return b"?? arbitrary.payload\n"
   return original(source, *args)
  with patch.object(exporter, "git", git), self.assertRaisesRegex(exporter.Refusal, "Dirty/untracked"):
   self.run_export()
 def test_runtime_authority_refused(self):
  self.fault(lambda m,c: c.update(runtime=True), "Runtime authority")

if __name__ == "__main__": unittest.main()
