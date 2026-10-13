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
- The rules of a pot are fixed when it is created, including the oracle that judges it and the
  platform fee. The owner can't change them for a running pot.
- The platform fee comes only out of forfeited stakes. It is never taken from a winner's own
  stake or a refund, and there's no fee when everyone or nobody finishes. It is capped at 10% in
  the contract.
- The owner can:
  - pause new pots and joins;
  - set the oracle, fee and treasury for future pots;
  - revoke an oracle key;
  - change or remove the curator.

  It can't move funds, block claims, block leaving, or renounce ownership.
- The curator can open official challenges. It doesn't stake or join them, and it has no access
  to funds.
- A revoked or absent oracle can't check anyone in. Pots then end without completers, and every
  member gets their stake back.

### What you trust the operator for

- **Fair attestation.** The oracle decides whether a workout happened. A dishonest or compromised
  oracle could check in members who didn't do their reps, or ignore members who did. It can't
  check anyone in for a closed period.
- **Liveness.** If the server is down, nobody can check in.

### Known limitations

- **Rep counts come from the user's device.** The server validates the telemetry and recounts
  reps from the raw angle trace, but a determined attacker can forge a plausible trace. Private pots
  are joined by invite link and never listed; only official challenges are public, and they
  carry small stakes.
- **The contracts are unaudited.** Stakes are capped per member (`maxStake`, set at deploy).
  Private pots hold at most 50 members and official challenges at most 1,000.
- **The owner is a single key.** Safe isn't deployed on Arc yet. Ownership transfers in two
  steps, so it can move to a multisig later.

## Testing

The CI workflow runs on every push:

- **Contract:**
  - Foundry unit tests;
  - fuzzing (5,000 runs);
  - stateful invariant tests (256 runs × 500 calls);
  - Slither.
- **Server:** integration tests against Postgres, plus clippy with warnings denied.
- **Web:** unit tests for the rep counter and telemetry.

## Secrets

- Every `.env` file is ignored by git. Each part of the repo ships an `.env.example` instead.
- A git hook in `.githooks` checks every commit and refuses `.env` files or any change containing
  a secret from your local `.env` files. Turn it on with `git config core.hooksPath .githooks`.
- CI scans the full git history for leaked credentials with gitleaks.
