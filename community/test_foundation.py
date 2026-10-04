"""NONBUILDABLE / nonrunnable. Tests use only synthetic temporary repositories."""

import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from export_source import PINNED_OMISSION, STATUS, Refusal, encoded, export, git, sha, tree
from state_policy import COUNTS, classify


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "repo"
        self.source.mkdir()
        self.run_git("init", "-q")
        self.write("src/main.txt", b"Synthetic allowed source\n")
        self.write("LICENSE", b"Synthetic attribution notice\n")
        self.write("proprietary/private.txt", b"SYNTHETIC EXCLUDED IMPLEMENTATION\n")
        self.write(".gitignore", b"ignored.txt\n")
        self.write(".env.production", b"SYNTHETIC EXCLUDED CONFIGURATION\n")
        self.write("node_modules/fake.txt", b"Synthetic dependency\n")
        fixture = self.source / PINNED_OMISSION["path"]
        fixture.parent.mkdir(parents=True)
        fixture.symlink_to("/etc/passwd")
        self.commit()
        self.bind()
        self.dest = self.root / "export"

    def run_git(self, *args):
        return git(self.source, *args)

    def write(self, path, data):
        target = self.source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def commit(self):
        self.run_git("add", "--all")
        self.run_git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid",
                     "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                     "commit", "-qm", "Synthetic fixture")

    def bind(self):
        self.base = self.run_git("rev-parse", "HEAD").decode().strip()
        entries = tree(self.source, self.base)
        self.inventory = {"base": self.base, "files": [
            {"path": p, "git_blob": v["git_blob"],
             "sha256": sha(self.run_git("cat-file", "blob", v["git_blob"]))}
            for p, v in entries.items() if "proprietary" in p.split("/")]}
        self.contract = {"status": STATUS, "version": 1, "base": self.base,
                         "input_tree": self.run_git("rev-parse", "HEAD^{tree}").decode().strip(),
                         "inventory_sha256": sha(encoded(self.inventory)), "overlays": [],
                         "overlays_sha256": sha(encoded([])),
                         "omitted_entries": [dict(PINNED_OMISSION)]}

    def perform(self, destination=None):
        return export(self.source, destination or self.dest, self.base,
                      encoded(self.contract), encoded(self.inventory))

    def refused(self, destination=None):
        target = destination or self.dest
        with self.assertRaises(Refusal):
            self.perform(target)
        self.assertFalse(target.exists())

    def test_valid_deterministic_committed_bytes_and_manifest(self):
        before = self.run_git("status", "--porcelain")
        receipt = self.perform()
        second = self.root / "second"
        self.perform(second)
        def snapshot(root):
            return {str(p.relative_to(root)): p.read_bytes()
                    for p in root.rglob("*") if p.is_file()}
        self.assertEqual(snapshot(self.dest), snapshot(second))
        self.assertEqual(before, self.run_git("status", "--porcelain"))
        self.assertEqual(receipt["status"], STATUS)
        self.assertEqual(receipt["exporter_sha256"], hashlib.sha256(
            Path(__file__).with_name("export_source.py").read_bytes()).hexdigest())
        for row in receipt["files"]:
            data = (self.dest / "source" / row["path"]).read_bytes()
            self.assertEqual(data, self.run_git("cat-file", "blob", row["git_blob"]))
            self.assertEqual(sha(data), row["sha256"])
        self.assertFalse((self.dest / "source/proprietary").exists())
        self.assertFalse((self.dest / "source/node_modules").exists())
        self.assertFalse((self.dest / "source/.env.production").exists())
        self.assertEqual((self.dest / "source/LICENSE").read_bytes(), b"Synthetic attribution notice\n")
        self.assertIn(STATUS, (self.dest / "NONBUILDABLE.txt").read_text())

    def test_exporter_digest_tracks_actual_tool_bytes(self):
        original = self.perform()
        tool_copy = self.root / "export_source.py"
        tool_bytes = Path(__file__).with_name("export_source.py").read_bytes() + b"\n# Synthetic revision\n"
        tool_copy.write_bytes(tool_bytes)
        with patch("export_source.__file__", str(tool_copy)):
            changed = self.perform(self.root / "changed-tool")
        self.assertEqual(changed["exporter_sha256"], hashlib.sha256(tool_bytes).hexdigest())
        self.assertNotEqual(changed["exporter_sha256"], original["exporter_sha256"])
        self.assertEqual({k: v for k, v in changed.items() if k != "exporter_sha256"},
                         {k: v for k, v in original.items() if k != "exporter_sha256"})

    def test_dirty_staged_untracked_ignored_never_leak(self):
        self.write("src/main.txt", b"DIRTY STAGED SECRET\n")
        self.run_git("add", "src/main.txt")
        self.write("src/main.txt", b"DIRTY UNSTAGED SECRET\n")
        self.write("untracked.txt", b"UNTRACKED SECRET\n")
        self.write("ignored.txt", b"IGNORED SECRET\n")
        (self.source / "LICENSE").unlink()
        before = self.run_git("status", "--porcelain")
        self.perform()
        output = b"".join(p.read_bytes() for p in self.dest.rglob("*") if p.is_file())
        self.assertNotIn(b"SECRET", output)
        self.assertTrue((self.dest / "source/LICENSE").exists())
        self.assertEqual(before, self.run_git("status", "--porcelain"))

    def refresh_identities(self):
        self.base = self.run_git("rev-parse", "HEAD").decode().strip()
        self.contract["base"] = self.inventory["base"] = self.base
        self.contract["input_tree"] = self.run_git("rev-parse", "HEAD^{tree}").decode().strip()
        self.contract["inventory_sha256"] = sha(encoded(self.inventory))

    def test_pinned_omission_never_reads_blob_or_working_target(self):
        original_open = Path.open

        def guarded_open(path, *args, **kwargs):
            if path == Path(__file__).with_name("export_source.py"):
                self.assertEqual(args[0] if args else kwargs["mode"], "rb")
                return original_open(path, *args, **kwargs)
            self.assertTrue(path.is_relative_to(self.dest), "Unexpected filesystem read")
            self.assertIn(args[0] if args else kwargs["mode"], ("wb", "xb"))
            return original_open(path, *args, **kwargs)

        def guarded_git(source, *args):
            self.assertNotEqual(args, ("cat-file", "blob", PINNED_OMISSION["git_blob"]))
            return git(source, *args)

        with patch("export_source.git", side_effect=guarded_git), patch.object(
                Path, "open", guarded_open):
            receipt = self.perform()
        self.assertEqual(receipt["omitted_entries"], [PINNED_OMISSION])
        self.assertIn(PINNED_OMISSION, receipt["excluded"])
        target = self.dest / "source" / PINNED_OMISSION["path"]
        self.assertFalse(target.exists() or target.is_symlink())
        self.assertNotIn(PINNED_OMISSION["git_blob"],
                         {row["git_blob"] for row in receipt["files"]})

    def test_pinned_omission_changed_path_blob_mode_or_missing_refused(self):
        fixture = self.source / PINNED_OMISSION["path"]
        for change in ("path", "blob", "mode", "missing"):
            with self.subTest(change=change):
                fixture.unlink()
                renamed = fixture.with_name("renamed")
                if change == "path":
                    renamed.symlink_to("/etc/passwd")
                elif change == "blob":
                    fixture.symlink_to("synthetic-other-target")
                elif change == "mode":
                    fixture.write_bytes(b"/etc/passwd")
                self.commit()
                self.refresh_identities()
                self.refused()
                if renamed.is_symlink():
                    renamed.unlink()
                if fixture.exists() or fixture.is_symlink():
                    fixture.unlink()
                fixture.symlink_to("/etc/passwd")
                self.commit()
                self.bind()

    def test_stale_omitted_entry_contract_identity_refused(self):
        for key in PINNED_OMISSION:
            with self.subTest(key=key):
                self.contract["omitted_entries"] = [{**PINNED_OMISSION, key: "stale"}]
                self.refused()
        for entries in ([], [PINNED_OMISSION, PINNED_OMISSION]):
            self.contract["omitted_entries"] = entries
            self.refused()

    def test_omitted_blob_reintroduced_as_regular_file_refused(self):
        self.write("src/copied-fixture.txt", b"/etc/passwd")
        self.commit()
        self.bind()
        self.refused()

    def test_head_drift(self):
        self.write("new.txt", b"new committed input")
        self.commit()
        self.refused()

    def test_stale_base_tree_inventory_and_patch_hash(self):
        original = copy.deepcopy(self.contract)
        for key in ("base", "input_tree", "inventory_sha256", "overlays_sha256"):
            with self.subTest(key=key):
                self.contract = {**original, key: "0" * len(original[key])}
                self.refused()
        self.contract = original
        self.inventory["base"] = "0" * 40
        self.contract["inventory_sha256"] = sha(encoded(self.inventory))
        self.refused()

    def test_inventory_path_and_blob_drift(self):
        original = copy.deepcopy(self.inventory)
        for key, value in (("path", "proprietary/missing.txt"), ("git_blob", "0" * 40),
                           ("path", "../outside")):
            with self.subTest(key=key, value=value):
                self.inventory = copy.deepcopy(original)
                self.inventory["files"][0][key] = value
                self.contract["inventory_sha256"] = sha(encoded(self.inventory))
                self.refused()

    def test_any_patch_refused_including_restricted_and_escaping_inputs(self):
        for overlay in ({"target": "src/main.txt", "patch_sha256": "0" * 64},
                        {"target": "proprietary/new.txt"},
                        {"input": "proprietary/private.txt", "target": "src/copied.txt"},
                        {"input": "../outside", "target": "src/main.txt"},
                        {"content": "SYNTHETIC EXCLUDED IMPLEMENTATION"}):
            with self.subTest(overlay=overlay):
                self.contract["overlays"] = [overlay]
                self.contract["overlays_sha256"] = sha(encoded([overlay]))
                self.refused()

    def test_restricted_content_renamed_into_allowed_path(self):
        self.write("src/renamed.txt", b"SYNTHETIC EXCLUDED IMPLEMENTATION\n")
        self.commit()
        self.bind()
        self.refused()

    def test_excluded_input_renamed_into_allowed_path(self):
        self.write("src/renamed.txt", b"SYNTHETIC EXCLUDED CONFIGURATION\n")
        self.commit()
        self.bind()
        self.refused()

    def test_destination_traversal_refused(self):
        self.refused(self.root / "unused" / ".." / "escape")

    def test_source_destination_and_existing_destination_refused(self):
        self.refused(self.source / "output")
        self.dest.mkdir()
        marker = self.dest / "untouched"
        marker.write_bytes(b"keep")
        with self.assertRaises(Refusal):
            self.perform()
        self.assertEqual(marker.read_bytes(), b"keep")

    def test_destination_symlink_and_symlink_ancestor(self):
        link = self.root / "link"
        link.symlink_to(self.source, target_is_directory=True)
        self.refused(link / "output")
        self.dest.symlink_to(self.root / "missing")
        with self.assertRaises(Refusal):
            self.perform()
        self.assertFalse((self.root / "missing").exists())

    def test_tracked_symlink_and_gitlink_refused_even_when_excluded(self):
        (self.source / "proprietary/link").symlink_to("../../outside")
        self.commit()
        self.base = self.run_git("rev-parse", "HEAD").decode().strip()
        self.contract["base"] = self.inventory["base"] = self.base
        self.contract["input_tree"] = self.run_git("rev-parse", "HEAD^{tree}").decode().strip()
        self.contract["inventory_sha256"] = sha(encoded(self.inventory))
        self.refused()
        (self.source / "proprietary/link").unlink()
        self.run_git("add", "--all")
        self.run_git("update-index", "--add", "--cacheinfo", "160000," + self.base + ",nested")
        self.run_git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                     "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "gitlink fixture")
        self.base = self.run_git("rev-parse", "HEAD").decode().strip()
        self.contract["base"] = self.inventory["base"] = self.base
        self.contract["input_tree"] = self.run_git("rev-parse", "HEAD^{tree}").decode().strip()
        self.contract["inventory_sha256"] = sha(encoded(self.inventory))
        self.refused()

    def test_unsafe_tracked_path(self):
        self.write("src/back\\slash.txt", b"unsafe")
        self.commit()
        self.base = self.run_git("rev-parse", "HEAD").decode().strip()
        self.contract["base"] = self.inventory["base"] = self.base
        self.contract["input_tree"] = self.run_git("rev-parse", "HEAD^{tree}").decode().strip()
        self.contract["inventory_sha256"] = sha(encoded(self.inventory))
        self.refused()

    def test_nonfull_revision_refused(self):
        for base in ("HEAD", self.base[:12], "--all", "0" * 40):
            with self.subTest(base=base):
                old = self.base
                self.base = base
                self.refused()
                self.base = old


class StateTests(unittest.TestCase):
    def state(self):
        return {"complete": True, "database_kind": "new", **dict.fromkeys(COUNTS, 0)}

    def test_complete_empty_is_candidate_without_authority(self):
        state = self.state()
        result = classify(state)
        self.assertEqual(result.classification, "NEW_EMPTY_CANDIDATE")
        self.assertFalse(result.migration_authorized)
        self.assertFalse(result.runtime_authorized)
        self.assertEqual(state, self.state())

    def test_unknown_missing_extra_and_invalid_counts_refuse(self):
        for state in (None, {}, {**self.state(), "complete": False},
                      {**self.state(), "database_kind": "unknown"},
                      {**self.state(), "unexpected": 0}):
            self.assertEqual(classify(state).classification, "REFUSE_UNKNOWN")
        for key in COUNTS:
            for value in (None, True, -1, "0", 0.0):
                self.assertEqual(classify({**self.state(), key: value}).classification, "REFUSE_UNKNOWN")
            state = self.state()
            del state[key]
            self.assertEqual(classify(state).classification, "REFUSE_UNKNOWN")

    def test_every_incompatible_feature_refuses(self):
        for key in COUNTS[2:]:
            for kind in ("new", "existing"):
                with self.subTest(key=key, kind=kind):
                    result = classify({**self.state(), "database_kind": kind, key: 1})
                    self.assertEqual(result.classification, "REFUSE_INCOMPATIBLE")
                    self.assertFalse(result.migration_authorized or result.runtime_authorized)

    def test_existing_and_partial_refuse(self):
        self.assertEqual(classify({**self.state(), "database_kind": "existing"}).classification,
                         "REFUSE_EXISTING")
        for key in COUNTS[:2]:
            self.assertEqual(classify({**self.state(), key: 1}).classification, "REFUSE_PARTIAL")


if __name__ == "__main__":
    unittest.main()
