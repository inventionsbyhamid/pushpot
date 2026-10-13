# PushPot

Stake USDC on your pushups. Miss a day, lose your stake to the friends who didn't.

PushPot is a group fitness challenge with real money on the line. Friends put USDC into a pot
and commit to a daily target, say 20 pushups for 7 days. Each day they prove it in front of
their phone camera: a pose model running entirely in the browser counts the reps, and the
check-in is recorded on [Arc](https://arc.io). When the challenge ends, everyone who showed up
every day splits the pot.

## Why Arc

- **USDC is the gas token.** Users only need dollars, not a volatile coin, and a $10 stake stays
  $10 for the whole challenge.
- **Sub-second finality.** A check-in is final before the celebration animation finishes, which
  is what makes on-chain check-ins feel instant instead of tacked on.
- **Fees around $0.002.** Daily check-ins for a whole group cost cents, so small, social stakes
  make sense.

## How it works

```
phone camera ─▶ MediaPipe pose (on-device) ─▶ rep counter ─▶ telemetry
                                                               │
                         Rust server: validate, recount ◀──────┘
                                   │
                         oracle ─▶ PushPot.checkIn() on Arc
```

1. **Pots.** The creator opens a pot and stakes; friends join with the same stake before it
   starts. Joins use an EIP-2612 permit, so each is a single transaction.
2. **Counting.** The browser runs MediaPipe Pose Landmarker locally, and no video ever leaves the
   phone. A state machine counts a rep only when:
   - the elbow travels through the full range;
   - the body stays in a straight line;
   - the timing is human.
3. **Verification.** The server receives a compact trace of joint angles, recounts the reps
   independently and checks them for plausibility. The oracle then submits `checkIn` with the
   trace's hash. Anyone can fetch the trace behind a check-in from `/api/evidence/<hash>`.
4. **Payout.** Once the challenge ends, members who checked in every period claim an equal share
   of the whole pot. If nobody made it, everyone gets their stake back.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design, API and security notes.

## Trust model

The contract holds the money; the server only attests workouts.

- **Funds:**
  - stakes can only flow back to members;
  - the owner can pause new pots, but never claims or withdrawals.
- **Oracle:**
  - it can only check in a member for the current period (with a 5 minute grace), so it can't
    rewrite history;
  - if it disappears, nobody completes and everyone is refunded.
- **Known limit.** The rep count comes from the user's device, so a determined cheater can fake
  it. Server-side recounting and signal checks raise the bar; peer-reviewed proof clips are on
  the roadmap.
- **Unaudited.** The contract has unit, fuzz and invariant tests and a clean Slither run, but no
  audit, so stakes are capped.

## Repository

| Path | What |
|---|---|
| `contracts/` | `PushPot.sol` with Foundry tests and deploy script |
| `server/` | Rust API: SIWE auth, indexer, telemetry validator, oracle, static hosting |
| `web/` | React app: pose counter, pots, wallet flows |

## Running locally

Requirements:

- Rust 1.94+ (pinned in `rust-toolchain.toml`)
- Node 22 with pnpm
- Postgres
- [Foundry](https://getfoundry.sh)

```sh
# contracts
cd contracts && forge test

# server (see server/.env.example)
cd server
cp .env.example .env    # fill in the contract address and oracle key
createdb pushpot_dev
cargo run

# web (see web/.env.example)
cd web
cp .env.example .env.local
pnpm install
pnpm dev                # proxies /api to localhost:8080
```

Server tests need a database URL: `DATABASE_URL=postgres://<user>@localhost/pushpot_dev cargo test`.

The camera needs a secure context. On a phone, use an HTTPS deployment or tunnel rather than a
LAN IP.

## Deploying

The root `Dockerfile` builds the web app and the server into one image. Configure it with:

- **Runtime env:** the variables in `server/.env.example`.
- **Build args:**
  - `VITE_CHAIN_ID`
  - `VITE_PUSHPOT_ADDRESS`
  - `VITE_WALLETCONNECT_PROJECT_ID`

The image serves on port 8080 and runs migrations on boot. The oracle wallet needs a small USDC
balance for gas.

Deploying the contract:

```sh
cd contracts
ORACLE_ADDRESS=0x... MAX_STAKE=20000000 forge script script/Deploy.s.sol \
  --rpc-url arc --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

## License

MIT
