use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use alloy::{primitives::Address, signers::local::PrivateKeySigner};
use anyhow::{Context, Result, bail};
use url::Url;

#[derive(Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub public_origin: Url,
    pub rpc_url: Url,
    pub chain_id: u64,
    pub contract: Address,
    pub deploy_block: u64,
    pub oracle_signer: PrivateKeySigner,
    pub web_dir: PathBuf,
    pub indexer_interval: Duration,
    /// Opens the official challenges in the catalog. Off for test deployments.
    pub curator_enabled: bool,
    /// Sends finished pots' fees to the treasury.
    pub fee_collector_enabled: bool,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let public_origin: Url = required("PUBLIC_ORIGIN")?
            .parse()
            .context("PUBLIC_ORIGIN")?;
        if public_origin.host_str().is_none() || public_origin.path() != "/" {
            bail!("PUBLIC_ORIGIN must be a bare origin like https://pushpot.example");
        }

        Ok(Self {
            bind_addr: optional("BIND_ADDR", "0.0.0.0:8080")
                .parse()
                .context("BIND_ADDR")?,
            database_url: required("DATABASE_URL")?,
            public_origin,
            rpc_url: optional("ARC_RPC_URL", "https://rpc.mainnet.arc.io")
                .parse()
                .context("ARC_RPC_URL")?,
            chain_id: optional("ARC_CHAIN_ID", "5042")
                .parse()
                .context("ARC_CHAIN_ID")?,
            contract: required("PUSHPOT_ADDRESS")?
                .parse()
                .context("PUSHPOT_ADDRESS")?,
            deploy_block: required("PUSHPOT_DEPLOY_BLOCK")?
                .parse()
                .context("PUSHPOT_DEPLOY_BLOCK")?,
            oracle_signer: required("ORACLE_PRIVATE_KEY")?
                .parse()
                .context("ORACLE_PRIVATE_KEY is not a valid private key")?,
            web_dir: optional("WEB_DIR", "../web/dist").into(),
            indexer_interval: Duration::from_millis(
                optional("INDEXER_INTERVAL_MS", "1000")
                    .parse()
                    .context("INDEXER_INTERVAL_MS")?,
            ),
            curator_enabled: flag("CURATOR_ENABLED", true)?,
            fee_collector_enabled: flag("FEE_COLLECTOR_ENABLED", true)?,
        })
    }

    /// The `host[:port]` that SIWE messages must be issued for.
    pub fn siwe_domain(&self) -> String {
        match self.public_origin.port() {
            Some(port) => format!(
                "{}:{port}",
                self.public_origin.host_str().unwrap_or_default()
            ),
            None => self.public_origin.host_str().unwrap_or_default().to_owned(),
        }
    }

    pub fn origin(&self) -> String {
        self.public_origin.origin().ascii_serialization()
    }

    pub fn is_https(&self) -> bool {
        self.public_origin.scheme() == "https"
    }
}

fn required(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("{key} must be set"))
}

fn optional(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn flag(key: &str, default: bool) -> Result<bool> {
    let Ok(value) = env::var(key) else {
        return Ok(default);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{key} must be true or false"),
    }
}
