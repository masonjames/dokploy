"""Separate community observation entry. Every result refuses runtime startup."""

from dataclasses import dataclass
import json

from state_observation import QuerySession, Target, observe
from state_policy import Decision


@dataclass(frozen=True)
class Exit:
    observation: Decision
    exit_code: int = 1
    migration_authorized: bool = False
    runtime_authorized: bool = False


def run(session: QuerySession, target: Target, purpose: str = "initial") -> Exit:
    return Exit(observe(session, target, purpose))


def main() -> int:
    # There is deliberately no connector, environment loader or runtime dispatch.
    result = Exit(Decision("REFUSE_UNCONFIGURED", "No reviewed PostgreSQL connector; startup inadmissible"))
    print(json.dumps({"classification": result.observation.classification,
                      "status": result.observation.status,
                      "migration_authorized": False, "runtime_authorized": False}))
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
