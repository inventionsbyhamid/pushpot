//! Server-side checks on the rep telemetry recorded by the browser.
//!
//! The browser counts reps on-device, so the server can't see the video. Instead it checks that
//! the reported reps are physically plausible, that each one shows up in the raw angle trace,
//! recounts them independently and looks for signs of a synthetic signal.

use std::ops::Range;

use alloy::primitives::{B256, Keccak256, keccak256};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// A few degrees looser than the client's 110° and 135°, since one failed rep rejects the workout.
const DOWN_ANGLE: u8 = 115;
const UP_ANGLE: u8 = 140;
const MIN_REP_MS: f64 = 400.0;
/// The recount times a rep from 140°, while the client may already count from its adapted
/// lockout of up to 155°, so a fast honest rep spends well under `MIN_REP_MS` below 140°.
const MIN_RECOUNT_MS: f64 = 250.0;
const MAX_REP_MS: f64 = 8_000.0;
/// The client's shallowest counted rep: lockout at 140°, bottom at 110°.
const MIN_SWING: f64 = 30.0;
const MIN_BODY_LINE: u8 = 130;
const MIN_REP_VISIBILITY: f64 = 0.4;
const MAX_REPS_PER_MINUTE: f64 = 130.0;
const MAX_FRAMES: usize = 60_000;
const MAX_REPS: usize = 1_000;
/// Clients start their clock once `POST /api/workouts` returns, so this only covers latency.
const CLOCK_SLACK_MS: f64 = 1_500.0;
/// How far a rep's reported depth may sit from the lowest trace sample inside the rep.
const DEPTH_TOLERANCE: f64 = 8.0;
/// Even a fast rep moves the smoothed elbow angle well under this between frames ≤ 50 ms apart.
const MAX_ELBOW_STEP: u8 = 35;
const MAX_STEP_DT: u8 = 50;
/// A camera signal never sits on one value for this share of frames.
const MAX_FLAT_SHARE: f64 = 0.98;

#[derive(Debug, Serialize, Deserialize)]
pub struct Telemetry {
    pub v: u8,
    pub workout_id: Uuid,
    pub duration_ms: f64,
    pub reps: Vec<Rep>,
    pub trace: Trace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rep {
    pub start: f64,
    pub bottom: f64,
    pub end: f64,
    pub min_elbow: f64,
    pub max_elbow: f64,
    pub min_body: f64,
    pub vis: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Trace {
    pub dt: String,
    pub elbow: String,
    pub body: String,
    pub vis: String,
}

pub struct Context {
    pub workout_id: Uuid,
    pub reps_target: u32,
    pub server_elapsed_ms: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub reps: u32,
    pub recount: u32,
    /// Identifies the camera trace regardless of the workout it was submitted for.
    pub fingerprint: B256,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum Rejection {
    #[error("unsupported telemetry version")]
    Version,
    #[error("telemetry belongs to a different workout")]
    WrongWorkout,
    #[error("only {counted} of {target} reps were counted")]
    TooFewReps { counted: usize, target: u32 },
    #[error("telemetry is too large")]
    TooLarge,
    #[error("the workout lasted longer than the session")]
    DurationMismatch,
    #[error("reps came faster than humanly plausible")]
    TooFast,
    #[error("rep {0} has inconsistent timing")]
    RepTiming(usize),
    #[error("rep {0} wasn't deep enough")]
    RepRange(usize),
    #[error("rep {0} broke plank form")]
    RepForm(usize),
    #[error("the camera trace is malformed")]
    MalformedTrace,
    #[error("the camera trace is too sparse or choppy")]
    LowFrameRate,
    #[error("you weren't visible clearly enough")]
    LowVisibility,
    #[error("the camera lost track of you too often")]
    TrackingGlitches,
    #[error("the camera trace doesn't match the counted reps")]
    RecountMismatch,
    #[error("the rep pattern looks synthetic")]
    Synthetic,
    #[error("this camera trace was already submitted")]
    Replayed,
}

pub fn evidence_hash(raw_json: &str) -> B256 {
    keccak256(raw_json.as_bytes())
}

pub fn validate(t: &Telemetry, ctx: &Context) -> Result<Verdict, Rejection> {
    if t.v != 1 {
        return Err(Rejection::Version);
    }
    if t.workout_id != ctx.workout_id {
        return Err(Rejection::WrongWorkout);
    }
    if t.reps.len() > MAX_REPS {
        return Err(Rejection::TooLarge);
    }
    if t.reps.len() < ctx.reps_target as usize {
        return Err(Rejection::TooFewReps {
            counted: t.reps.len(),
            target: ctx.reps_target,
        });
    }
    if !t.duration_ms.is_finite()
        || t.duration_ms <= 0.0
        || t.duration_ms > ctx.server_elapsed_ms + CLOCK_SLACK_MS
    {
        return Err(Rejection::DurationMismatch);
    }
    let max_reps = t.duration_ms / 60_000.0 * MAX_REPS_PER_MINUTE + 1.0;
    if t.reps.len() as f64 > max_reps {
        return Err(Rejection::TooFast);
    }

    check_reps(&t.reps, t.duration_ms)?;

    let trace = decode_trace(&t.trace)?;
    check_trace(&trace, t.reps.len(), t.duration_ms)?;
    check_reps_in_trace(&t.reps, &trace)?;

    // The two counters use slightly different thresholds, so allow one rep of disagreement.
    let recount = recount(&trace.elbow, &trace.dt);
    if recount < ctx.reps_target || (recount as usize) + 1 < t.reps.len() {
        return Err(Rejection::RecountMismatch);
    }

    if looks_synthetic(&t.reps) {
        return Err(Rejection::Synthetic);
    }

    Ok(Verdict {
        reps: t.reps.len() as u32,
        recount,
        fingerprint: trace.fingerprint(),
    })
}

fn check_reps(reps: &[Rep], duration_ms: f64) -> Result<(), Rejection> {
    let mut previous_end = 0.0;
    for (i, rep) in reps.iter().enumerate() {
        let n = i + 1;
        let fields = [
            rep.start,
            rep.bottom,
            rep.end,
            rep.min_elbow,
            rep.max_elbow,
            rep.min_body,
        ];
        if fields.iter().any(|v| !v.is_finite()) {
            return Err(Rejection::RepTiming(n));
        }
        let length = rep.end - rep.start;
        let ordered = rep.start >= previous_end && rep.start <= rep.bottom && rep.bottom <= rep.end;
        let spaced = i == 0 || rep.end - previous_end >= MIN_REP_MS;
        if !ordered || !spaced || !(MIN_REP_MS..=MAX_REP_MS).contains(&length) {
            return Err(Rejection::RepTiming(n));
        }
        if rep.end > duration_ms + 1_000.0 {
            return Err(Rejection::RepTiming(n));
        }
        if rep.min_elbow > f64::from(DOWN_ANGLE)
            || rep.max_elbow < f64::from(UP_ANGLE)
            || rep.max_elbow - rep.min_elbow < MIN_SWING
        {
            return Err(Rejection::RepRange(n));
        }
        if rep.min_body < f64::from(MIN_BODY_LINE) {
            return Err(Rejection::RepForm(n));
        }
        if rep.vis < MIN_REP_VISIBILITY {
            return Err(Rejection::LowVisibility);
        }
        previous_end = rep.end;
    }
    Ok(())
}

struct DecodedTrace {
    dt: Vec<u8>,
    elbow: Vec<u8>,
    body: Vec<u8>,
    vis: Vec<u8>,
}

impl DecodedTrace {
    /// Each frame's time on the workout clock, the same clock rep times use.
    fn times(&self) -> Vec<f64> {
        self.dt
            .iter()
            .scan(0.0, |t, &delta| {
                *t += f64::from(delta);
                Some(*t)
            })
            .collect()
    }

    fn fingerprint(&self) -> B256 {
        let mut hasher = Keccak256::new();
        for channel in [&self.dt, &self.elbow, &self.body, &self.vis] {
            hasher.update(channel);
        }
        hasher.finalize()
    }
}

fn decode_trace(trace: &Trace) -> Result<DecodedTrace, Rejection> {
    let decode = |s: &str| STANDARD.decode(s).map_err(|_| Rejection::MalformedTrace);
    let dt = decode(&trace.dt)?;
    let elbow = decode(&trace.elbow)?;
    let body = decode(&trace.body)?;
    let vis = decode(&trace.vis)?;

    if dt.len() > MAX_FRAMES {
        return Err(Rejection::TooLarge);
    }
    if dt.len() != elbow.len() || dt.len() != body.len() || dt.len() != vis.len() {
        return Err(Rejection::MalformedTrace);
    }
    if elbow.iter().chain(&body).any(|&deg| deg > 180) {
        return Err(Rejection::MalformedTrace);
    }
    Ok(DecodedTrace {
        dt,
        elbow,
        body,
        vis,
    })
}

fn check_trace(trace: &DecodedTrace, reps: usize, duration_ms: f64) -> Result<(), Rejection> {
    let frames = trace.dt.len();
    if frames < reps * 5 || frames == 0 {
        return Err(Rejection::LowFrameRate);
    }

    // The client's workout clock advances by exactly the recorded frame intervals.
    let total: f64 = trace.dt.iter().map(|&d| f64::from(d)).sum();
    if (total - duration_ms).abs() > duration_ms * 0.1 {
        return Err(Rejection::MalformedTrace);
    }

    let mut sorted = trace.dt.clone();
    sorted.sort_unstable();
    if sorted[frames / 2] > 100 {
        return Err(Rejection::LowFrameRate);
    }

    let mean_vis = trace.vis.iter().map(|&v| f64::from(v)).sum::<f64>() / frames as f64;
    if mean_vis < 0.5 * 255.0 {
        return Err(Rejection::LowVisibility);
    }

    let flat = flat_value(&trace.dt).is_some()
        || flat_value(&trace.body).is_some()
        // A confident pose model can pin visibility at the top of the scale.
        || flat_value(&trace.vis).is_some_and(|v| v != u8::MAX);
    if flat {
        return Err(Rejection::Synthetic);
    }

    // Side switches and re-acquiring a lost pose can each cause one jump; a square wave has two
    // per rep.
    if elbow_jumps(&trace.elbow, &trace.dt) > 2 + frames / 100 {
        return Err(Rejection::TrackingGlitches);
    }
    Ok(())
}

/// The value that fills nearly all of `channel`, if any.
fn flat_value(channel: &[u8]) -> Option<u8> {
    let mut counts = [0usize; 256];
    for &value in channel {
        counts[usize::from(value)] += 1;
    }
    let (value, count) = counts.into_iter().enumerate().max_by_key(|&(_, n)| n)?;
    (count as f64 >= channel.len() as f64 * MAX_FLAT_SHARE).then_some(value as u8)
}

fn elbow_jumps(elbow: &[u8], dt: &[u8]) -> usize {
    elbow
        .windows(2)
        .zip(dt.iter().skip(1))
        .filter(|&(pair, &delta)| {
            delta <= MAX_STEP_DT && pair[0].abs_diff(pair[1]) > MAX_ELBOW_STEP
        })
        .count()
}

/// Every reported rep must be visible in the trace: a bottom close to the reported depth, a
/// straight body throughout, and a lockout before it ends.
fn check_reps_in_trace(reps: &[Rep], trace: &DecodedTrace) -> Result<(), Rejection> {
    let times = trace.times();
    let window = |from: f64, to: f64| -> Range<usize> {
        times.partition_point(|&t| t < from)..times.partition_point(|&t| t <= to)
    };

    for (i, rep) in reps.iter().enumerate() {
        let frames = window(rep.start, rep.end);
        let Some(&lowest) = trace.elbow[frames.clone()].iter().min() else {
            return Err(Rejection::RecountMismatch);
        };
        if (f64::from(lowest) - rep.min_elbow).abs() > DEPTH_TOLERANCE {
            return Err(Rejection::RecountMismatch);
        }
        if trace.body[frames].iter().any(|&deg| deg < MIN_BODY_LINE) {
            return Err(Rejection::RepForm(i + 1));
        }
        if !trace.elbow[window(rep.bottom, rep.end)]
            .iter()
            .any(|&deg| deg >= UP_ANGLE)
        {
            return Err(Rejection::RecountMismatch);
        }
    }
    Ok(())
}

/// Counts reps with a simple hysteresis on the elbow angle, independent of the client's counter.
pub fn recount(elbow: &[u8], dt: &[u8]) -> u32 {
    let mut count = 0;
    let mut t = 0.0;
    let mut down = false;
    let mut left_top_at: Option<f64> = None;

    for (&angle, &delta) in elbow.iter().zip(dt) {
        t += f64::from(delta);
        if !down {
            if angle < UP_ANGLE {
                left_top_at.get_or_insert(t);
            } else {
                left_top_at = None;
            }
            if angle <= DOWN_ANGLE {
                down = true;
            }
        } else if angle >= UP_ANGLE {
            if left_top_at.is_some_and(|start| t - start >= MIN_RECOUNT_MS) {
                count += 1;
            }
            down = false;
            left_top_at = None;
        }
    }
    count
}

fn looks_synthetic(reps: &[Rep]) -> bool {
    let durations: Vec<f64> = reps.iter().map(|r| r.end - r.start).collect();
    let bottoms: Vec<f64> = reps.iter().map(|r| r.min_elbow).collect();

    let (mean, std) = mean_std(&durations);
    let uniform_timing = reps.len() >= 15 && mean > 0.0 && std / mean < 0.03;
    let uniform_depth = reps.len() >= 5 && mean_std(&bottoms).1 < 1.0;
    uniform_timing || uniform_depth
}

fn mean_std(values: &[f64]) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    (mean, variance.sqrt())
}

#[cfg(test)]
pub mod fixtures {
    use std::f64::consts::{PI, TAU};

    use base64::{Engine, engine::general_purpose::STANDARD};
    use uuid::Uuid;

    use super::{Rep, Telemetry, Trace};

    const TOP: f64 = 165.0;

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }

        /// Uniform noise in ±`scale / 2`.
        fn noise(&mut self, scale: f64) -> f64 {
            (self.next() - 0.5) * scale
        }
    }

    /// Simulated pushups, recorded the way the browser does it: ~30 fps with frame-timing jitter
    /// and `dt[0] == 0`, an elbow dipping from `top` to `bottom` with a pause at the top, a body
    /// line that sags a little on the way down, and noisy visibility. Rep summaries are read off
    /// the trace like the client's counter does: a rep starts below `lockout` and ends on the
    /// second frame back above it. With `jitter` off, the reps themselves are machine-regular;
    /// sensor noise remains.
    pub struct Pushups {
        pub reps: usize,
        /// One rep, top to top.
        pub rep_ms: f64,
        pub top: f64,
        pub bottom: f64,
        pub lockout: f64,
        pub body: u8,
        pub jitter: bool,
    }

    impl Default for Pushups {
        fn default() -> Self {
            Self {
                reps: 10,
                rep_ms: 1_200.0,
                top: TOP,
                bottom: 82.0,
                lockout: 150.0,
                body: 165,
                jitter: true,
            }
        }
    }

    pub fn session(
        workout_id: Uuid,
        reps: usize,
        rep_ms: f64,
        bottom: f64,
        body: u8,
        jitter: bool,
    ) -> Telemetry {
        Pushups {
            reps,
            rep_ms,
            bottom,
            body,
            jitter,
            ..Pushups::default()
        }
        .record(workout_id)
    }

    impl Pushups {
        pub fn record(&self, workout_id: Uuid) -> Telemetry {
            let mut rng = Lcg(42);
            let jitter = self.jitter;
            let human = |rng: &mut Lcg, scale: f64| if jitter { rng.noise(scale) } else { 0.0 };

            let mut cycles = Vec::with_capacity(self.reps);
            let mut t = 300.0;
            for _ in 0..self.reps {
                let length = self.rep_ms * (1.0 + human(&mut rng, 0.2));
                let depth = self.bottom + human(&mut rng, 6.0);
                cycles.push((t, length, depth));
                t += length + 300.0 + human(&mut rng, 300.0);
            }
            let end = t;

            let (mut dt, mut elbow, mut body_line, mut vis, mut times) =
                (vec![], vec![], vec![], vec![], vec![]);
            let mut t = 0.0;
            while t <= end {
                let step = if dt.is_empty() {
                    0.0
                } else {
                    (33.0 + rng.noise(6.0)).round()
                };
                t += step;
                let rep = cycles
                    .iter()
                    .find(|&&(start, length, _)| (start..start + length).contains(&t));
                let (angle, sag) = rep.map_or((self.top, 0.0), |&(start, length, depth)| {
                    let phase = (t - start) / length;
                    let mid = (self.top + depth) / 2.0;
                    (
                        mid + (self.top - mid) * (TAU * phase).cos(),
                        3.0 * (PI * phase).sin(),
                    )
                });
                dt.push(step as u8);
                times.push(t);
                elbow.push(degrees(angle + rng.noise(3.0)));
                body_line.push(degrees(f64::from(self.body) - sag + rng.noise(3.0)));
                vis.push((225.0 + rng.noise(20.0)).round() as u8);
            }

            let below = |i: usize| f64::from(elbow[i]) < self.lockout;
            let summaries = cycles
                .iter()
                .map(|&(start, _, _)| {
                    let first = (0..times.len())
                        .find(|&i| times[i] >= start && below(i))
                        .unwrap();
                    let lowest = (first..times.len())
                        .take_while(|&i| below(i))
                        .min_by_key(|&i| elbow[i])
                        .unwrap();
                    let last = (lowest + 1..times.len())
                        .find(|&i| !below(i - 1) && !below(i))
                        .unwrap();
                    let frames = first..=last;
                    let mean_vis = frames.clone().map(|i| f64::from(vis[i])).sum::<f64>()
                        / frames.clone().count() as f64
                        / 255.0;
                    Rep {
                        start: times[first],
                        bottom: times[lowest],
                        end: times[last],
                        min_elbow: f64::from(elbow[lowest]),
                        max_elbow: f64::from(frames.clone().map(|i| elbow[i]).max().unwrap()),
                        min_body: f64::from(frames.map(|i| body_line[i]).min().unwrap()),
                        vis: (mean_vis * 100.0).round() / 100.0,
                    }
                })
                .collect();

            Telemetry {
                v: 1,
                workout_id,
                duration_ms: t,
                reps: summaries,
                trace: Trace {
                    dt: STANDARD.encode(&dt),
                    elbow: STANDARD.encode(&elbow),
                    body: STANDARD.encode(&body_line),
                    vis: STANDARD.encode(&vis),
                },
            }
        }
    }

    /// The cheapest forgery: a square-wave elbow at a fixed frame rate, summaries to match.
    /// With `noisy_channels`, the other channels get the noise a real camera would add.
    pub fn square_wave(workout_id: Uuid, reps: usize, noisy_channels: bool) -> Telemetry {
        let mut rng = Lcg(7);
        let mut noise = |scale: f64| {
            if noisy_channels {
                rng.noise(scale).round()
            } else {
                0.0
            }
        };
        let (mut dt, mut elbow, mut body, mut vis) = (vec![], vec![], vec![], vec![]);
        let mut summaries = vec![];
        let mut t = 0.0;
        for i in 0..reps {
            for frame in 0..16 {
                let step = if dt.is_empty() {
                    0.0
                } else {
                    33.0 + noise(6.0)
                };
                t += step;
                if frame == 2 {
                    summaries.push(Rep {
                        start: t,
                        bottom: t,
                        end: t + 13.0 * 33.0,
                        min_elbow: 78.0 + (i % 7) as f64 * 2.0,
                        max_elbow: TOP,
                        min_body: 170.0,
                        vis: 0.9,
                    });
                }
                dt.push(step as u8);
                elbow.push(if frame < 2 {
                    TOP as u8
                } else {
                    78 + (i % 7) as u8 * 2
                });
                body.push((170.0 + noise(4.0)) as u8);
                vis.push((200.0 + noise(20.0)) as u8);
            }
        }
        for _ in 0..2 {
            t += 33.0;
            dt.push(33);
            elbow.push(TOP as u8);
            body.push(170);
            vis.push(200);
        }
        Telemetry {
            v: 1,
            workout_id,
            duration_ms: t,
            reps: summaries,
            trace: Trace {
                dt: STANDARD.encode(&dt),
                elbow: STANDARD.encode(&elbow),
                body: STANDARD.encode(&body),
                vis: STANDARD.encode(&vis),
            },
        }
    }

    fn degrees(value: f64) -> u8 {
        value.round().clamp(0.0, 180.0) as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Session {
        telemetry: Telemetry,
        workout_id: Uuid,
    }

    fn session(reps: usize, rep_ms: f64, bottom: f64, body: u8, jitter: bool) -> Session {
        let workout_id = Uuid::new_v4();
        let telemetry = fixtures::session(workout_id, reps, rep_ms, bottom, body, jitter);
        Session {
            telemetry,
            workout_id,
        }
    }

    fn ctx(s: &Session, target: u32) -> Context {
        Context {
            workout_id: s.workout_id,
            reps_target: target,
            server_elapsed_ms: s.telemetry.duration_ms + 2_000.0,
        }
    }

    fn channel(s: &Session, pick: fn(&Trace) -> &String) -> Vec<u8> {
        STANDARD.decode(pick(&s.telemetry.trace)).unwrap()
    }

    #[test]
    fn accepts_a_real_looking_session() {
        let s = session(10, 1_200.0, 82.0, 165, true);
        let verdict = validate(&s.telemetry, &ctx(&s, 10)).unwrap();
        assert_eq!(verdict.reps, 10);
        assert!(verdict.recount >= 10, "recount {}", verdict.recount);
    }

    #[test]
    fn accepts_fast_slow_and_long_sessions() {
        for (reps, rep_ms, bottom) in [(5, 800.0, 95.0), (30, 1_000.0, 80.0), (20, 2_500.0, 70.0)] {
            let s = session(reps, rep_ms, bottom, 172, true);
            let result = validate(&s.telemetry, &ctx(&s, reps as u32));
            assert!(result.is_ok(), "{reps} × {rep_ms} ms: {result:?}");
        }
    }

    #[test]
    fn counts_fast_reps_after_the_client_lockout_adapted_to_155() {
        // From a 167° top the client raises its lockout to 155°. Its 600 ms reps still last
        // over 400 ms from that lockout, but some spend under 400 ms below the recount's 140°.
        let workout_id = Uuid::new_v4();
        let telemetry = fixtures::Pushups {
            reps: 12,
            rep_ms: 600.0,
            top: 167.0,
            bottom: 85.0,
            lockout: 155.0,
            ..Default::default()
        }
        .record(workout_id);

        let trace = decode_trace(&telemetry.trace).unwrap();
        let times = trace.times();
        let below_lockout = |rep: &Rep| -> f64 {
            times
                .iter()
                .zip(&trace.elbow)
                .zip(&trace.dt)
                .filter(|&((&t, &deg), _)| (rep.start..=rep.end).contains(&t) && deg < UP_ANGLE)
                .map(|(_, &dt)| f64::from(dt))
                .sum()
        };
        assert!(
            telemetry
                .reps
                .iter()
                .all(|rep| rep.end - rep.start >= MIN_REP_MS)
        );
        assert!(
            telemetry
                .reps
                .iter()
                .any(|rep| below_lockout(rep) < MIN_REP_MS)
        );

        let context = Context {
            workout_id,
            reps_target: 12,
            server_elapsed_ms: telemetry.duration_ms,
        };
        let verdict = validate(&telemetry, &context).unwrap();
        assert_eq!(verdict.recount, 12);
    }

    #[test]
    fn accepts_the_shallowest_reps_the_client_counts() {
        // Arms that read 145° when straight, a bottom short of 90° and a slight bend at the hips.
        let workout_id = Uuid::new_v4();
        let telemetry = fixtures::Pushups {
            top: 145.0,
            bottom: 104.0,
            lockout: 140.0,
            body: 140,
            ..Default::default()
        }
        .record(workout_id);
        let context = Context {
            workout_id,
            reps_target: 10,
            server_elapsed_ms: telemetry.duration_ms,
        };
        let verdict = validate(&telemetry, &context).unwrap();
        assert_eq!(verdict.recount, 10);
    }

    #[test]
    fn rejects_too_few_reps() {
        let s = session(8, 1_200.0, 82.0, 165, true);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::TooFewReps {
                counted: 8,
                target: 10
            })
        );
    }

    #[test]
    fn rejects_reps_that_are_too_quick() {
        let s = session(10, 350.0, 82.0, 165, true);
        assert!(matches!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::RepTiming(_) | Rejection::TooFast)
        ));
    }

    #[test]
    fn rejects_shallow_reps() {
        let s = session(10, 1_200.0, 130.0, 165, true);
        assert!(matches!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::RepRange(_))
        ));
    }

    #[test]
    fn rejects_sagging_body() {
        let s = session(10, 1_200.0, 82.0, 120, true);
        assert!(matches!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::RepForm(_))
        ));
    }

    #[test]
    fn rejects_a_sag_the_summaries_leave_out() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        let rep = s.telemetry.reps[2].clone();
        let times = decode_trace(&s.telemetry.trace).unwrap().times();
        let mut body = channel(&s, |t| &t.body);
        for (deg, &t) in body.iter_mut().zip(&times) {
            if (rep.bottom..=rep.end).contains(&t) {
                *deg = 125;
            }
        }
        s.telemetry.trace.body = STANDARD.encode(body);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::RepForm(3))
        );
    }

    #[test]
    fn binds_the_duration_to_the_server_clock() {
        let s = session(10, 1_200.0, 82.0, 165, true);
        let mut context = ctx(&s, 10);
        context.server_elapsed_ms = s.telemetry.duration_ms - 1_000.0;
        assert!(validate(&s.telemetry, &context).is_ok());
        context.server_elapsed_ms = s.telemetry.duration_ms - 2_000.0;
        assert_eq!(
            validate(&s.telemetry, &context),
            Err(Rejection::DurationMismatch)
        );
    }

    #[test]
    fn rejects_a_duration_the_frames_dont_add_up_to() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        s.telemetry.duration_ms *= 1.15;
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::MalformedTrace)
        );
    }

    #[test]
    fn rejects_wrong_workout() {
        let s = session(10, 1_200.0, 82.0, 165, true);
        let mut context = ctx(&s, 10);
        context.workout_id = Uuid::new_v4();
        assert_eq!(
            validate(&s.telemetry, &context),
            Err(Rejection::WrongWorkout)
        );
    }

    #[test]
    fn rejects_mismatched_trace_lengths() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        s.telemetry.trace.vis = STANDARD.encode([230u8; 3]);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::MalformedTrace)
        );
    }

    #[test]
    fn rejects_reps_missing_from_trace() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        let flat = vec![165u8; channel(&s, |t| &t.elbow).len()];
        s.telemetry.trace.elbow = STANDARD.encode(flat);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::RecountMismatch)
        );
    }

    #[test]
    fn rejects_rep_depths_the_trace_doesnt_show() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        s.telemetry.reps[4].min_elbow += 12.0;
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
            Err(Rejection::RecountMismatch)
        );
    }

    #[test]
    fn recount_must_cover_all_but_one_reported_rep() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        // Three reps stop at 122° in the trace while their summaries claim 115°: close enough
        // to pass the per-rep check, but not a rep to the independent counter.
        let times = decode_trace(&s.telemetry.trace).unwrap().times();
        let mut elbow = channel(&s, |t| &t.elbow);
        for rep in &mut s.telemetry.reps[..3] {
            for (deg, &t) in elbow.iter_mut().zip(&times) {
                if (rep.start..=rep.end).contains(&t) {
                    *deg = (*deg).max(122);
                }
            }
            rep.min_elbow = 115.0;
        }
        s.telemetry.trace.elbow = STANDARD.encode(elbow);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 5)),
            Err(Rejection::RecountMismatch)
        );
    }

    #[test]
    fn rejects_perfectly_regular_reps() {
        let s = session(20, 1_200.0, 82.0, 165, false);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 20)),
            Err(Rejection::Synthetic)
        );
    }

    #[test]
    fn rejects_constant_channels() {
        let base = session(10, 1_200.0, 82.0, 165, true);
        let frames = channel(&base, |t| &t.dt).len();
        let flatteners: [fn(&mut Telemetry, usize); 3] = [
            |t: &mut Telemetry, n: usize| t.trace.body = STANDARD.encode(vec![170u8; n]),
            |t: &mut Telemetry, n: usize| t.trace.vis = STANDARD.encode(vec![230u8; n]),
            |t: &mut Telemetry, n: usize| {
                let mut dt = vec![33u8; n];
                dt[0] = 0;
                t.trace.dt = STANDARD.encode(dt);
                t.duration_ms = 33.0 * (n - 1) as f64;
            },
        ];
        for flatten in flatteners {
            let mut s = session(10, 1_200.0, 82.0, 165, true);
            flatten(&mut s.telemetry, frames);
            assert_eq!(
                validate(&s.telemetry, &ctx(&s, 10)),
                Err(Rejection::Synthetic)
            );
        }
    }

    #[test]
    fn accepts_visibility_pinned_at_full_confidence() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        let frames = channel(&s, |t| &t.vis).len();
        s.telemetry.trace.vis = STANDARD.encode(vec![255u8; frames]);
        assert!(validate(&s.telemetry, &ctx(&s, 10)).is_ok());
    }

    #[test]
    fn rejects_a_forged_square_wave() {
        let workout_id = Uuid::new_v4();
        let context = |t: &Telemetry| Context {
            workout_id,
            reps_target: 10,
            server_elapsed_ms: t.duration_ms + 2_000.0,
        };

        let forged = fixtures::square_wave(workout_id, 10, false);
        assert_eq!(
            validate(&forged, &context(&forged)),
            Err(Rejection::Synthetic)
        );

        let forged = fixtures::square_wave(workout_id, 10, true);
        assert_eq!(
            validate(&forged, &context(&forged)),
            Err(Rejection::TrackingGlitches)
        );
    }

    #[test]
    fn tolerates_a_few_tracking_glitches() {
        let mut s = session(10, 1_200.0, 82.0, 165, true);
        let mut elbow = channel(&s, |t| &t.elbow);
        // A one-frame spike, like the pose being re-acquired after an occlusion.
        elbow[3] = 120;
        s.telemetry.trace.elbow = STANDARD.encode(elbow);
        assert!(validate(&s.telemetry, &ctx(&s, 10)).is_ok());
    }

    #[test]
    fn fingerprint_identifies_the_trace_not_the_workout() {
        // The fixture is deterministic, so both workouts carry the same trace.
        let original = session(10, 1_200.0, 82.0, 165, true);
        let mut replayed = session(10, 1_200.0, 82.0, 165, true);
        assert_ne!(original.workout_id, replayed.workout_id);
        let fingerprint = |s: &Session| validate(&s.telemetry, &ctx(s, 10)).unwrap().fingerprint;
        assert_eq!(fingerprint(&replayed), fingerprint(&original));

        let mut vis = channel(&replayed, |t| &t.vis);
        vis[0] = vis[0].wrapping_add(1);
        replayed.telemetry.trace.vis = STANDARD.encode(vis);
        assert_ne!(fingerprint(&replayed), fingerprint(&original));
    }

    #[test]
    fn recount_ignores_jitter_at_the_top() {
        let elbow = [160, 146, 144, 147, 143, 150, 160];
        assert_eq!(recount(&elbow, &[33; 7]), 0);
    }

    #[test]
    fn evidence_hash_is_keccak_of_raw_json() {
        assert_eq!(evidence_hash("{}"), keccak256(b"{}"));
    }
}
