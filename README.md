# PushPot

Stake USDC on your pushups. Miss a day and your stake goes to the friends who didn't.

[pushpot.fun](https://pushpot.fun)

## What it is

PushPot turns pushups into a game with real stakes. Join a challenge or start a pot with
friends, put in a few USDC and do your reps in front of your phone camera. Everyone who shows up
every day splits the pot.

## How it works

1. **Join.** Pick an official challenge (daily, weekly, weekend, monthly or the 52 Week Club) or
   start a private pot and share the invite link.
2. **Do your reps.** A pose model running in your browser counts them. Video never leaves your
   phone.
3. **Get verified.** The server checks the workout and records it on Arc in about a second.
4. **Get paid.** When the pot ends, everyone who finished splits it. If nobody makes it, everyone
   gets their money back.

## Why Arc

- USDC is the gas token, so players only ever need dollars.
- Transactions are final in under a second, so logging a workout feels instant.
- Fees are a fraction of a cent, which makes small daily stakes practical.

## Fees

PushPot keeps 5% of forfeited stakes and nothing else. It never touches a winner's own stake, and
there is no fee when everyone or nobody finishes. The rate is locked into each pot when it is
created and capped at 10% by the contract.

## Fair play and safety

- The contract holds the money and only ever pays it out to members.
- A pot's rules, including who verifies workouts, are fixed when it is created.
- Reps are counted on your device, so a determined cheater could fake them. The server recounts
  every rep from the joint angle trace and rejects anything that doesn't look human. Private pots
  are invite only.
- The contract has unit, fuzz and invariant tests and a clean static analysis run, but no audit
  yet, so stakes are capped.

The full threat model is in [SECURITY.md](SECURITY.md).

## Tech

| Part | Stack |
|---|---|
| Contract | Solidity, Foundry, OpenZeppelin |
| Server | Rust, axum, Postgres, alloy |
| Web | React, Vite, Tailwind, wagmi, RainbowKit |
| Pose | MediaPipe Pose Landmarker in the browser |

The code lives in `contracts`, `server` and `web`. Architecture, API and validation rules are in
[docs/DESIGN.md](docs/DESIGN.md).

## Running locally

You need Rust, Node with pnpm, Postgres and Foundry. Each part has an `.env.example` to copy.

```sh
cd contracts && forge test
cd server && cargo run
cd web && pnpm install && pnpm dev
```

## License

MIT
