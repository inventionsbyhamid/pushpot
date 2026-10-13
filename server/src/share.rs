//! Link previews for pot pages. Chat apps don't run JavaScript, so `/p/:id` is served with the
//! pot's own title and terms baked into the meta tags.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};

use crate::{
    api::pots::{PotRow, find_pot},
    state::AppState,
};

pub async fn pot_page(State(state): State<AppState>, Path(id): Path<i64>) -> Response {
    let Some(index) = state.index_html.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(pot) = find_pot(&state, id).await else {
        return Html(index.to_owned()).into_response();
    };
    let (title, description) = describe(&pot);
    let url = format!("{}/p/{id}", state.config.origin());
    Html(with_meta(index, &title, &description, &url)).into_response()
}

pub fn describe(pot: &PotRow) -> (String, String) {
    let title = format!("Join “{}” on PushPot", pot.title);
    let cadence = if pot.period_seconds == 86_400 {
        format!(
            "{} pushups a day for {} days",
            pot.reps_per_period, pot.periods
        )
    } else {
        format!(
            "{} pushups every {} for {} rounds",
            pot.reps_per_period,
            human_duration(pot.period_seconds),
            pot.periods
        )
    };
    let members = match pot.member_count {
        1 => "1 player in".to_owned(),
        n => format!("{n} players in"),
    };
    let description = format!(
        "{cadence}. {} USDC stake, {members}. Miss one and your stake goes to the ones who finish.",
        format_usdc(pot.stake)
    );
    (title, description)
}

fn with_meta(index: &str, title: &str, description: &str, url: &str) -> String {
    let mut html = replace_between(index, "<title>", "</title>", &escape(title));
    for (attr, value) in [
        ("property=\"og:title\" content=\"", title),
        ("name=\"twitter:title\" content=\"", title),
        ("name=\"description\" content=\"", description),
        ("property=\"og:description\" content=\"", description),
        ("name=\"twitter:description\" content=\"", description),
        ("property=\"og:url\" content=\"", url),
        ("rel=\"canonical\" href=\"", url),
    ] {
        html = replace_between(&html, attr, "\"", &escape(value));
    }
    html
}

fn replace_between(html: &str, start: &str, end: &str, value: &str) -> String {
    let Some(from) = html.find(start).map(|i| i + start.len()) else {
        return html.to_owned();
    };
    let Some(len) = html[from..].find(end) else {
        return html.to_owned();
    };
    format!("{}{value}{}", &html[..from], &html[from + len..])
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn format_usdc(units: i64) -> String {
    let (whole, cents) = (units / 1_000_000, units % 1_000_000 / 10_000);
    if cents == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{cents:02}")
    }
}

fn human_duration(seconds: i32) -> String {
    match seconds {
        s if s % 86_400 == 0 => plural(s / 86_400, "day"),
        s if s % 3_600 == 0 => plural(s / 3_600, "hour"),
        s => format!("{} min", s / 60),
    }
}

fn plural(n: i32, unit: &str) -> String {
    if n == 1 {
        unit.to_owned()
    } else {
        format!("{n} {unit}s")
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn pot(title: &str, period_seconds: i32) -> PotRow {
        PotRow {
            id: 1,
            title: title.into(),
            creator: String::new(),
            stake: 12_500_000,
            reps_per_period: 20,
            periods: 7,
            period_seconds,
            start_time: Utc::now(),
            max_members: 10,
            member_count: 3,
        }
    }

    #[test]
    fn describes_daily_and_sprint_pots() {
        let (title, description) = describe(&pot("Morning crew", 86_400));
        assert_eq!(title, "Join “Morning crew” on PushPot");
        assert!(
            description.starts_with("20 pushups a day for 7 days. 12.50 USDC stake, 3 players in.")
        );

        let (_, description) = describe(&pot("Sprint", 600));
        assert!(description.starts_with("20 pushups every 10 min for 7 rounds"));
    }

    #[test]
    fn injects_escaped_meta() {
        let index = r#"<title>PushPot</title><meta name="description" content="x" /><meta property="og:title" content="x" /><meta property="og:url" content="x" />"#;
        let html = with_meta(
            index,
            "Join \"<script>\" & co",
            "desc",
            "https://pushpot.fun/p/1",
        );
        assert!(html.contains("<title>Join &quot;&lt;script&gt;&quot; &amp; co</title>"));
        assert!(
            html.contains(
                r#"property="og:title" content="Join &quot;&lt;script&gt;&quot; &amp; co""#
            )
        );
        assert!(html.contains(r#"name="description" content="desc""#));
        assert!(html.contains(r#"property="og:url" content="https://pushpot.fun/p/1""#));
        assert!(!html.contains("<script>"));
    }
}
