# PushPot design

PushPot is a group pushup challenge with real stakes. Friends put USDC into a pot, commit to a
daily pushup target, and prove each set with the phone camera. Anyone who misses a day forfeits
their stake to the people who finish.

Pushups are counted on-device by a pose model running in the browser. Stakes live in a contract
on Arc, where USDC is the gas token and blocks finalize in under a second. That makes small,
social stakes practical: a check-in costs a fraction of a cent and confirms before the
celebration animation finishes.

## Goals

- Anyone can open the site on a phone and count pushups with the camera within seconds,
  without a wallet (practice mode).
- A group can create a pot, invite friends with a link, stake USDC, and check in daily, with
  each check-in recorded on Arc in about a second.
- Payouts are enforced by the contract. The server can attest workouts but can never move
  funds.

Out of scope for now: native apps, other exercises, fiat on-ramp, multi-chain.

## How it works

1. **Create.** The creator picks the reps per period (e.g. 20), the number of periods (e.g. 7),
   the period length (daily, or a short sprint), the stake, the start time and the member cap,
   then stakes in the same transaction.
2. **Invite.** The creator shares `/p/:id`. Friends join by staking the same amount before the
   start time.
3. **Check in.** Each period, members open the pot and do their reps in front of the camera.
   The browser counts reps and records a compact telemetry trace. The server validates the
   trace and submits `checkIn` to the contract from the oracle key.
4. **Settle.** After the last period (plus a short grace window), members who checked in every
   period split the whole pot. If nobody finished, everyone gets their stake back.

## Architecture

```
 Phone browser (React SPA)                     Server (Rust, axum)
 ┌────────────────────────────┐   HTTPS   ┌───────────────────────────────┐
 │ MediaPipe pose (on-device) │──────────▶│ SIWE auth, sessions           │
 │ rep counter + telemetry    │ JSON, SSE │ pots / workouts API           │
 │ wagmi + viem wallet        │◀──────────│ telemetry validator           │
 └──────────────┬─────────────┘           │ oracle tx sender (one actor)  │
                │ create / join / claim   │ log indexer                   │
                ▼ (signed by the user)    │ static SPA + model files      │
 ┌────────────────────────────┐           └──────┬───────────────┬────────┘
 │ Arc: PushPot.sol (escrow)  │◀── checkIn ──────┘               │ sqlx
 └────────────────────────────┘    (oracle key)          ┌───────▼───────┐
                                                         │ Postgres      │
                                                         └───────────────┘
```

The server binary also serves the built SPA, so everything is same-origin. The camera
requires HTTPS, which the reverse proxy in front of the container provides.

## Trust model

- **Funds.** Only the contract holds stakes, and funds can only flow back to members. The
  owner can rotate the oracle and nothing else.
- **Check-ins.** The oracle is trusted to attest that a workout happened. The contract limits
  what it can do: it only accepts a check-in for the current period (plus a 5 minute grace),
  for a member, with at least the target reps. The oracle can't backfill or rewrite history.
- **Liveness.** If the oracle goes offline for the whole challenge, nobody completes and
  everyone is refunded.
- **Evidence.** Each check-in emits `evidenceHash = keccak256(telemetry)`. The telemetry is
  published at `/api/evidence/:hash` once the pot stops accepting check-ins, so nobody can copy
  a live trace mid-challenge.
- **Limits.** Client-side detection can be spoofed by someone determined. The server raises the
  bar: it checks every reported rep against the raw angle trace, recounts reps from it, runs
  plausibility checks on timing, range of motion and signal statistics, and refuses a trace it
  has seen before. Stronger proofs (peer-reviewed clips, attested devices) are future work.
- **Caps.** The contract is small and tested but unaudited. Stake is capped at 50 USDC per
  member, and a pot holds at most 50 members.

## Contract

`contracts/src/PushPot.sol`, Solidity 0.8.30, Foundry, OpenZeppelin 5.7.

**USDC.** Stakes use the USDC ERC-20 interface at `0x3600…0000` (6 decimals), as Arc's docs
recommend for apps that hold USDC. On Arc, native USDC (18 decimals) and the ERC-20 view are
the same balance. So the contract never touches `msg.value`, has no `receive()`, and has no
native-balance sweep (a sweep would also drain escrowed deposits).

**Joining.** Joins and pot creation accept an EIP-2612 permit, so each takes one transaction.
Arc's USDC permit domain is name `USDC`, version `2`.

| Function | Who | Rules |
|---|---|---|
| `createPot(params)` / `createPotWithPermit` | anyone | validates params; the creator joins and stakes |
| `join` / `joinWithPermit` | anyone | before `startTime`, not full, exact stake |
| `leave` | member | before `startTime`; refunds the stake |
| `checkIn(potId, member, period, reps, evidenceHash)` | oracle | member; `reps ≥ target`; inside the period window + `GRACE`; once per period |
| `claim` | member | after `endTime + GRACE`; completers split the pot (the last claimer takes the rounding remainder); if there are no completers, everyone is refunded |
| `setOracle` | owner | — |

**Limits.**

| Constant | Value |
|---|---|
| Period length | 10 minutes – 7 days |
| Periods | ≤ 90 |
| Members | 2 – 50 |
| Reps per period | ≤ 1000 |
| Start time | ≤ 30 days ahead |
| Title | ≤ 48 bytes |

**Events.** `PotCreated`, `Joined`, `Left`, `CheckedIn`, `Claimed` and `OracleUpdated` carry
everything the indexer needs.

## Server

`server/`, Rust 1.99, axum 0.8, sqlx 0.9 (Postgres), alloy 2.5.

**Auth.** Sign-In with Ethereum (EIP-4361):

1. `GET /api/auth/nonce` issues a single-use nonce (valid 10 minutes).
2. The client signs a SIWE message built with viem.
3. `POST /api/auth/verify` checks domain, chain ID, nonce and expiry, and recovers the EIP-191
   signer. For smart-contract wallets it falls back to ERC-1271 `isValidSignature`, which must
   come from an address with code and return exactly the magic value in one zero-padded word.
4. The session is an HttpOnly cookie holding a random token. Only its SHA-256 is stored, with a
   7 day expiry.

**Indexer.** The indexer is the single writer for on-chain state.

- It keeps RPC use low because free endpoints are rate limited. A WebSocket subscription to the
  contract's logs (`ARC_WS_URL`, derived from `ARC_RPC_URL` by default) announces activity as it
  lands. The indexer then reads the logs with `eth_getLogs` up to the announced block, so the
  announcement only wakes it and can never skip or reorder a log.
- If the node answering `eth_getLogs` hasn't seen an announced log yet, the cursor stays put and
  the read is retried shortly.
- A safety poll runs every 5 minutes while the subscription is live (`INDEXER_IDLE_MS`) and
  every 5 seconds while it's down (`INDEXER_INTERVAL_MS`). Idle, that is about 600 RPC calls a
  day instead of one or two per block.
- Reads cover at most 9,999 blocks (the RPC caps a query at 10k). The safety poll stays one
  block behind the head: behind a load balancer, the node answering `eth_getLogs` may not have
  the block another node reported as the head yet.
- Each batch is applied in one database transaction together with the `last_block` cursor, so
  every log is applied exactly once.
- A log that can never be stored (undecodable, or data Postgres rejects) is logged and skipped
  rather than retried forever, which would stall every join and check-in after it. Titles are
  stripped of control characters. RPC and connection errors retry the whole batch, and 15
  failed attempts in a row log an error.
- `PotCreated` doesn't carry the fee, so the indexer reads each new pot's `feeBps` with
  `getPot`. A failed read retries the batch. `ChallengeCreated` marks a pot as official, and
  `FeeCollected` records what went to the treasury.
- Arc's finality is deterministic, so there is no reorg handling.
- After a commit, the indexer publishes events to SSE subscribers.

**Oracle.**

- One task owns the oracle key, so nonces never race. It sends `checkIn`, `createChallenge` (in
  deployment the oracle key is also the curator) and `collectFee`.
- Requests arrive over a channel. The task simulates each call, sends it with
  `maxFeePerGas` ≥ 20 gwei (Arc's floor: anything lower is silently dropped), then polls for
  the receipt and logs what it cost.
- A request that waited more than 30 s in the queue fails without being sent, so a backlog
  clears quickly and the member can retry.
- A check-in costs roughly $0.002 and confirms in about a second.

**Workouts.**

1. `POST /api/workouts {pot_id}` checks the caller is an active member, that a period is
   running, and that they haven't checked in yet. A join the indexer hasn't seen yet is
   confirmed with `getMember` on the contract. It returns the member's open workout for the
   period if there is one, keeping its `started_at`, and otherwise records a new one with
   `started_at` set on the server.
2. `POST /api/workouts/:id/complete {telemetry}` checks the period has no check-in yet,
   validates the telemetry, stores it, submits `checkIn`, and returns the transaction hash and
   latency. A rejection returns a readable reason, and only the reason, the payload's hash and
   its size are stored.

- At most one workout per member and period can be submitting or recorded (a unique index).
- The check-in runs on its own task, so a client that disconnects can't abandon it half-way.
  Every 30 s, workouts stuck in `submitting` for 2 minutes (after a crash or redeploy) become
  `recorded` if their check-in reached the chain, and `failed` otherwise, which the member can
  complete again.
- Both endpoints are rate-limited to 20 requests a minute per address.

**Official challenges.** The server opens challenges from a fixed catalog, so there is always a
cohort anyone can join without an invite. Every instance starts at 00:00 UTC and takes up to
1,000 members.

| Key | Name | Tier | Reps | Length | Stake | Starts | Kept open |
|---|---|---|---|---|---|---|---|
| `daily-20` | Daily 20 | rookie | 20 | 1 day | 1 USDC | every day | next 2 |
| `daily-50` | Daily 50 | regular | 50 | 1 day | 2 USDC | every day | next 2 |
| `daily-100` | Daily 100 | beast | 100 | 1 day | 5 USDC | every day | next 2 |
| `kickoff` | Monday Kickoff | rookie | 20 a day | 7 days | 3 USDC | Mondays | next 2 |
| `iron-week` | Iron Week | beast | 50 a day | 7 days | 5 USDC | Mondays | next 2 |
| `weekend-warrior` | Weekend Warrior | regular | 50 a day | 2 days | 2 USDC | Saturdays | next 2 |
| `thirty-day` | 30 Day Challenge | regular | 25 a day | the whole month | 5 USDC | the 1st | next 1 |
| `club-52` | 52 Week Club | beast | 100 a week | 52 weeks | 10 USDC | first Monday of each month | next 1 |

- The scheduler runs at startup and every 30 minutes when `CURATOR_ENABLED` is on and the
  contract's `curator` is the oracle key. Each pass checks the database first and only touches
  the chain when an instance is missing or stuck.
- Only starts more than an hour and less than 30 days away (the contract's `MAX_START_DELAY`)
  are opened. A template staked above the contract's `maxStake` is skipped with a warning.
- Titles stay within 48 bytes: "Daily 50 · Oct 14", "Iron Week · Oct 19", "30 Day · November",
  "52 Week Club · Nov 2026".
- Each instance is claimed as a `pending` row in `challenges`, keyed by template and start,
  before `createChallenge` goes out through the oracle task. The new pot's id comes from the
  receipt's `PotCreated` log. A refused transaction frees the row so the next run tries again;
  an unconfirmed one stays `pending`.
- A `pending` row older than 2 minutes is reconciled against the curator's `PotCreated` logs
  since the block recorded with it. If the pot is there, the row is completed; if not, the row
  is released and the instance opened again. A crash or restart therefore never opens an
  instance twice.

**Fees.** Each pot keeps the fee rate it was created with, taken only from forfeited stakes.
When `FEE_COLLECTOR_ENABLED` is on, every 30 minutes the server looks for pots that stopped
accepting check-ins (end plus grace), have a fee rate, and have no fee on record. For each it
reads `collectableFee`: if it's positive, it sends `collectFee` through the oracle task,
otherwise it records 0. `collectFee` only ever pays the treasury, so anyone may call it.

### API

All JSON uses snake_case. Amounts are in USDC base units (6 decimals) as integers.

| Method & path | Response |
|---|---|
| `GET /api/auth/nonce` | `{nonce}` |
| `POST /api/auth/verify {message, signature}` | `{address}` + session cookie |
| `POST /api/auth/logout` | `204` |
| `GET /api/me` | `{address}` or `401` |
| `GET /api/pots` | the caller's pots, `{pots: Pot[]}`, or `401`. Private pots are invite-only, so there is no public listing. |
| `GET /api/challenges` | `{challenges: Challenge[]}`: official challenges that haven't ended, soonest first. No sign-in; cached for 5 s. |
| `GET /api/pots/:id` | `{pot: Pot, members: Member[]}` |
| `GET /api/pots/:id/events` | SSE: `joined`, `left`, `checked_in`, `claimed`; `404` for an unknown pot, `503` while 2,000 streams are open |
| `POST /api/workouts {pot_id}` | `{workout_id, period, reps_target, period_ends_at}`; `409` if the period is checked in or a check-in is in flight |
| `POST /api/workouts/:id/complete {telemetry}` | `{status: "recorded", tx_hash, latency_ms}`, `422 {error}`, or `409` if the period is checked in or a check-in is in flight |
| `GET /api/evidence/:hash` | the stored telemetry once the pot stops accepting check-ins, `404` until then |
| `GET /healthz` | `ok` |

```
Pot       = {id, title, creator, stake, reps_per_period, periods, period_seconds,
             start_time, end_time, max_members, member_count,
             status: "upcoming" | "active" | "ended", current_period: number | null,
             official: boolean, fee_bps: number}
Member    = {address, checked_in: number[], completed, out, claimed_amount: number | null}
Challenge = {pot: Pot,
             template: {key, name, tagline,
                        cadence: "daily" | "weekly" | "weekend" | "monthly" | "yearly",
                        tier: "rookie" | "regular" | "beast"}}
```

`start_time` and `end_time` are RFC 3339. A member is `out` once they've missed any finished
period.

### Telemetry (v1)

The client sends one object per workout:

```json
{
  "v": 1,
  "workout_id": "uuid",
  "model": "pose_landmarker_lite",
  "delegate": "GPU",
  "video": { "w": 640, "h": 480 },
  "duration_ms": 41250,
  "reps": [
    { "start": 1200, "bottom": 1650, "end": 2150,
      "min_elbow": 84, "max_elbow": 163, "min_body": 158, "vis": 0.91 }
  ],
  "trace": { "dt": "<base64 u8[]>", "elbow": "<base64 u8[]>",
             "body": "<base64 u8[]>", "vis": "<base64 u8[]>" }
}
```

Field notes:

- Rep times are milliseconds since counting started. Angles are in degrees.
- `trace` holds one sample per processed frame:
  - `dt`: milliseconds since the previous frame (0 for the first), capped at 255. The workout
    clock advances by exactly these intervals, so `Σdt` equals `duration_ms`;
  - `elbow`: smoothed elbow angle, 0–180;
  - `body`: shoulder–hip–ankle angle, 0–180;
  - `vis`: mean visibility × 255.

The server rejects a workout when any of these fail:

- **Session.** There are at least `reps_target` reps, and `duration_ms` ≤ server-observed
  elapsed time + 1.5 s (the client starts its clock after `POST /api/workouts` returns).
- **Per rep.**
  - no overlap with the previous rep, and rep ends at least 400 ms apart;
  - duration 400–8000 ms;
  - min elbow ≤ 105°, max ≥ 145°, swing ≥ 45°;
  - min body line ≥ 140°;
  - visibility ≥ 0.4.
- **Trace.**
  - channels have equal lengths, with at least 5 frames per rep;
  - `Σdt` within 10% of `duration_ms`;
  - median frame rate ≥ 10 fps;
  - mean visibility ≥ 0.5.
- **Reps in the trace.** Within each rep's time window, the trace's lowest elbow angle is within
  8° of `min_elbow`, the body line never drops below 140°, and the elbow locks out (≥ 145°)
  between the bottom and the end.
- **Recount.** The server recounts reps from `trace.elbow` with an independent hysteresis
  counter (down ≤ 105°, up ≥ 145°, at least 250 ms below 145°). The result must reach
  `reps_target` and be at least the number of reported reps minus one. The 250 ms is shorter
  than the 400 ms rep minimum because the client may count from a lockout of up to 155°, so a
  fast honest rep spends well under 400 ms below 145°.
- **Synthetic signals.**
  - with 15+ reps, rep durations must not be near-identical (coefficient of variation < 3%);
  - with 5+ reps, the minimum elbow angles must not be (standard deviation < 1°);
  - `dt`, `body` and `vis` must vary: no single value may fill 98% of a channel;
  - the elbow angle may jump more than 35° between frames ≤ 50 ms apart at most
    2 + (1% of frames) times. A tracking glitch causes one jump; a square wave causes two per rep.
- **Replay.** The server stores a keccak-256 fingerprint of the decoded trace channels under a
  unique index, so a trace already submitted for another workout is rejected.

## Web app

`web/`: React 19, Vite, TypeScript, Tailwind 4, react-router, TanStack Query.

**Config.** The chain ID and contract address are compiled into the bundle (`VITE_CHAIN_ID`,
`VITE_PUSHPOT_ADDRESS`) rather than fetched from the API, so a tampered API response can't
redirect what users sign.

**Wallet.** RainbowKit 2 with wagmi 2 and viem 2.56 (which includes the `arc` chain).

- MetaMask is featured; WalletConnect is also offered.
- On mobile browsers without an injected wallet, an "Open in MetaMask" deep link is offered.
- In-app browsers (Instagram, WhatsApp and similar) get a prompt to open the system browser.
- A "Get USDC on Arc" link points to the Arc Portal.

**Pose.** `@mediapipe/tasks-vision` 0.10.35 (pinned: later releases add network telemetry)
with the `pose_landmarker_lite` model.

- Runs in VIDEO mode, on the GPU delegate with a CPU fallback.
- The WASM and model are self-hosted.
- Frames are driven by `requestVideoFrameCallback` on 640×480 front-camera video.
- The skeleton overlay is drawn on a separate 2D canvas.

**Setup check.** Before counting starts, the app checks:

- the near-side shoulder, elbow, wrist, hip and ankle have visibility ≥ 0.6 and are inside the
  frame;
- the body is side-on: shoulder spread ÷ torso length < 0.8;
- the user is in a plank with arms extended for 0.5 s.

**Rep counter.** A pure, unit-tested module:

- *Side selection:* uses the more visible side, with hysteresis.
- *Smoothing:* a median-of-3 filter, then a One Euro filter (min cutoff 1.0 Hz, β 0.02).
- *Frame gating:* a frame counts only if shoulder, hip, elbow and wrist visibility are ≥ 0.5.
- *Down:* elbow ≤ 100° for two frames.
- *Up:* elbow ≥ 150° for two frames.
- *A rep counts only if:*
  - the cycle is ≥ 500 ms;
  - ≥ 500 ms have passed since the last rep;
  - ≥ 5 valid frames, at ≥ 70% valid;
  - min body line ≥ 145°;
  - wrist drift ≤ 0.25 × torso length.
- *Feedback:* partial reps produce "go lower", "lock out", "hips sagging" and "move into frame".

**Feel.**

- A huge rep counter.
- A beep and a haptic pulse per rep (`navigator.vibrate`).
- Confetti on the final rep.
- Wake Lock while the camera is on.
- After a check-in: "Recorded on Arc in 0.9 s" with an explorer link.

## Security

Money is involved, so the defaults are conservative.

**Contract**

- Funds only ever move back to members. The owner can pause new pots and joins, but check-ins,
  leaving and claims are never paused, so a pause can't lock anyone's stake.
- Strict checks-effects-interactions everywhere: state and events first, then the permit, then
  the transfer. All entry points that move tokens are `nonReentrant` (transient-storage guard).
- `SafeERC20` for transfers; `Ownable2Step` for ownership; no native-value paths.
- Tested with:
  - unit tests;
  - a fuzzed conservation test;
  - stateful invariants (balance equals deposits minus withdrawals and covers every pot);
  - Slither. Only the expected timestamp notes remain.

**Server**

- *SIWE.* Checks domain, URI origin, chain, single-use nonce and expiry.
- *Sessions.* A random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with the
  `__Host-` prefix. Only its SHA-256 is stored.
- *CSRF.* Every non-GET `/api` request must carry our exact `Origin`. Bodies must be JSON.
- *Limits.*
  - bodies are capped at 64 KB (512 KB for telemetry);
  - auth endpoints are rate-limited per IP, and workout endpoints per address;
  - each member has at most one open workout and one check-in in flight per period;
  - rejected telemetry is not stored, only its hash and size;
  - at most 2,000 event streams are open at once.
- *RPC URL.* Providers often put an API key in the URL, so errors and logs show only its
  origin.
- *Response headers:*
  - a CSP that allows `'self'` plus the Arc RPC and WalletConnect;
  - `frame-ancestors 'none'`;
  - HSTS;
  - `nosniff`;
  - a Permissions-Policy that allows only the camera.
- *SQL.* Bound parameters only; sqlx rejects dynamically built SQL at compile time.
- *Oracle key.* It can only check members in. It holds a few dollars of gas, and the owner can
  rotate it.

**Web**

- Permits are signed for the exact stake, read from the contract, never from the API.
- Network and balance are checked before every signature.
- The MediaPipe runtime is self-hosted, and the model is pinned by SHA-256.

## Deployment

- **Image.** A multi-stage Dockerfile: Node builds `web/dist`, Rust builds the server, and the
  runtime is a slim Debian image with the binary and static files.
- **Hosting.** Coolify runs the image next to a managed Postgres, with HTTPS on a custom domain.
  Migrations run at startup.
- **Contract.** Deployed with Foundry: first Arc testnet (chain 5042002), then Arc mainnet
  (chain 5042, `https://rpc.mainnet.arc.io`). Verified through Sourcify.

Configuration is through environment variables:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | |
| `PUBLIC_ORIGIN` | |
| `ARC_RPC_URL` | |
| `ARC_WS_URL` | optional; defaults to the WebSocket twin of `ARC_RPC_URL`, `off` to poll only |
| `ARC_CHAIN_ID` | |
| `PUSHPOT_ADDRESS` | |
| `PUSHPOT_DEPLOY_BLOCK` | |
| `ORACLE_PRIVATE_KEY` | |
| `BIND_ADDR` | optional |
| `WEB_DIR` | optional |
| `INDEXER_INTERVAL_MS` | optional, default `5000`; poll interval while the subscription is down |
| `INDEXER_IDLE_MS` | optional, default `300000`; safety poll while it's live |
| `CURATOR_ENABLED` | optional, default `true`; opens official challenges |
| `FEE_COLLECTOR_ENABLED` | optional, default `true`; collects finished pots' fees |

## Testing

- **Contract.** Foundry unit tests for every rule, plus a fuzz test that payouts always sum to
  the total staked.
- **Server.** Unit tests for the telemetry validator and SIWE parsing; integration tests
  against Postgres.
- **Web.** Vitest for the One Euro filter, angle maths and the rep state machine on synthetic
  traces; manual runs on Android Chrome and iOS Safari.
- **End to end.** A pot with three 10 minute periods across two wallets on mainnet.
