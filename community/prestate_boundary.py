"""Exact enumerated prestate comparison. No migration or runtime dispatch."""

from dataclasses import dataclass

from observation_connector import Baseline, Binding, inspect_evidence, validate, validate_digest
from observe_entry import Exit
from state_observation import Target, require
from state_policy import Decision


@dataclass(frozen=True)
class Expected:
    """Externally retained proposal scope and evidence, not an authorization.

    The trusted caller must obtain these from its reviewed inventory/proposal and
    prior authenticated observation, never by accepting a claimant's supplied map.
    The CA digest must come from external trusted certificate bytes, not the target.
    """

    target: Target
    baseline: Baseline
    tls_hostname: str
    ca_file: str
    candidate_sha256: str
    prestate_sha256: str
    ca_sha256: str


@dataclass(frozen=True)
class Comparison:
    result: Exit
    observations_match: bool = False
    writer_exclusion_established: bool = False


def _refuse(classification: str, reason: str, matched: bool = False) -> Comparison:
    return Comparison(Exit(Decision(classification, reason)), matched)


def check(binding: Binding, candidate_sha256: str, expected: Expected,
          purpose: str = 'first-migration') -> Comparison:
    """Two fresh observations, both compared to the external exact prestate.

    Matching includes the snapshot: unrelated transaction movement may refuse.
    Matching cannot detect all concurrent/uncommitted/ABA writes or exclude future
    writers. No result is consumable as an execution lease. Every new call starts
    over; no resume, repair, retry or persisted receipt loader exists.
    """
    if type(purpose) is not str or purpose != 'first-migration':
        return _refuse('REFUSE_OPERATION', 'Restart, upgrade and recovery admission are unqualified')
    try:
        validate(binding)
        require(type(expected) is Expected)
        # Validate every inner native type before equality or filesystem access.
        validate(Binding(expected.target, expected.tls_hostname, expected.ca_file,
                         expected.baseline, binding.password, expected.ca_sha256))
        for digest in (candidate_sha256, expected.candidate_sha256, expected.prestate_sha256,
                       binding.ca_sha256, expected.ca_sha256):
            validate_digest(digest)
        if (binding.target, binding.baseline, binding.tls_hostname, binding.ca_file,
                binding.ca_sha256, candidate_sha256) != (
                expected.target, expected.baseline, expected.tls_hostname, expected.ca_file,
                expected.ca_sha256, expected.candidate_sha256):
            return _refuse('REFUSE_SCOPE', 'Target, trust binding, baseline or candidate changed')
        for _ in range(2):
            evidence = inspect_evidence(binding)
            if evidence.result.observation.classification != 'NEW_EMPTY_CANDIDATE':
                return Comparison(evidence.result)
            if evidence.prestate_sha256 != expected.prestate_sha256:
                return _refuse('REFUSE_PRESTATE', 'Enumerated prestate changed; rebuild proposal evidence')
    except Exception:
        return _refuse('REFUSE_UNKNOWN', 'Prestate comparison failed or was incomplete')
    return _refuse('REFUSE_WRITER_EXCLUSION',
                   'Two observations match; database-wide writer exclusion is unsupported', True)
