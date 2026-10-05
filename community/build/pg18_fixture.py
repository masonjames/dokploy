"""Opt-in parent dispatch only. Fresh synthetic PG18, private Unix socket, no TCP."""
import sys
if sys.flags.optimize:
    raise SystemExit("Optimized Python is refused")
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time

ORACLE = "40116667785c6ea8d1bc32f4df97148dc21adef33f3df66b97b9de017e7825a8"
PG = Path("/opt/homebrew/opt/postgresql@18/bin")
NODE = Path("/opt/homebrew/opt/node@24/bin/node")
BUILD = Path(__file__).resolve().parent

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def identity(path):
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700, "Owned directory identity refused")
    return {"device": s.st_dev, "inode": s.st_ino, "uid": s.st_uid, "mode": stat.S_IMODE(s.st_mode)}

def group_stopped(child):
    # Probe only: a departed leader never authorizes signalling a stale group.
    deadline = time.monotonic() + 2
    while True:
        if child.poll() is not None:
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(.05)

def interrupted(state):
    if state["launching"]:
        state["pending"] = True
    else:
        raise KeyboardInterrupt()

def launch_owned(command, cwd, env, children, entry, interrupt):
    # Defer Python handler delivery, not OS signals inherited by the child.
    interrupt["launching"] = True
    try:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        capture = bytearray()
        digest = hashlib.sha256()
        size = [0]
        def drain():
            try:
                while block := child.stdout.read(65536):
                    digest.update(block)
                    size[0] += len(block)
                    capture.extend(block[:max(0, 256 - len(capture))])
            finally:
                child.stdout.close()
        thread = threading.Thread(target=drain, daemon=True)
        item = (child, entry, thread, digest, size, capture)
        children.append(item)
        entry.update(pid=child.pid, pgid=child.pid)
        thread.start()
    finally:
        interrupt["launching"] = False
        if interrupt["pending"]:
            interrupt["pending"] = False
            raise KeyboardInterrupt()
    return item

def library_identities(root):
    libraries = {}
    for context in ("apps/dokploy", "packages/server"):
        libraries[context] = {}
        for name in ("better-auth", "drizzle-orm", "postgres", "bcrypt"):
            resolver = root / context / "node_modules" / name
            directory = resolver.resolve(strict=True)
            require(directory.is_relative_to(root) and directory.is_dir(), "Library escape")
            files = {}
            for path in sorted(directory.rglob("*")):
                if "node_modules" in path.relative_to(directory).parts or not path.is_file():
                    continue
                require(path.resolve(strict=True).is_relative_to(root), "Library file escape")
                files[str(path.relative_to(directory))] = sha(path)
            libraries[context][name] = {
                "resolver_context": str(root / context), "resolver_path": str(resolver),
                "realpath": str(directory),
                "version": json.loads((directory / "package.json").read_text())["version"],
                "files": files,
            }
    return libraries

def read_result(path, contract):
    # No symlinks, oversized output or arbitrary error/token strings enter shared receipts.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_size < 1048576, "Result identity refused")
        raw = os.read(fd, 1048576)
        require(len(raw) == info.st_size, "Result changed while reading")
    finally:
        os.close(fd)
    result = json.loads(raw)
    cases = set(contract["cases"]) | {"setup"}
    codes = {v.get("code") for v in contract["http"].values()}
    enums = {"case": cases, "code": codes, "role": {"member", "admin", "observer"}, "winner": {"I1", "I2"}, "active_organization": {"A"}, "sqlstate_class": {contract["fault_sqlstate_class"]}}
    bools = {"passed", "startup", "admission", "runtime", "cookie_continuity", "overlap", "nonlocking_negative_control_completed", "transactions_completed", "rollback_observed_from_separate_connection", "membership_attempt_observed"}
    numbers = {"membership_count", "response_cookie_count", "blocked_connections"}
    hashes = {"before_hash", "after_hash", "protected_hash"}
    def validate(value):
        require(isinstance(value, dict), "Result object refused")
        for key, item in value.items():
            if key in enums:
                require(item in enums[key], "Result enum refused")
            elif key in bools:
                require(type(item) is bool, "Result boolean refused")
            elif key in numbers:
                require(type(item) is int and 0 <= item <= 100, "Result count refused")
            elif key in hashes:
                require(isinstance(item, str) and re.fullmatch(r"[0-9a-f]{64}", item), "Result hash refused")
            elif key == "failure_check_sha256":
                require(value is result and result["passed"] is False and
                        isinstance(item, str) and re.fullmatch(r"[0-9a-f]{64}", item),
                        "Result failure check hash refused")
            elif key == "oracle_sha256":
                require(item == ORACLE, "Result oracle refused")
            elif key == "status":
                require(item in {200, 403, 500}, "Result status refused")
            elif key == "statuses":
                require(isinstance(item, list) and len(item) == 2 and all(v in {200, 403, 500} for v in item), "Result statuses refused")
            elif key == "loser":
                require(set(item) == {"status", "code"}, "Result loser refused")
                validate(item)
            elif key == "observations":
                require(isinstance(item, list) and len(item) <= 32, "Result observations refused")
                for observation in item:
                    validate(observation)
            else:
                raise RuntimeError("Unknown result field")
    require(set(result) - {"failure_check_sha256"} == {"passed", "case", "oracle_sha256", "observations", "startup", "admission", "runtime"}, "Result schema refused")
    validate(result)
    require(all(result[k] is False for k in ("startup", "admission", "runtime")), "Result authority refused")
    if result["passed"]:
        # Contention cases emit one overlap observation and one outcome each.
        observations = result["observations"]
        expected = set(contract["cases"])
        require({o.get("case") for o in observations} == expected, "Result case coverage refused")
        for case in expected:
            found = [o for o in observations if o.get("case") == case]
            contention = case in {"same-invitation", "distinct-invitations"}
            require(len(found) == (2 if contention else 1), "Result case multiplicity refused")
            if contention:
                require(sum(o.get("overlap") is True for o in found) == 1 and
                        sum(o.get("transactions_completed") is True for o in found) == 1 and
                        all(not ("overlap" in o and "transactions_completed" in o) for o in found),
                        "Result contention observations refused")
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--opt-in", choices=[ORACLE], required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    # Reserve evidence exclusively, including dangling symlink refusal. Never overwrite a prior run.
    receipt_fd = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    record = {"oracle_sha256": ORACLE, "runner_sha256": sha(Path(__file__)), "startup": False, "admission": False, "runtime": False, "passed": False, "cleanup": "preserved", "commands": [], "libraries": {}}
    owned = None
    marker_fd = None
    children = []
    server = None
    passed = False
    directories = {}
    def persist():
        content = (json.dumps(record, indent=2) + "\n").encode()
        for fd in (receipt_fd, marker_fd):
            if fd is not None:
                os.lseek(fd, 0, os.SEEK_SET)
                view = memoryview(content)
                while view:
                    view = view[os.write(fd, view):]
                os.ftruncate(fd, len(content))
                os.fsync(fd)
    evidence_failed = False
    def teardown_persist():
        nonlocal evidence_failed
        try:
            persist()
        except BaseException:
            evidence_failed = True
            record.update(passed=False, receipt_write_failed=True)
    interrupt = {"launching": False, "pending": False}
    def on_interrupt(_signum, _frame):
        interrupted(interrupt)
    old_handlers = {s: signal.signal(s, on_interrupt) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        persist()
        require(sha(args.oracle) == ORACLE, "Oracle identity refused")
        contract_path = BUILD / "pg18-contract.json"
        contract = json.loads(contract_path.read_text())
        require(contract["oracle_sha256"] == ORACLE, "Contract oracle refused")
        root = (args.export / "source").resolve(strict=True)
        export_receipt = args.export / "receipt.json"
        source = json.loads(export_receipt.read_text())
        require(sha(contract_path) == source["pg18_contract_sha256"], "Frozen PG contract drift")
        require(record["runner_sha256"] == source["pg18_runner_sha256"], "Frozen runner drift")
        require(source["root_oracle_sha256"] == ORACLE, "Frozen oracle drift")
        require(source["base"] == "aebf69526ed168e985f50f9a973a85ea1f7519f9", "Source base drift")
        require(all(source[k] is False for k in ("startup", "admission", "runtime")), "Authority refused")
        for entry in source["files"]:
            file = root / entry["path"]
            require(file.resolve(strict=True).is_relative_to(root) and not file.is_symlink() and file.is_file(), "Source confinement refused")
            require(sha(file) == entry["sha256"], "Export drift")
            require(file.stat().st_mode & 0o777 == int(entry["export_mode"], 8) & 0o777, "Source mode drift")
        for name in ("invitations.test.ts", "vitest.config.ts"):
            rel = "apps/dokploy/__test__/community-pg18/" + name
            require(sha(root / rel) == sha(BUILD / "overlays/files" / (rel + ".payload")), "Fixture payload drift")
        owned = Path(tempfile.mkdtemp(prefix="ha-pg-", dir="/private/tmp"))
        record["owned_directory"] = str(owned)
        record["owner"] = {"pid": os.getpid(), "uid": os.getuid(), "started_ns": time.time_ns()}
        persist()
        owned.chmod(0o700)
        directories[str(owned)] = identity(owned)
        record["directory_identities"] = directories
        marker_fd = os.open(owned / "owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        persist()
        socket, home, data = owned / "socket", owned / "home", owned / "data"
        for directory in (socket, home):
            directory.mkdir(mode=0o700)
            directories[str(directory)] = identity(directory)
            persist()
        # No ambient PG*, NODE_OPTIONS, loaders, credentials, HOME or executable lookup.
        env = {"PATH": f"{NODE.parent}:{PG}:/usr/bin:/bin", "LC_ALL": "C", "HOME": str(home), "TMPDIR": str(owned), "NODE_ENV": "production"}
        record.update(contract_sha256=sha(contract_path), export_receipt_sha256=sha(export_receipt), overlay_revision=source["overlay_revision"], binaries={str(p): sha(p) for p in (NODE, *(PG / n for n in ("postgres", "initdb", "createdb", "pg_isready")))})
        persist()
        record["libraries"] = library_identities(root)
        persist()
        def launch(command, extra=None):
            entry = {"argv": command, "started_ns": time.time_ns(), "pid": None, "pgid": None, "exit": None, "timeout": False, "reaped": False, "signals": [], "output_bytes": 0, "output_sha256": None}
            record["commands"].append(entry)
            persist()
            item = launch_owned(command, root / "apps/dokploy", {**env, **(extra or {})}, children, entry, interrupt)
            persist()
            return item
        def finish(item, timeout):
            child, entry, thread, digest, size, capture = item
            try:
                child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                entry["timeout"] = True
                persist()
                raise RuntimeError("Owned command deadline exceeded") from None
            entry.update(exit=child.returncode, reaped=True, ended_ns=time.time_ns())
            thread.join(timeout=2)
            entry.update(output_complete=not thread.is_alive(), output_bytes=size[0], output_sha256=digest.hexdigest())
            persist()
            require(not thread.is_alive(), "Owned output stream remains open")
            return bytes(capture)
        def run(command, extra=None, timeout=30, acceptable=(0,)):
            item = launch(command, extra)
            output = finish(item, timeout)
            require(item[0].returncode in acceptable, "Owned command failed (output suppressed)")
            return item[0].returncode, output
        _, version = run([str(NODE), "--version"])
        require(version.strip() == b"v24.21.0", "Node identity refused")
        _, version = run([str(PG / "postgres"), "--version"])
        require(version.startswith(b"postgres (PostgreSQL) 18."), "PG18 identity refused")
        run([str(PG / "initdb"), "-D", str(data), "-U", "auth_fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"])
        with (data / "postgresql.conf").open("a") as config:
            config.write("\nlisten_addresses = ''\nport = 55439\nunix_socket_directories = '" + str(socket) + "'\nunix_socket_permissions = 0700\nlog_statement = 'none'\nlog_min_error_statement = 'panic'\nlog_min_messages = 'panic'\n")
        server = launch([str(PG / "postgres"), "-D", str(data)])
        deadline = time.monotonic() + 15
        ready = False
        while time.monotonic() < deadline and server[0].poll() is None:
            code, _ = run([str(PG / "pg_isready"), "-h", str(socket), "-p", "55439", "-U", "auth_fixture", "-d", "postgres", "-t", "1"], timeout=2, acceptable=(0, 1, 2))
            if code == 0:
                ready = True
                break
            time.sleep(.05)
        require(ready, "Owned PG readiness failed")
        run([str(PG / "createdb"), "-h", str(socket), "-p", "55439", "-U", "auth_fixture", "auth_fixture"])
        run([str(NODE), "node_modules/vitest/vitest.mjs", "run", "--config", "__test__/community-pg18/vitest.config.ts", "--reporter=dot"], extra={"COMMUNITY_PG18_OPT_IN": ORACLE, "COMMUNITY_PG18_SOCKET": str(socket), "COMMUNITY_PG18_RESULT": str(owned / "result.json"), "COMMUNITY_PG18_CONTRACT": str(contract_path)}, timeout=120)
        record["result"] = read_result(owned / "result.json", contract)
        passed = record["result"]["passed"] is True
    except BaseException as error:
        record["failure_class"] = type(error).__name__
        passed = False
    finally:
        # Repeated interruption cannot abandon owned children during bounded shutdown.
        for sig in old_handlers:
            signal.signal(sig, signal.SIG_IGN)
        for item in reversed(children):
            child, entry, thread, digest, size, capture = item
            try:
                if child.poll() is None:
                    signals = ((signal.SIGINT, 15), (signal.SIGTERM, 5), (signal.SIGKILL, 5)) if item is server else ((signal.SIGTERM, 5), (signal.SIGKILL, 5))
                    for sig, timeout in signals:
                        if child.poll() is not None:
                            break
                        # Only this live Popen owns the group; never recover/kill from marker PIDs.
                        os.killpg(child.pid, sig)
                        entry["signals"].append(int(sig))
                        teardown_persist()
                        try:
                            child.wait(timeout=timeout)
                        except subprocess.TimeoutExpired:
                            entry["timeout"] = True
                            passed = False
                if child.poll() is not None:
                    child.wait(timeout=1)
                    entry.update(exit=child.returncode, reaped=True, ended_ns=time.time_ns())
                thread.join(timeout=2)
                entry.update(output_complete=not thread.is_alive(), output_bytes=size[0], output_sha256=digest.hexdigest(), group_stopped=group_stopped(child))
                if not entry["group_stopped"] or thread.is_alive():
                    passed = False
            except BaseException as error:
                entry["cleanup_failure_class"] = type(error).__name__
                passed = False
            teardown_persist()
        if owned is not None and (owned / "result.json").exists():
            try:
                record["result"] = read_result(owned / "result.json", contract)
            except BaseException as error:
                passed = False
                record["result_failure_class"] = type(error).__name__
        stopped = all(e.get("group_stopped", False) and e["reaped"] for _, e, *_ in children)
        clean_postmaster = server is not None and server[0].returncode == 0
        record.update(all_owned_children_stopped=stopped, postmaster_clean_exit=clean_postmaster)
        try:
            identities_valid = owned is not None and all(identity(Path(p)) == expected for p, expected in directories.items()) and len(directories) == 3
            record["directory_identities_valid"] = identities_valid
            record["passed"] = passed and stopped and clean_postmaster and identities_valid and not evidence_failed
            teardown_persist()
            if record["passed"]:
                require(owned.parent == Path("/private/tmp") and owned.name.startswith("ha-pg-"), "Cleanup boundary refused")
                shutil.rmtree(owned)
                record["cleanup"] = "successful_owned_fixture_removed"
        except BaseException as error:
            record.update(passed=False, cleanup_failure_class=type(error).__name__)
        teardown_persist()
        try:
            if marker_fd is not None:
                os.close(marker_fd)
        finally:
            try:
                os.close(receipt_fd)
            finally:
                for sig, handler in old_handlers.items():
                    signal.signal(sig, handler)
        print(json.dumps({"passed": record["passed"], "receipt": str(args.receipt), "cleanup": record["cleanup"]}))
    return 0 if record["passed"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
