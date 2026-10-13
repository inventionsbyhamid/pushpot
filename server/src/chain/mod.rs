pub mod indexer;
pub mod oracle;

use alloy::{
    contract::Error as ContractError,
    primitives::{Address, B256, Bytes, U256, eip191_hash_message},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    sol,
    sol_types::SolCall,
};
use anyhow::{Result, anyhow, ensure};
use url::{Position, Url};

use crate::config::Config;

sol! {
    #[allow(clippy::too_many_arguments)]
    #[sol(rpc)]
    interface IPushPot {
        struct PotParams {
            string title;
            uint128 stake;
            uint16 repsPerPeriod;
            uint16 periods;
            uint32 periodSeconds;
            uint64 startTime;
            uint16 maxMembers;
        }

        struct Pot {
            address creator;
            uint64 startTime;
            uint32 periodSeconds;
            uint16 periods;
            uint16 repsPerPeriod;
            uint16 maxMembers;
            uint16 memberCount;
            uint16 completerCount;
            uint16 claimedCount;
            uint16 feeBps;
            bool feeCollected;
            bool official;
            uint128 stake;
            uint96 paidOut;
            address oracle;
        }

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
        event ChallengeCreated(uint256 indexed potId);
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
        event FeeCollected(uint256 indexed potId, address indexed treasury, uint256 amount);

        error InvalidParams();
        error Paused();
        error PotNotFound();
        error NotMember();
        error NotOracle();
        error NotCurator();
        error NotEnoughReps();
        error OutsideWindow();
        error AlreadyCheckedIn();
        error NotEnded();
        error NothingToClaim();

        function checkIn(uint256 potId, address member, uint16 period, uint16 reps, bytes32 evidenceHash) external;
        function createChallenge(PotParams params) external returns (uint256 potId);
        function collectFee(uint256 potId) external returns (uint256 fee);
        function getPot(uint256 potId) external view returns (Pot memory);
        function getMember(uint256 potId, address account) external view returns (bool joined, bool claimed, uint16 checkIns, uint128 periodBits);
        function collectableFee(uint256 potId) external view returns (uint256);
        function curator() external view returns (address);
        function maxStake() external view returns (uint128);
    }

    interface IERC1271 {
        function isValidSignature(bytes32 hash, bytes signature) external view returns (bytes4);
    }
}

const ERC1271_MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

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
        let chain_id = provider.get_chain_id().await.map_err(|err| {
            anyhow!(
                "reading chain id: {}",
                redact_url(&err.to_string(), &config.rpc_url)
            )
        })?;
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

    fn pushpot(&self) -> IPushPot::IPushPotInstance<&DynProvider> {
        IPushPot::new(self.contract, &self.provider)
    }

    /// Reads membership straight from the contract, for when the indexer hasn't caught up.
    pub async fn is_member(&self, pot_id: u64, account: Address) -> Result<bool, ContractError> {
        let member = self
            .pushpot()
            .getMember(U256::from(pot_id), account)
            .call()
            .await?;
        Ok(member.joined)
    }

    /// The pot's fee in basis points, fixed when it was created. `PotCreated` doesn't carry it.
    pub async fn fee_bps(&self, pot_id: u64) -> Result<u16, ContractError> {
        Ok(self
            .pushpot()
            .getPot(U256::from(pot_id))
            .call()
            .await?
            .feeBps)
    }

    pub async fn collectable_fee(&self, pot_id: u64) -> Result<U256, ContractError> {
        self.pushpot()
            .collectableFee(U256::from(pot_id))
            .call()
            .await
    }

    pub async fn curator(&self) -> Result<Address, ContractError> {
        self.pushpot().curator().call().await
    }

    pub async fn max_stake(&self) -> Result<u128, ContractError> {
        self.pushpot().maxStake().call().await
    }

    /// ERC-1271 check for smart-contract wallets signing an EIP-191 message.
    pub async fn is_valid_contract_signature(
        &self,
        signer: Address,
        message: &str,
        signature: &[u8],
    ) -> bool {
        // Precompiles and EOAs have no code, and some precompiles echo the calldata back, which
        // a lenient decoder would read as the magic value.
        match self.provider.get_code_at(signer).await {
            Ok(code) if !code.is_empty() => {}
            _ => return false,
        }
        let hash: B256 = eip191_hash_message(message.as_bytes());
        let calldata = IERC1271::isValidSignatureCall {
            hash,
            signature: Bytes::copy_from_slice(signature),
        }
        .abi_encode();
        let call = TransactionRequest::default()
            .to(signer)
            .input(Bytes::from(calldata).into());
        self.provider
            .call(call)
            .await
            .is_ok_and(|output| is_erc1271_magic(&output))
    }
}

/// A well-formed `bytes4` return: the magic value, left-aligned in exactly one zero-padded word.
fn is_erc1271_magic(output: &[u8]) -> bool {
    output.len() == 32 && output[..4] == ERC1271_MAGIC && output[4..].iter().all(|&b| b == 0)
}

/// Strips the parts of the RPC URL that may hold an API key from text bound for logs. Transport
/// errors quote the full request URL.
pub fn redact_url(text: &str, url: &Url) -> String {
    let origin = url.origin().ascii_serialization();
    let text = text.replace(url.as_str(), &origin);
    match &url[Position::BeforePath..] {
        "" | "/" => text,
        secret => text.replace(secret, ""),
    }
}

#[cfg(test)]
mod tests {
    use alloy::{providers::ProviderBuilder, sol_types::SolValue, transports::mock::Asserter};

    use super::*;

    fn chain(rpc: &Asserter) -> Chain {
        Chain {
            provider: ProviderBuilder::new()
                .connect_mocked_client(rpc.clone())
                .erased(),
            contract: Address::repeat_byte(0xcc),
            chain_id: 5042,
            deploy_block: 0,
        }
    }

    fn word(prefix: &[u8]) -> Bytes {
        let mut word = [0u8; 32];
        word[..prefix.len()].copy_from_slice(prefix);
        Bytes::from(word.to_vec())
    }

    #[test]
    fn erc1271_requires_an_exact_magic_word() {
        assert!(is_erc1271_magic(&word(&ERC1271_MAGIC)));
        assert!(!is_erc1271_magic(&ERC1271_MAGIC));
        assert!(!is_erc1271_magic(&word(&[0x16, 0x26, 0xba, 0x7e, 0x01])));
        let mut echoed = word(&ERC1271_MAGIC).to_vec();
        echoed.extend_from_slice(&[0u8; 64]);
        assert!(!is_erc1271_magic(&echoed));
    }

    #[tokio::test]
    async fn contract_signatures_need_code_and_the_magic_word() {
        let rpc = Asserter::new();
        let chain = chain(&rpc);
        let wallet = Address::repeat_byte(0x77);

        rpc.push_success(&Bytes::new());
        assert!(!chain.is_valid_contract_signature(wallet, "hi", &[1]).await);
        assert!(rpc.read_q().is_empty(), "no call without code");

        rpc.push_success(&Bytes::from_static(&[0x60, 0x00]));
        rpc.push_success(&word(&ERC1271_MAGIC));
        assert!(chain.is_valid_contract_signature(wallet, "hi", &[1]).await);

        rpc.push_success(&Bytes::from_static(&[0x60, 0x00]));
        rpc.push_success(&word(&[0x16, 0x26, 0xba, 0x7e, 0xff]));
        assert!(!chain.is_valid_contract_signature(wallet, "hi", &[1]).await);
    }

    #[tokio::test]
    async fn reads_membership_from_the_contract() {
        let rpc = Asserter::new();
        let chain = chain(&rpc);
        let encoded = |joined: bool| Bytes::from((joined, false, 0u16, 0u128).abi_encode_params());

        rpc.push_success(&encoded(true));
        assert!(chain.is_member(1, Address::ZERO).await.unwrap());
        rpc.push_success(&encoded(false));
        assert!(!chain.is_member(1, Address::ZERO).await.unwrap());
    }

    #[tokio::test]
    async fn redacts_rpc_keys_from_transport_errors() {
        let url: Url = "http://127.0.0.1:9/v2/s3cr3t-key?token=abc"
            .parse()
            .unwrap();
        let provider = ProviderBuilder::new().connect_http(url.clone());
        let err = provider.get_block_number().await.unwrap_err().to_string();

        let redacted = redact_url(&err, &url);
        assert!(!redacted.contains("s3cr3t"), "{redacted}");
        assert!(!redacted.contains("token=abc"), "{redacted}");
        assert_eq!(
            redact_url(
                "error sending request for url (http://127.0.0.1:9/v2/s3cr3t-key?token=abc)",
                &url
            ),
            "error sending request for url (http://127.0.0.1:9)"
        );
    }
}
