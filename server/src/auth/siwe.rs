//! Minimal EIP-4361 (Sign-In with Ethereum) message parsing and validation.

use alloy::primitives::{Address, Signature};
use chrono::{DateTime, Duration, Utc};

const HEADER_SUFFIX: &str = " wants you to sign in with your Ethereum account:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub domain: String,
    pub address: Address,
    pub uri: String,
    pub version: String,
    pub chain_id: u64,
    pub nonce: String,
    pub issued_at: DateTime<Utc>,
    pub expiration_time: Option<DateTime<Utc>>,
    pub not_before: Option<DateTime<Utc>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SiweError {
    #[error("malformed sign-in message: {0}")]
    Malformed(&'static str),
    #[error("sign-in message is for a different site")]
    WrongDomain,
    #[error("sign-in message is for a different network")]
    WrongChain,
    #[error("sign-in message has expired")]
    Expired,
    #[error("sign-in message is not valid yet")]
    NotYetValid,
}

pub struct Expectations<'a> {
    pub domain: &'a str,
    pub origin: &'a str,
    pub chain_id: u64,
    pub now: DateTime<Utc>,
}

impl Message {
    pub fn parse(text: &str) -> Result<Self, SiweError> {
        let mut lines = text.lines();

        let header = lines.next().ok_or(SiweError::Malformed("empty"))?;
        let origin = header
            .strip_suffix(HEADER_SUFFIX)
            .ok_or(SiweError::Malformed("header"))?;
        let domain = origin
            .split_once("://")
            .map_or(origin, |(_, rest)| rest)
            .to_owned();

        let address = lines
            .next()
            .and_then(|line| line.trim().parse::<Address>().ok())
            .ok_or(SiweError::Malformed("address"))?;

        let mut uri = None;
        let mut version = None;
        let mut chain_id = None;
        let mut nonce = None;
        let mut issued_at = None;
        let mut expiration_time = None;
        let mut not_before = None;

        for line in lines {
            let Some((key, value)) = line.split_once(": ") else {
                continue;
            };
            match key {
                "URI" => uri = Some(value.to_owned()),
                "Version" => version = Some(value.to_owned()),
                "Chain ID" => chain_id = value.parse().ok(),
                "Nonce" => nonce = Some(value.to_owned()),
                "Issued At" => issued_at = parse_time(value),
                "Expiration Time" => {
                    expiration_time = Some(parse_time(value).ok_or(SiweError::Malformed("expiry"))?)
                }
                "Not Before" => {
                    not_before = Some(parse_time(value).ok_or(SiweError::Malformed("not before"))?)
                }
                _ => {}
            }
        }

        let nonce = nonce.ok_or(SiweError::Malformed("nonce"))?;
        if nonce.len() < 8 || !nonce.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(SiweError::Malformed("nonce"));
        }

        Ok(Self {
            domain,
            address,
            uri: uri.ok_or(SiweError::Malformed("uri"))?,
            version: version.ok_or(SiweError::Malformed("version"))?,
            chain_id: chain_id.ok_or(SiweError::Malformed("chain id"))?,
            nonce,
            issued_at: issued_at.ok_or(SiweError::Malformed("issued at"))?,
            expiration_time,
            not_before,
        })
    }

    pub fn validate(&self, expect: &Expectations) -> Result<(), SiweError> {
        if self.domain != expect.domain || !uri_matches_origin(&self.uri, expect.origin) {
            return Err(SiweError::WrongDomain);
        }
        if self.version != "1" {
            return Err(SiweError::Malformed("version"));
        }
        if self.chain_id != expect.chain_id {
            return Err(SiweError::WrongChain);
        }
        let max_age = Duration::minutes(10);
        if self.issued_at > expect.now + Duration::minutes(1) {
            return Err(SiweError::NotYetValid);
        }
        if self.issued_at < expect.now - max_age {
            return Err(SiweError::Expired);
        }
        if self.expiration_time.is_some_and(|t| t <= expect.now) {
            return Err(SiweError::Expired);
        }
        if self.not_before.is_some_and(|t| t > expect.now) {
            return Err(SiweError::NotYetValid);
        }
        Ok(())
    }
}

/// Recovers the EIP-191 signer. Smart-contract wallets are handled by the caller via ERC-1271.
pub fn recover_signer(message: &str, signature: &[u8]) -> Option<Address> {
    let signature = Signature::from_raw(signature).ok()?;
    signature.recover_address_from_msg(message.as_bytes()).ok()
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

fn uri_matches_origin(uri: &str, origin: &str) -> bool {
    url::Url::parse(uri).is_ok_and(|u| u.origin().ascii_serialization() == origin)
}

#[cfg(test)]
mod tests {
    use alloy::signers::{SignerSync, local::PrivateKeySigner};

    use super::*;

    const ADDRESS: &str = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

    fn message(statement: Option<&str>, extra: &str) -> String {
        let statement = statement.map(|s| format!("\n{s}\n")).unwrap_or_default();
        format!(
            "pushpot.example wants you to sign in with your Ethereum account:\n{ADDRESS}\n{statement}\n\
             URI: https://pushpot.example\nVersion: 1\nChain ID: 5042\nNonce: abc123XYZ789\n\
             Issued At: 2026-10-13T10:00:00.000Z{extra}"
        )
    }

    fn expectations(now: &str) -> Expectations<'static> {
        Expectations {
            domain: "pushpot.example",
            origin: "https://pushpot.example",
            chain_id: 5042,
            now: parse_time(now).unwrap(),
        }
    }

    #[test]
    fn parses_message_with_statement_and_expiry() {
        let msg = Message::parse(&message(
            Some("Sign in to PushPot"),
            "\nExpiration Time: 2026-10-13T10:10:00.000Z",
        ))
        .unwrap();

        assert_eq!(msg.domain, "pushpot.example");
        assert_eq!(msg.address, ADDRESS.parse::<Address>().unwrap());
        assert_eq!(msg.chain_id, 5042);
        assert_eq!(msg.nonce, "abc123XYZ789");
        assert!(msg.expiration_time.is_some());
    }

    #[test]
    fn parses_message_without_statement() {
        let msg = Message::parse(&message(None, "")).unwrap();
        assert_eq!(msg.uri, "https://pushpot.example");
        assert_eq!(msg.expiration_time, None);
    }

    #[test]
    fn strips_scheme_from_header() {
        let text = message(None, "").replacen("pushpot.example", "https://pushpot.example", 1);
        assert_eq!(Message::parse(&text).unwrap().domain, "pushpot.example");
    }

    #[test]
    fn rejects_malformed_messages() {
        assert!(Message::parse("hello").is_err());
        assert!(Message::parse(&message(None, "").replace(ADDRESS, "0xnope")).is_err());
        assert!(Message::parse(&message(None, "").replace("Nonce: abc123XYZ789", "")).is_err());
        assert!(Message::parse(&message(None, "").replace("abc123XYZ789", "short")).is_err());
    }

    #[test]
    fn validates_against_expectations() {
        let msg =
            Message::parse(&message(None, "\nExpiration Time: 2026-10-13T10:10:00Z")).unwrap();
        assert_eq!(msg.validate(&expectations("2026-10-13T10:05:00Z")), Ok(()));
        assert_eq!(
            msg.validate(&expectations("2026-10-13T10:10:00Z")),
            Err(SiweError::Expired)
        );
        assert_eq!(
            msg.validate(&expectations("2026-10-13T09:58:00Z")),
            Err(SiweError::NotYetValid)
        );

        let mut other = expectations("2026-10-13T10:05:00Z");
        other.domain = "evil.example";
        assert_eq!(msg.validate(&other), Err(SiweError::WrongDomain));

        let mut other = expectations("2026-10-13T10:05:00Z");
        other.chain_id = 1;
        assert_eq!(msg.validate(&other), Err(SiweError::WrongChain));
    }

    #[test]
    fn rejects_uri_on_another_origin() {
        let text =
            message(None, "").replace("URI: https://pushpot.example", "URI: https://evil.example");
        let msg = Message::parse(&text).unwrap();
        assert_eq!(
            msg.validate(&expectations("2026-10-13T10:01:00Z")),
            Err(SiweError::WrongDomain)
        );
    }

    #[test]
    fn rejects_stale_messages_without_expiry() {
        let msg = Message::parse(&message(None, "")).unwrap();
        assert_eq!(
            msg.validate(&expectations("2026-10-13T10:11:00Z")),
            Err(SiweError::Expired)
        );
    }

    #[test]
    fn recovers_eip191_signer() {
        let signer = PrivateKeySigner::random();
        let text = message(None, "").replace(ADDRESS, &signer.address().to_checksum(None));
        let signature = signer.sign_message_sync(text.as_bytes()).unwrap();

        assert_eq!(
            recover_signer(&text, &signature.as_bytes()),
            Some(signer.address())
        );
        assert_ne!(
            recover_signer(&format!("{text} "), &signature.as_bytes()),
            Some(signer.address())
        );
        assert_eq!(recover_signer(&text, &[0u8; 10]), None);
    }
}
