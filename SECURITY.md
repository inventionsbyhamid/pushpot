# Security

PushPot holds real money, so we take reports seriously.

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/inventionsbyhamid/pushpot/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it and what an attacker
could gain. We'll acknowledge reports within 48 hours.

## Threat model

### What the contract guarantees

- Staked USDC can only leave the contract to the members of the pot it was staked in: on
  `leave` before the start, or on `claim` after the end.
- The rules of a pot are fixed when it is created, including the oracle that judges it. The
  owner can't change them for a running pot.
- The owner can:
  - pause new pots and joins;
  - set the oracle for future pots;
  - revoke an oracle key.

  It can't move funds, block claims, block leaving, or renounce ownership.
- A revoked or absent oracle can't check anyone in. Pots then end without completers, and every
  member gets their stake back.

### What you trust the operator for

- **Fair attestation.** The oracle decides whether a workout happened. A dishonest or compromised
  oracle could check in members who didn't do their reps, or ignore members who did. It can't
  check anyone in for a closed period.
- **Liveness.** If the server is down, nobody can check in.

### Known limitations

- **Rep counts come from the user's device.** The server validates the telemetry and recounts
  reps from the raw angle trace, but a determined attacker can forge a plausible trace. Play with
  people you know. Pots are joined by invite link and aren't listed publicly.
- **The contracts are unaudited.** Stakes are capped per member (`maxStake`, set at deploy) and
  pots are capped at 50 members.
- **The owner is a single key.** Safe isn't deployed on Arc yet. Ownership uses a two-step
  transfer so it can move to a multisig later.

## Testing

The CI workflow runs on every push:

- **Contract:**
  - Foundry unit tests;
  - fuzzing (5,000 runs);
  - stateful invariant tests (256 runs × 500 calls);
  - Slither.
- **Server:** integration tests against Postgres, plus clippy with warnings denied.
- **Web:** unit tests for the rep counter and telemetry.
