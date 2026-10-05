"""UNQUALIFIED / nonrunnable: source-only build export; derived from the preserved legacy exporter."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

STATUS = "UNQUALIFIED / nonrunnable"
PINNED_OMISSION = {
    "path": "apps/dokploy/__test__/drop/zips/payload/link",
    "mode": "120000",
    "kind": "blob",
    "git_blob": "3594e94c04db171e2767224db355f514b13715c5",
    "reason": "Tracked test fixture symlink; never read, follow or materialize",
}
NOTICE = (STATUS + " until separate source closure, compiler/build/content evidence "
          "and runtime qualification. No migration, production or legal authority.\n")
EXCLUDED = frozenset({"proprietary", ".git", ".claude", ".codex", ".agents",
                      "node_modules", "dist", ".next", ".worktrees", "community"})


class Refusal(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def git(source, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1",
               GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(source), *args],
                            env=env, capture_output=True, check=False)
    require(result.returncode == 0, "Git identity/object read failed")
    return result.stdout


def safe_path(value):
    require(isinstance(value, str) and bool(value), "Missing path")
    parts = value.split("/")
    require(all(re.fullmatch(r"[A-Za-z0-9_.@+()\[\] -]+", p)
                and p not in {".", ".."} and not p.endswith((".", " "))
                for p in parts), "Unsafe path: " + value)
    return parts


def excluded(path):
    return any(p.lower() in EXCLUDED or p.lower().startswith(".env")
               for p in safe_path(path))


def tree(source, base):
    entries = {}
    folded = set()
    for record in git(source, "ls-tree", "-rz", "--full-tree", base).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        try:
            path = raw_path.decode("ascii")
        except UnicodeDecodeError as error:
            raise Refusal("Nonportable path") from error
        safe_path(path)
        entry = {"mode": mode, "kind": kind, "git_blob": oid}
        if path == PINNED_OMISSION["path"]:
            require({"path": path, **entry, "reason": PINNED_OMISSION["reason"]}
                    == PINNED_OMISSION, "Pinned omitted-entry identity drift")
        else:
            require(mode in {"100644", "100755"} and kind == "blob",
                    "Symlink/gitlink/nonregular entry refused: " + path)
        require(path.lower() not in folded, "Case-colliding path")
        folded.add(path.lower())
        entries[path] = entry
    require(PINNED_OMISSION["path"] in entries, "Missing pinned omitted entry")
    # Also reject directory case collisions on case-insensitive destinations.
    prefixes = {}
    for path in entries:
        parts = path.split("/")
        for n in range(1, len(parts) + 1):
            prefix = "/".join(parts[:n])
            require(prefixes.setdefault(prefix.lower(), prefix) == prefix,
                    "Case-colliding directory")
    return entries


def destination_path(source, destination):
    require(".." not in Path(destination).parts, "Destination traversal refused")
    destination = Path(os.path.abspath(destination))
    require(not destination.exists() and not destination.is_symlink(),
            "Destination must be fresh")
    for parent in destination.parents:
        require(not parent.is_symlink(), "Destination has symlink ancestor")
    require(destination.parent.is_dir(), "Destination parent must exist")
    require(not destination.is_relative_to(source), "Destination inside source checkout")
    # Do not export into another checkout either (including linked worktrees).
    require(not any((p / ".git").exists() for p in destination.parents),
            "Destination inside a checkout")
    return destination


def export(source, destination, overlay_source, revision):
    source = Path(source).resolve(strict=True)
    overlay_source = Path(overlay_source).resolve(strict=True)
    require(not git(overlay_source, "status", "--porcelain", "--untracked-files=all").strip(), "Dirty/untracked overlay inputs")
    require(re.fullmatch(r"[0-9a-f]{40}", revision), "Full overlay commit required")
    require(git(overlay_source, "cat-file", "-t", revision).strip() == b"commit", "Overlay must be committed")
    def overlay(path):
        safe_path(path)
        require(path.startswith("community/build/"), "Overlay outside build boundary")
        mode = git(overlay_source, "ls-tree", revision, "--", path).decode().split()
        require(mode and mode[0] == "100644" and mode[1] == "blob", "Missing/nonregular overlay")
        return git(overlay_source, "show", revision + ":" + path)
    require(sha(overlay("community/build/export_source.py")) == sha(Path(__file__).read_bytes()), "Exporter revision drift")
    contract_bytes = overlay("community/build/export-contract.json")
    contract = json.loads(contract_bytes)
    require(contract["version"] == "community-build-export/1", "Wrong contract")
    require(set(contract) == {"version", "base", "input_tree", "inventory_sha256", "manifest_sha256", "startup", "admission", "runtime"}, "Unknown contract fields")
    require(all(contract[key] is False for key in ("startup", "admission", "runtime")), "Runtime authority refused")
    base = contract["base"]
    require(re.fullmatch(r"[0-9a-f]{40}", base), "Full source base required")
    require(git(source, "rev-parse", base + "^{tree}").decode().strip() == contract["input_tree"], "Source tree drift")
    for changed in git(source, "diff", "--name-only", base).decode().splitlines() + git(source, "ls-files", "--others", "--exclude-standard").decode().splitlines():
        require(changed.startswith("community/build/"), "Extra/modified source input: " + changed)
    inventory_bytes = overlay("community/build/restricted-inventory.json")
    manifest_bytes = overlay("community/build/overlays/manifest.json")
    require(sha(inventory_bytes) == contract["inventory_sha256"], "Inventory drift")
    require(sha(manifest_bytes) == contract["manifest_sha256"], "Manifest drift")
    inventory = json.loads(inventory_bytes)
    manifest = json.loads(manifest_bytes)
    require(inventory["base"] == base and inventory["input_tree"] == contract["input_tree"], "Stale inventory")
    entries = tree(source, base)
    restricted = {p: e["git_blob"] for p, e in entries.items() if "proprietary" in p.lower().split("/")}
    require({v["path"]: v["git_blob"] for v in inventory["files"]} == restricted, "Restricted inventory drift")
    require(len(inventory["files"]) == len(restricted), "Duplicate inventory entries")
    hashes = {v["sha256"] for v in inventory["files"]}
    excluded_oids = {e["git_blob"] for p, e in entries.items() if excluded(p) or p == PINNED_OMISSION["path"]}
    blobs = {}; provenance = {}; omissions = []
    for path, entry in sorted(entries.items()):
        if excluded(path) or path == PINNED_OMISSION["path"]:
            omissions.append({"path": path, **entry}); continue
        require(entry["git_blob"] not in excluded_oids, "Excluded blob rename")
        data = git(source, "cat-file", "blob", entry["git_blob"])
        require(sha(data) not in hashes, "Restricted hash copy")
        blobs[path] = data
        provenance[path] = {"source": base, **entry, "sha256": sha(data)}
    targets = set(); payloads = set()
    for op in manifest["operations"]:
        path = op["path"]; safe_path(path)
        require(not excluded(path) and path not in targets, "Unsafe/duplicate overlay destination")
        targets.add(path)
        require(bool(op["provenance"]), "Missing provenance")
        if op["operation"] == "add":
            require(path not in entries and op["before"] is None, "Add collision")
        else:
            require(path in blobs and op["before"] == {**entries[path], "sha256": sha(blobs[path])}, "Original identity drift")
        if op["operation"] == "omit":
            del blobs[path]; del provenance[path]; omissions.append(op); continue
        require(op["operation"] in {"add", "replace"}, "Unsupported overlay operation")
        payload = op["payload"]
        require(payload.startswith("community/build/overlays/files/") and payload.endswith(".payload"), "Unexpected input")
        require(payload not in payloads, "Reused payload")
        payloads.add(payload)
        data = overlay(payload)
        require(sha(data) == op["after_sha256"] and sha(data) not in hashes, "Payload drift/restricted copy")
        oid = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        require(oid not in excluded_oids, "Excluded blob copied into overlay")
        require(op["mode"] == "100644", "Unexpected output mode")
        blobs[path] = data
        provenance[path] = {"overlay_revision": revision, "payload": payload, "mode": op["mode"], "sha256": sha(data), "provenance": op["provenance"]}
    committed_payloads = set(git(overlay_source, "ls-tree", "-r", "--name-only", revision, "--", "community/build/overlays/files").decode().splitlines())
    require(payloads == committed_payloads, "Extra/missing overlay inputs")
    prefixes = {}; files = set(blobs)
    for path in blobs:
        parts = safe_path(path)
        for n in range(1, len(parts)+1):
            prefix = "/".join(parts[:n])
            require(prefixes.setdefault(prefix.lower(), prefix) == prefix, "Output case collision")
            require(n == len(parts) or prefix not in files, "Output file/directory collision")
    destination = destination_path(source, destination)
    receipt = {"status": STATUS, "startup": False, "admission": False, "runtime": False,
               "base": base, "input_tree": contract["input_tree"], "overlay_revision": revision,
               "contract_sha256": sha(contract_bytes), "inventory_sha256": sha(inventory_bytes),
               "manifest_sha256": sha(manifest_bytes), "pg18_contract_sha256": manifest["pg18_contract_sha256"], "pg18_runner_sha256": sha(overlay("community/build/pg18_fixture.py")), "counted_test_contract_sha256": manifest["counted_test_contract_sha256"], "root_oracle_sha256": manifest["root_oracle_sha256"], "exporter_sha256": sha(Path(__file__).read_bytes()),
               "files": [{"path": p, **provenance[p], "export_mode": provenance[p]["mode"]} for p in sorted(blobs)], "omissions": omissions}
    destination.mkdir(mode=0o700)
    for path, data in blobs.items():
        target = destination / "source" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as handle: handle.write(data)
        target.chmod(int(provenance[path]["mode"], 8) & 0o777)
    (destination / "receipt.json").write_bytes(encoded(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=NOTICE)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--overlay-source", type=Path, required=True)
    parser.add_argument("--overlay-revision", required=True)
    args = parser.parse_args()
    try:
        export(args.source, args.destination, args.overlay_source, args.overlay_revision)
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, "REFUSED: " + str(error) + "\n")
    print(NOTICE, end="")

if __name__ == "__main__": main()
