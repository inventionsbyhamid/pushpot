//! Server-side checks on the rep telemetry recorded by the browser.
//!
//! The browser counts reps on-device, so the server can't see the video. Instead it checks that
//! the reported reps are physically plausible, recounts them from the raw elbow-angle trace and
//! looks for signs of a synthetic signal.

use alloy::primitives::{B256, keccak256};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const DOWN_ANGLE: u8 = 105;
const UP_ANGLE: u8 = 145;
const MIN_REP_MS: f64 = 400.0;
const MAX_REP_MS: f64 = 8_000.0;
const MIN_SWING: f64 = 45.0;
const MIN_BODY_LINE: f64 = 140.0;
const MIN_REP_VISIBILITY: f64 = 0.4;
const MAX_REPS_PER_MINUTE: f64 = 130.0;
const MAX_FRAMES: usize = 60_000;
const MAX_REPS: usize = 1_000;

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
    #[error("the camera trace doesn't match the counted reps")]
    RecountMismatch,
    #[error("the rep pattern looks synthetic")]
    Synthetic,
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
        || t.duration_ms > ctx.server_elapsed_ms + 5_000.0
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

    let recount = recount(&trace.elbow, &trace.dt);
    if recount < ctx.reps_target {
        return Err(Rejection::RecountMismatch);
    }

    if looks_synthetic(&t.reps) {
        return Err(Rejection::Synthetic);
    }

    Ok(Verdict {
        reps: t.reps.len() as u32,
        recount,
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
        if rep.min_body < MIN_BODY_LINE {
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
    vis: Vec<u8>,
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
    Ok(DecodedTrace { dt, elbow, vis })
}

fn check_trace(trace: &DecodedTrace, reps: usize, duration_ms: f64) -> Result<(), Rejection> {
    let frames = trace.dt.len();
    if frames < reps * 5 || frames == 0 {
        return Err(Rejection::LowFrameRate);
    }

    // `dt` is capped at 255 ms per frame, so a paused or stalled camera makes the sum fall short
    // of the wall-clock duration; only an overshoot is impossible.
    let total: f64 = trace.dt.iter().map(|&d| f64::from(d)).sum();
    if total > duration_ms * 1.1 + 500.0 || total < duration_ms * 0.6 {
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
            if left_top_at.is_some_and(|start| t - start >= MIN_REP_MS) {
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
    use std::f64::consts::TAU;

    use base64::{Engine, engine::general_purpose::STANDARD};
    use uuid::Uuid;

    use super::{Rep, Telemetry, Trace};

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// Simulates `reps` pushups: elbow angle swings between ~80° and ~165°, ~30 fps, with jitter
    /// in timing and depth like a real person.
    pub fn session(
        workout_id: Uuid,
        reps: usize,
        rep_ms: f64,
        bottom: f64,
        body: u8,
        jitter: bool,
    ) -> Telemetry {
        let mut rng = Lcg(42);
        let mut noise = |scale: f64| {
            if jitter {
                (rng.next() - 0.5) * scale
            } else {
                0.0
            }
        };

        let cycles: Vec<f64> = (0..reps).map(|_| rep_ms * (1.0 + noise(0.2))).collect();
        let total: f64 = cycles.iter().sum::<f64>() + 600.0;

        let (mut dt, mut elbow, mut body_trace, mut vis) = (vec![], vec![], vec![], vec![]);
        let mut summaries: Vec<Rep> = vec![];
        let depths: Vec<f64> = (0..reps).map(|_| bottom + noise(6.0)).collect();

        let mut t = 0.0;
        while t < total {
            let step = 33.0 + noise(6.0);
            t += step;
            let (mut cycle_start, mut angle) = (300.0, 165.0);
            for (k, &len) in cycles.iter().enumerate() {
                if t >= cycle_start && t < cycle_start + len {
                    let phase = (t - cycle_start) / len;
                    let mid = (165.0 + depths[k]) / 2.0;
                    angle = mid + (165.0 - mid) * (TAU * phase).cos();
                    break;
                }
                cycle_start += len;
            }
            dt.push(step.round() as u8);
            elbow.push((angle + noise(3.0)).round().clamp(0.0, 180.0) as u8);
            body_trace.push(body);
            vis.push(230);
        }

        let mut cycle_start = 300.0;
        for (k, &len) in cycles.iter().enumerate() {
            summaries.push(Rep {
                start: cycle_start,
                bottom: cycle_start + len / 2.0,
                end: cycle_start + len,
                min_elbow: depths[k],
                max_elbow: 165.0,
                min_body: f64::from(body),
                vis: 0.9,
            });
            cycle_start += len;
        }

        Telemetry {
            v: 1,
            workout_id,
            duration_ms: t,
            reps: summaries,
            trace: Trace {
                dt: STANDARD.encode(&dt),
                elbow: STANDARD.encode(&elbow),
                body: STANDARD.encode(&body_trace),
                vis: STANDARD.encode(&vis),
            },
        }
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

    #[test]
    fn accepts_a_real_looking_session() {
        let s = session(10, 1_200.0, 82.0, 165, true);
        let verdict = validate(&s.telemetry, &ctx(&s, 10)).unwrap();
        assert_eq!(verdict.reps, 10);
        assert!(verdict.recount >= 10, "recount {}", verdict.recount);
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
        let s = session(10, 1_200.0, 120.0, 165, true);
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
    fn rejects_session_longer_than_server_saw() {
        let s = session(10, 1_200.0, 82.0, 165, true);
        let mut context = ctx(&s, 10);
        context.server_elapsed_ms = s.telemetry.duration_ms - 6_000.0;
        assert_eq!(
            validate(&s.telemetry, &context),
            Err(Rejection::DurationMismatch)
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
        let flat = vec![165u8; STANDARD.decode(&s.telemetry.trace.elbow).unwrap().len()];
        s.telemetry.trace.elbow = STANDARD.encode(flat);
        assert_eq!(
            validate(&s.telemetry, &ctx(&s, 10)),
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
    fn recount_ignores_jitter_at_the_top() {
        let elbow = [160, 146, 144, 147, 143, 150, 160];
        assert_eq!(recount(&elbow, &[33; 7]), 0);
    }

    #[test]
    fn evidence_hash_is_keccak_of_raw_json() {
        assert_eq!(evidence_hash("{}"), keccak256(b"{}"));
    }
}
