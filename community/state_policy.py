"""NONBUILDABLE / nonrunnable. Pure supplied-state classification, no admission."""

from dataclasses import dataclass

STATUS = "NONBUILDABLE / nonrunnable"
COUNTS = ("application_tables", "application_rows", "custom_roles",
          "incompatible_membership_roles", "incompatible_default_roles",
          "incompatible_invitation_roles", "enforced_sso", "provisioned_sso",
          "provisioned_scim", "protected_forward_auth")


@dataclass(frozen=True)
class Decision:
    classification: str
    reason: str
    migration_authorized: bool = False
    runtime_authorized: bool = False
    status: str = STATUS


def classify(state):
    """Only a complete synthetic new-empty observation is a future candidate."""
    if not isinstance(state, dict) or set(state) != {"complete", "database_kind", *COUNTS}:
        return Decision("REFUSE_UNKNOWN", "Missing or unexpected supplied observations")
    if state["complete"] is not True or state["database_kind"] not in ("new", "existing"):
        return Decision("REFUSE_UNKNOWN", "Incomplete or unknown observation")
    if any(type(state[key]) is not int or state[key] < 0 for key in COUNTS):
        return Decision("REFUSE_UNKNOWN", "Counts must be known nonnegative integers")
    if any(state[key] for key in COUNTS[2:]):
        return Decision("REFUSE_INCOMPATIBLE", "Unsupported role, SSO/SCIM or protected forward-auth state")
    if state["database_kind"] == "existing":
        return Decision("REFUSE_EXISTING", "Existing-state admission is not qualified")
    if state["application_tables"] or state["application_rows"]:
        return Decision("REFUSE_PARTIAL", "Claimed new database is not empty")
    return Decision("NEW_EMPTY_CANDIDATE", "Supplied facts only; adapter and pre-migration evidence still required")
