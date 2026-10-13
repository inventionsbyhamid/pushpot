# Security

PushPot holds real money, so we take reports seriously.

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/inventionsbyhamid/pushpot/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it and what an attacker
could gain. We'll acknowledge reports within 48 hours.

## Where money can go

The contract has no admin withdrawal of any kind. USDC leaves it in exactly three ways:

| Function | Who receives it | How much |
|---|---|---|
| `leave` | the member leaving, before the pot starts | their own stake |
| `claim` | the member claiming, after the pot ends | their share, or their stake back if nobody finished |
| `collectFee` | the treasury, once per pot | 5% of forfeited stakes, never more than 10% |

The contract never grants token allowances, makes no arbitrary calls, has no payable functions
and isn't upgradeable. A test takes over every privileged role, including ownership itself, and
checks that none of them can extract a single unit of a member's stake.

## Roles

| Role | Held by | Can | Can't |
|---|---|---|---|
| Owner | a Safe multisig | pause new pots and joins; set the oracle, fee and treasury for future pots; revoke an oracle; change the curator | move funds, change a running pot, block claims or leaving, renounce ownership |
| Oracle | the server's hot key | check in a member for the current period | move funds, check anyone in for a closed period |
| Curator | the server's hot key | open official challenges | stake, join, or touch funds |
| Treasury | the same Safe | receive fees from finished pots | anything else |

A pot keeps the oracle and fee that were active when it was created. The web app refuses to stake
into any pot whose oracle isn't PushPot's, so even a stolen owner key couldn't trick players into
pots judged by someone else. Owner actions need several signatures from the Safe, and ownership
transfers in two steps so it can never be handed to a wrong address by mistake.

## What you trust the operator for

- **Fair attestation.** The oracle decides whether a workout happened. A dishonest or compromised
  oracle could check in members who didn't do their reps, or ignore members who did. That is the
  main trust assumption, so the oracle key holds only a little gas money, lives only in the
  server's environment, and can be revoked instantly.
- **Liveness.** If the server is down, nobody can check in. Pots then end without completers and
  everyone is refunded.

## Known limitations

- **Rep counts come from the user's device.** The server validates the telemetry and recounts
  reps from the raw angle trace, but a determined attacker can forge a plausible trace. Private
  pots are joined by invite link and never listed; only official challenges are public, and they
  carry small stakes.
- **The contracts are unaudited.** Stakes are capped per member (`maxStake`, set at deploy).
  Private pots hold at most 50 members and official challenges at most 1,000.

## Incident response

- **Oracle key leaked:** the owner calls `revokeOracle` with the old key. It can no longer check
  anyone in, so its pots end with every member refunded. Then generate a new key, `setOracle` it
  for new pots and update the server.
- **Bug or abuse:** the owner calls `setPaused(true)`. New pots and joins stop; check ins, leaving
  and claims keep working, so nobody's money is stuck.
- **Treasury address unusable:** the owner points `setTreasury` at a new address; uncollected fees
  follow it.

## Testing

The CI workflow runs on every push:

- **Contract:**
  - Foundry unit tests;
  - fuzzing (5,000 runs);
  - stateful invariant tests (256 runs × 500 calls), including random owner actions;
  - Slither.
- **Server:** integration tests against Postgres, plus clippy with warnings denied.
- **Web:** unit tests for the rep counter, telemetry and payout maths.

## Secrets

- Every `.env` file is ignored by git. Each part of the repo ships an `.env.example` instead.
- A git hook in `.githooks` checks every commit and refuses `.env` files or any change containing
  a secret from your local `.env` files. Turn it on with `git config core.hooksPath .githooks`.
- CI scans the full git history for leaked credentials with gitleaks.
