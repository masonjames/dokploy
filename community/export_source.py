"""NONBUILDABLE / nonrunnable: committed-source inspection export only."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

STATUS = "NONBUILDABLE / nonrunnable"
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


def export(source, destination, base, contract_bytes, inventory_bytes):
    """Validate everything before creating destination; never inspect working files."""
    source = Path(source).resolve(strict=True)
    require(Path(git(source, "rev-parse", "--show-toplevel").decode().strip()).resolve()
            == source, "Source must be checkout root")
    require(isinstance(base, str) and re.fullmatch(r"[0-9a-f]{40}", base),
            "Require full SHA-1 commit identity")
    require(git(source, "rev-parse", "HEAD").decode().strip() == base, "Source/base drift")
    require(git(source, "cat-file", "-t", base).strip() == b"commit", "Base is not commit")
    contract = json.loads(contract_bytes)
    inventory = json.loads(inventory_bytes)
    require(set(contract) == {"status", "version", "base", "input_tree",
                             "inventory_sha256", "overlays", "overlays_sha256", "omitted_entries"},
            "Unknown/incomplete contract")
    require(contract["version"] == 1 and contract["status"] == STATUS, "Wrong contract version/status")
    require(contract["base"] == base == inventory["base"], "Stale contract/inventory base")
    require(contract["input_tree"] == git(source, "rev-parse", base + "^{tree}").decode().strip(),
            "Stale input tree identity")
    require(contract["inventory_sha256"] == sha(inventory_bytes), "Stale inventory identity")
    require(contract["overlays_sha256"] == sha(encoded(contract["overlays"])),
            "Stale patch identity")
    require(contract["overlays"] == [], "All nonempty patches/inputs refused in version 1")
    require(contract["omitted_entries"] == [PINNED_OMISSION],
            "Stale/unreviewed omitted-entry contract identity")
    entries = tree(source, base)
    restricted = {p: v for p, v in entries.items() if "proprietary" in p.lower().split("/")}
    records = inventory["files"]
    require(isinstance(records, list), "Invalid inventory")
    expected = {}
    for row in records:
        require(set(row) == {"path", "git_blob", "sha256"}, "Invalid inventory entry")
        path = row["path"]
        safe_path(path)
        require(path not in expected and path in restricted, "Unexpected/duplicate restricted path")
        require(re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is not None, "Invalid evidence hash")
        expected[path] = row["git_blob"]
    require(expected == {p: v["git_blob"] for p, v in restricted.items()},
            "Restricted inventory drift")
    excluded_oids = {v["git_blob"] for p, v in entries.items() if excluded(p) or p == PINNED_OMISSION["path"]}
    restricted_hashes = {r["sha256"] for r in records}
    blobs = {}
    receipt_files = []
    omissions = []
    for path, entry in sorted(entries.items()):
        if path == PINNED_OMISSION["path"]:
            omissions.append(dict(PINNED_OMISSION))
            continue
        if excluded(path):
            omissions.append({"path": path, **entry})
            continue
        require(entry["git_blob"] not in excluded_oids, "Excluded blob reintroduced: " + path)
        data = git(source, "cat-file", "blob", entry["git_blob"])
        require(sha(data) not in restricted_hashes, "Restricted content reintroduced: " + path)
        blobs[path] = data
        receipt_files.append({"path": path, **entry, "sha256": sha(data), "export_mode": "0644"})
    destination = destination_path(source, destination)
    require(git(source, "rev-parse", "HEAD").decode().strip() == base, "Source/base drift")
    receipt = {"status": STATUS, "notice": NOTICE.strip(), "base": base,
               "input_tree": contract["input_tree"], "contract_sha256": sha(contract_bytes),
               "inventory_sha256": sha(inventory_bytes), "overlays": [],
               "exporter_sha256": sha(Path(__file__).read_bytes()),
               "omitted_entries": [dict(PINNED_OMISSION)],
               "dirty_source_policy": "Ignore working tree and index; exact committed blobs only",
               "files": receipt_files, "excluded": omissions}
    destination.mkdir(mode=0o700)
    (destination / "NONBUILDABLE.txt").write_bytes(NOTICE.encode())
    (destination / "receipt.json").write_bytes(encoded(receipt))
    for path, data in blobs.items():
        target = destination / "source" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
        target.chmod(0o644)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=NOTICE)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--base", required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    try:
        export(args.source, args.destination, args.base,
               (here / "export-contract.json").read_bytes(),
               (here / "restricted-inventory.json").read_bytes())
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, STATUS + ": REFUSED: " + str(error) + "\n")
    print(NOTICE, end="")


if __name__ == "__main__":
    main()
