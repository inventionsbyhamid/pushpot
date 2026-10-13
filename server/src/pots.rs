use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

/// Mirrors `PushPot.GRACE`: check-ins for a period are accepted this long after it closes.
pub const GRACE: Duration = Duration::minutes(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Upcoming,
    Active,
    Ended,
}

#[derive(Debug, Clone, Copy)]
pub struct Schedule {
    pub start: DateTime<Utc>,
    pub period_seconds: i64,
    pub periods: i32,
}

impl Schedule {
    pub fn end(&self) -> DateTime<Utc> {
        self.period_start(self.periods)
    }

    pub fn period_start(&self, period: i32) -> DateTime<Utc> {
        self.start + Duration::seconds(self.period_seconds * i64::from(period))
    }

    pub fn period_end(&self, period: i32) -> DateTime<Utc> {
        self.period_start(period + 1)
    }

    pub fn status(&self, now: DateTime<Utc>) -> Status {
        if now < self.start {
            Status::Upcoming
        } else if now < self.end() {
            Status::Active
        } else {
            Status::Ended
        }
    }

    pub fn current_period(&self, now: DateTime<Utc>) -> Option<i32> {
        (self.status(now) == Status::Active)
            .then(|| ((now - self.start).num_seconds() / self.period_seconds) as i32)
    }

    /// Whether a check-in for `period` would still be accepted by the contract at `now`.
    pub fn accepts_check_in(&self, period: i32, now: DateTime<Utc>) -> bool {
        (0..self.periods).contains(&period)
            && now >= self.period_start(period)
            && now < self.period_end(period) + GRACE
    }

    /// Whether the contract has stopped accepting check-ins for every period.
    pub fn check_ins_closed(&self, now: DateTime<Utc>) -> bool {
        now >= self.end() + GRACE
    }

    /// Returns `(completed, out)` for a member who checked in for `checked_in` periods.
    pub fn progress(&self, checked_in: &[i32], now: DateTime<Utc>) -> (bool, bool) {
        let completed = (0..self.periods).all(|p| checked_in.contains(&p));
        let closed = match self.status(now) {
            Status::Upcoming => 0,
            Status::Active => self.current_period(now).unwrap_or(0),
            Status::Ended => self.periods,
        };
        let out =
            (0..closed).any(|p| !checked_in.contains(&p) && now >= self.period_end(p) + GRACE);
        (completed, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).unwrap() + Duration::minutes(minutes)
    }

    fn sprint() -> Schedule {
        Schedule {
            start: at(0),
            period_seconds: 600,
            periods: 3,
        }
    }

    #[test]
    fn status_and_current_period() {
        let s = sprint();
        assert_eq!(s.status(at(-1)), Status::Upcoming);
        assert_eq!(s.current_period(at(-1)), None);
        assert_eq!(s.status(at(0)), Status::Active);
        assert_eq!(s.current_period(at(0)), Some(0));
        assert_eq!(s.current_period(at(10)), Some(1));
        assert_eq!(s.current_period(at(29)), Some(2));
        assert_eq!(s.status(at(30)), Status::Ended);
        assert_eq!(s.current_period(at(30)), None);
    }

    #[test]
    fn check_in_window_includes_grace() {
        let s = sprint();
        assert!(!s.accepts_check_in(0, at(-1)));
        assert!(s.accepts_check_in(0, at(9)));
        assert!(s.accepts_check_in(0, at(14)));
        assert!(!s.accepts_check_in(0, at(15)));
        assert!(!s.accepts_check_in(1, at(9)));
        assert!(!s.accepts_check_in(3, at(31)));
        assert!(!s.check_ins_closed(at(34)));
        assert!(s.check_ins_closed(at(35)));
    }

    #[test]
    fn member_is_out_only_after_grace_of_a_missed_period() {
        let s = sprint();
        assert_eq!(s.progress(&[], at(5)), (false, false));
        assert_eq!(s.progress(&[], at(12)), (false, false));
        assert_eq!(s.progress(&[], at(15)), (false, true));
        assert_eq!(s.progress(&[0], at(15)), (false, false));
        assert_eq!(s.progress(&[0, 1, 2], at(31)), (true, false));
        assert_eq!(s.progress(&[0, 2], at(40)), (false, true));
    }
}
