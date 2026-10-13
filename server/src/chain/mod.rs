pub mod indexer;
pub mod oracle;

use alloy::{
    primitives::{Address, B256, Bytes, FixedBytes, eip191_hash_message},
    providers::{DynProvider, Provider, ProviderBuilder},
    sol,
};
use anyhow::{Context, Result, ensure};

use crate::config::Config;

sol! {
    #[allow(clippy::too_many_arguments)]
    #[sol(rpc)]
    interface IPushPot {
        event PotCreated(
            uint256 indexed potId,
            address indexed creator,
            string title,
            uint128 stake,
            uint16 repsPerPeriod,
            uint16 periods,
            uint32 periodSeconds,
            uint64 startTime,
            uint16 maxMembers
        );
        event Joined(uint256 indexed potId, address indexed member);
        event Left(uint256 indexed potId, address indexed member);
        event CheckedIn(
            uint256 indexed potId,
            address indexed member,
            uint16 period,
            uint16 reps,
            bytes32 evidenceHash
        );
        event Claimed(uint256 indexed potId, address indexed member, uint256 amount);

        error Paused();
        error PotNotFound();
        error NotMember();
        error NotOracle();
        error NotEnoughReps();
        error OutsideWindow();
        error AlreadyCheckedIn();

        function checkIn(uint256 potId, address member, uint16 period, uint16 reps, bytes32 evidenceHash) external;
    }

    #[sol(rpc)]
    interface IERC1271 {
        function isValidSignature(bytes32 hash, bytes signature) external view returns (bytes4);
    }
}

const ERC1271_MAGIC: FixedBytes<4> = FixedBytes([0x16, 0x26, 0xba, 0x7e]);

#[derive(Clone)]
pub struct Chain {
    pub provider: DynProvider,
    pub contract: Address,
    pub chain_id: u64,
    pub deploy_block: u64,
}

impl Chain {
    pub async fn connect(config: &Config) -> Result<Self> {
        let provider = ProviderBuilder::new()
            .connect_http(config.rpc_url.clone())
            .erased();
        let chain_id = provider.get_chain_id().await.context("reading chain id")?;
        ensure!(
            chain_id == config.chain_id,
            "RPC is on chain {chain_id}, expected {}",
            config.chain_id
        );
        Ok(Self {
            provider,
            contract: config.contract,
            chain_id,
            deploy_block: config.deploy_block,
        })
    }

    /// ERC-1271 check for smart-contract wallets signing an EIP-191 message.
    pub async fn is_valid_contract_signature(
        &self,
        signer: Address,
        message: &str,
        signature: &[u8],
    ) -> bool {
        let hash: B256 = eip191_hash_message(message.as_bytes());
        let wallet = IERC1271::new(signer, &self.provider);
        matches!(
            wallet.isValidSignature(hash, Bytes::copy_from_slice(signature)).call().await,
            Ok(magic) if magic == ERC1271_MAGIC
        )
    }
}
