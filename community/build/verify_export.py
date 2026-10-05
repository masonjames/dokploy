"""Source-only compiler/test evidence for an already offline-installed fresh export."""
import sys
if sys.flags.optimize:
    raise SystemExit("Optimized Python is refused")
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


NODE = "/opt/homebrew/opt/node@24/bin/node"
def require_fresh_prefix(prefix):
    path = Path(prefix)
    assert not path.exists() and not list(path.parent.glob(path.name + "-*")), "Fresh evidence prefix required"

def bound_first_party(root, path, files):
    real = path.resolve(strict=True)
    assert real.is_relative_to(root), "Input escape"
    for candidate in (path.absolute(), real):
        assert candidate.is_relative_to(root), "Input escape"
        rel = candidate.relative_to(root)
        if "node_modules" not in rel.parts:
            assert str(rel) in files, "Unbound first-party input: " + str(rel)
            assert sha(candidate) == files[str(rel)], "First-party input drift: " + str(rel)

def bound_inventory(path, receipt):
    assert sha(path) == receipt["inventory_sha256"], "Restricted inventory drift"
    return json.loads(path.read_text())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--evidence-prefix", type=Path, required=True)
    args = parser.parse_args()
    root = (args.export / "source").resolve()
    prefix = str(args.evidence_prefix)
    require_fresh_prefix(prefix)
    receipt = json.loads((args.export / "receipt.json").read_text())
    inventory = bound_inventory(Path(__file__).parent / "restricted-inventory.json", receipt)
    files = {entry["path"]: entry["sha256"] for entry in receipt["files"]}
    assert sha(Path(__file__).parent / "test-contract.json") == receipt["counted_test_contract_sha256"]
    assert sha(Path(__file__).parent / "pg18-contract.json") == receipt["pg18_contract_sha256"]
    restricted_hashes = {entry["sha256"] for entry in inventory["files"]}
    for entry in receipt["files"]:
        assert sha(root / entry["path"]) == entry["sha256"], entry["path"]
        assert (root / entry["path"]).stat().st_mode & 0o777 == (int(entry["export_mode"], 8) & 0o777), entry["path"]
    for entry in inventory["files"]:
        assert not (root / entry["path"]).exists(), entry["path"]
    for link in root.rglob("node_modules"):
        assert link.resolve().is_relative_to(root), str(link)
    home = Path(tempfile.mkdtemp(prefix="community-source-home-", dir="/private/tmp"))
    home.chmod(0o700)
    child_env = {"PATH": "/opt/homebrew/opt/node@24/bin:/usr/bin:/bin", "LC_ALL": "C", "HOME": str(home), "TMPDIR": str(home), "NODE_ENV": "test"}
    results = []
    def run(name, command, cwd=root, env=None):
        log = Path(prefix + "-" + name + ".log")
        with log.open("x") as output:
            result = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, env=child_env if env is None else env)
        record = {"name": name, "command": command, "cwd": str(cwd), "exit_status": result.returncode, "log": str(log), "log_sha256": sha(log)}
        results.append(record)
        return record, log
    compiler = root / "packages/server/node_modules/typescript/bin/tsc"
    run("compiler-identity", [NODE, str(compiler), "--version"])
    for name, project in [("server", "packages/server/tsconfig.server.json"), ("app", "apps/dokploy/tsconfig.json"), ("api", "apps/api/tsconfig.json"), ("schedules", "apps/schedules/tsconfig.json")]:
        executable = "apps/dokploy/node_modules/typescript/bin/tsc" if name == "app" else "packages/server/node_modules/typescript/bin/tsc"
        run(name + "-config", [NODE, executable, "--project", project, "--showConfig"])
        record, log = run(name + "-tsc", [NODE, executable, "--project", project, "--noEmit", "--incremental", "false", "--pretty", "false", "--listFiles", "--traceResolution"])
        text = log.read_text()
        inputs = {Path(line) for line in text.splitlines() if line.startswith("/") and Path(line).is_file()}
        resolutions = {Path(p) for p in re.findall(r"successfully resolved to '([^']+)'", text)}
        graph = []
        for path in sorted(inputs | resolutions):
            if not path.is_absolute():
                raise AssertionError("Unexpected compiler resolution: " + str(path))
            real = path.resolve(strict=True)
            assert real.is_relative_to(root), str(real)
            assert "proprietary" not in real.parts, str(real)
            bound_first_party(root, path, files)
            digest = sha(real)
            assert digest not in restricted_hashes, str(real)
            graph.append({"path": str(path), "realpath": str(real), "sha256": digest, "compiler_input": path in inputs, "successful_resolution": path in resolutions})
        graph_path = Path(prefix + "-" + name + "-graph.json")
        graph_path.write_text(json.dumps(graph, indent=2) + "\n")
        record.update(inputs=len(inputs), successful_resolutions=len(resolutions), graph=str(graph_path), graph_sha256=sha(graph_path), restricted_inputs=0, escaped_inputs=0)
    env = {**child_env, "COMMUNITY_TEST_GRAPH": prefix + "-test-resolution.json", "COMMUNITY_ROUTE_RECEIPT": prefix + "-auth-routes.json"}
    run("tests", [NODE, "node_modules/vitest/vitest.mjs", "run", "--config", "__test__/community-auth/vitest.config.ts", "--reporter=json", "--outputFile=" + prefix + "-tests.json"], root / "apps/dokploy", env)
    tests_path = Path(prefix + "-tests.json")
    if tests_path.exists():
        tests = json.loads(tests_path.read_text())
        counted = []
        for result in tests["testResults"]:
            path = Path(result["name"]).resolve(strict=True)
            assert path.is_relative_to(root)
            bound_first_party(root, path, files)
            assert not re.search(r"vi\.mock\([^\n]*proprietary", path.read_text()), str(path)
            counted.append({"path": str(path.relative_to(root)), "sha256": sha(path), "tests": len(result["assertionResults"]), "status": result["status"]})
        Path(prefix + "-counted-tests.json").write_text(json.dumps(counted, indent=2) + "\n")
    test_graph_path = Path(prefix + "-test-resolution.json")
    test_graph = json.loads(test_graph_path.read_text())
    assert test_graph, "Empty test resolution graph"
    test_inputs = []
    classifications = []
    builtins = set(json.loads(subprocess.check_output([NODE, "-e", "console.log(JSON.stringify(require('node:module').builtinModules))"], text=True, env=child_env)))
    for entry in test_graph:
        resolved = entry["resolved"]
        source = entry["source"]
        importer = entry.get("importer")
        if importer == str(root / "apps/dokploy/index.html") and not Path(importer).exists():
            # Vite's documented-in-installed-source default importer for entry
            # resolution is synthetic; permit it only for actually counted tests.
            assert resolved and Path(resolved).resolve(strict=True) in {root / item["path"] for item in counted}
            entry["importer_classification"] = "vite-counted-test-entry-placeholder"
        elif importer and importer.startswith("/"):
            imported_by = Path(importer.split("?", 1)[0]).resolve(strict=True)
            assert imported_by.is_file() and imported_by.is_relative_to(root), str(imported_by)
            assert "proprietary" not in imported_by.parts, str(imported_by)
            bound_first_party(root, Path(importer.split("?", 1)[0]), files)
            importer_digest = sha(imported_by)
            assert importer_digest not in restricted_hashes
            test_inputs.append({"path": importer, "realpath": str(imported_by), "sha256": importer_digest, "role": "importer"})
        if source.removeprefix("node:") in builtins or source in builtins:
            classifications.append({**entry, "classification": "builtin"})
            continue
        assert resolved is not None, "Unresolved test graph entry: " + source
        if resolved.startswith("\0") or resolved.startswith("virtual:"):
            classifications.append({**entry, "classification": "virtual"})
            continue
        path = Path(resolved.split("?", 1)[0])
        assert path.is_absolute() and path.is_file(), "Unclassified non-file resolution: " + resolved
        real = path.resolve(strict=True)
        assert real.is_relative_to(root), str(real)
        assert "proprietary" not in real.parts, str(real)
        bound_first_party(root, path, files)
        digest = sha(real)
        assert digest not in restricted_hashes
        test_inputs.append({"path": str(path), "realpath": str(real), "sha256": digest})
        classifications.append({**entry, "classification": "file", "realpath": str(real), "sha256": digest})
    assert test_inputs, "No resolved test files"
    Path(prefix + "-test-inputs.json").write_text(json.dumps(test_inputs, indent=2) + "\n")
    classification_path = Path(prefix + "-test-resolution-classified.json")
    classification_path.write_text(json.dumps(classifications, indent=2) + "\n")
    bound = {}
    for suffix in ("tests.json", "counted-tests.json", "auth-routes.json", "test-resolution.json", "test-inputs.json", "test-resolution-classified.json"):
        artifact = Path(prefix + "-" + suffix)
        bound[suffix] = {"path": str(artifact), "sha256": sha(artifact)}
    replacements = Path(__file__).parent / "test-contract.json"
    bound["test-contract.json"] = {"path": str(replacements), "sha256": sha(replacements)}
    libraries = {}
    for name in ("better-auth", "drizzle-orm", "postgres", "bcrypt"):
        directory = (root / "packages/server/node_modules" / name).resolve(strict=True)
        assert directory.is_relative_to(root)
        libraries[name] = {"version": json.loads((directory / "package.json").read_text())["version"], "package_sha256": sha(directory / "package.json")}
    native = (root / "packages/server/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node").resolve(strict=True)
    assert native.is_relative_to(root)
    libraries["bcrypt"]["native_sha256"] = sha(native)
    libraries["bcrypt"]["configuration_sha256"] = sha(root / "packages/server/src/lib/community-password.ts")
    node = Path(NODE).resolve(strict=True)
    node_version = subprocess.check_output([str(node), "--version"], text=True, env=child_env).strip()
    assert node_version == "v24.21.0"
    assert (Path(prefix + "-compiler-identity.log").read_text().strip() == "Version 7.0.2")
    compiler_binary = Path(subprocess.check_output([
        str(node), "--input-type=module", "-e",
        "import {pathToFileURL} from 'node:url'; const m = await import(pathToFileURL(process.argv[1])); console.log(m.default());",
        str(compiler.resolve().parents[1] / "lib/getExePath.js"),
    ], text=True, env=child_env).strip()).resolve(strict=True)
    assert compiler_binary.is_relative_to(root)
    record = {"child_environment": {"home": str(home), "keys": sorted(child_env), "path": child_env["PATH"], "ambient_inherited": False}, "compiler_binary": {"path": str(compiler_binary), "sha256": sha(compiler_binary)}, "libraries": libraries, "node": {"version": node_version, "sha256": sha(node)}, "verifier_sha256": sha(Path(__file__)), "bound_artifacts": bound, "tests": {k: tests[k] for k in ("numTotalTests", "numPassedTests", "numFailedTests", "success")}, "replacements": json.loads(replacements.read_text()), "source_base": receipt["base"], "source_tree": receipt["input_tree"], "overlay_revision": receipt["overlay_revision"], "export_receipt_sha256": sha(args.export / "receipt.json"), "compiler_entry_sha256": sha(compiler.resolve()), "lock_sha256": sha(root / "pnpm-lock.yaml"), "startup": False, "admission": False, "runtime": False, "gates": results}
    Path(prefix + "-qualification.json").write_text(json.dumps(record, indent=2) + "\n")
    raise SystemExit(0 if all(r["exit_status"] == 0 for r in results) else 1)

if __name__ == "__main__": main()
