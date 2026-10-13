// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title PushPot
/// @notice Pushup challenges with USDC stakes. Members who check in every period split the
/// whole pot, minus a platform fee taken only from forfeited stakes; if nobody completes,
/// everyone is refunded. Check-ins come from an oracle that verifies workouts off-chain and are
/// only accepted inside the period window. Each pot is bound to the oracle and fee that were
/// active when it was created, so its rules can't change after people join. Neither the owner,
/// the curator nor the oracle can move staked funds.
contract PushPot is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint128 public constant MIN_STAKE = 1e6;
    uint128 public constant MAX_STAKE_LIMIT = 1e12;
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint32 public constant MIN_PERIOD = 10 minutes;
    uint32 public constant MAX_PERIOD = 7 days;
    uint16 public constant MAX_PERIODS = 90;
    uint16 public constant MAX_MEMBERS = 50;
    uint16 public constant MAX_CHALLENGE_MEMBERS = 1_000;
    uint16 public constant MAX_REPS = 1000;
    uint32 public constant GRACE = 5 minutes;
    uint64 public constant MAX_START_DELAY = 30 days;
    uint256 public constant MAX_TITLE_BYTES = 48;
    uint256 private constant BPS = 10_000;

    struct Config {
        address usdc;
        address oracle;
        address curator;
        address treasury;
        address owner;
        uint128 maxStake;
        uint16 feeBps;
    }

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

    struct Member {
        bool joined;
        bool claimed;
        uint16 checkIns;
        uint128 periodBits;
    }

    IERC20 public immutable usdc;
    uint128 public immutable maxStake;
    /// @notice Oracle assigned to new pots; zero after a revocation until a new one is set.
    address public oracle;
    mapping(address oracle => bool) public revokedOracles;
    /// @notice May open official challenges; zero when they're disabled.
    address public curator;
    address public treasury;
    /// @notice Fee on forfeited stakes for pots created from now on, in basis points.
    uint16 public feeBps;
    bool public paused;
    uint256 public potCount;

    mapping(uint256 potId => Pot) private _pots;
    mapping(uint256 potId => mapping(address member => Member)) private _members;

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
    event OracleUpdated(address indexed oracle);
    event OracleRevoked(address indexed oracle);
    event CuratorUpdated(address indexed curator);
    event TreasuryUpdated(address indexed treasury);
    event FeeUpdated(uint16 feeBps);
    event PausedSet(bool paused);

    error InvalidParams();
    error Paused();
    error PotNotFound();
    error PotFull();
    error JoiningClosed();
    error AlreadyJoined();
    error NotMember();
    error NotOracle();
    error NotCurator();
    error NotEnoughReps();
    error OutsideWindow();
    error AlreadyCheckedIn();
    error NotEnded();
    error NothingToClaim();
    error RenounceDisabled();

    constructor(Config memory config) Ownable(config.owner) {
        if (
            config.usdc == address(0) || config.oracle == address(0)
                || config.treasury == address(0) || config.maxStake < MIN_STAKE
                || config.maxStake > MAX_STAKE_LIMIT || config.feeBps > MAX_FEE_BPS
        ) revert InvalidParams();

        usdc = IERC20(config.usdc);
        maxStake = config.maxStake;
        oracle = config.oracle;
        curator = config.curator;
        treasury = config.treasury;
        feeBps = config.feeBps;
        emit OracleUpdated(config.oracle);
        emit CuratorUpdated(config.curator);
        emit TreasuryUpdated(config.treasury);
        emit FeeUpdated(config.feeBps);
    }

    function createPot(PotParams calldata params) external nonReentrant returns (uint256 potId) {
        potId = _createPot(params, false);
        _collectStake(_join(potId));
    }

    function createPotWithPermit(
        PotParams calldata params,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 potId) {
        potId = _createPot(params, false);
        uint256 stake = _join(potId);
        _permit(stake, deadline, v, r, s);
        _collectStake(stake);
    }

    /// @notice Opens an official challenge that anyone can join. The curator doesn't stake.
    function createChallenge(PotParams calldata params) external returns (uint256 potId) {
        if (msg.sender != curator) revert NotCurator();
        potId = _createPot(params, true);
        emit ChallengeCreated(potId);
    }

    function join(uint256 potId) external nonReentrant {
        _collectStake(_join(potId));
    }

    function joinWithPermit(uint256 potId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        uint256 stake = _join(potId);
        _permit(stake, deadline, v, r, s);
        _collectStake(stake);
    }

    function leave(uint256 potId) external nonReentrant {
        Pot storage pot = _getPot(potId);
        if (block.timestamp >= pot.startTime) revert JoiningClosed();
        Member storage member = _members[potId][msg.sender];
        if (!member.joined) revert NotMember();

        delete _members[potId][msg.sender];
        pot.memberCount--;

        emit Left(potId, msg.sender);
        usdc.safeTransfer(msg.sender, pot.stake);
    }

    function checkIn(
        uint256 potId,
        address account,
        uint16 period,
        uint16 reps,
        bytes32 evidenceHash
    ) external {
        Pot storage pot = _getPot(potId);
        if (msg.sender != pot.oracle || revokedOracles[msg.sender]) revert NotOracle();
        Member storage member = _members[potId][account];
        if (!member.joined) revert NotMember();
        if (reps < pot.repsPerPeriod) revert NotEnoughReps();
        if (period >= pot.periods) revert OutsideWindow();

        uint256 opensAt = uint256(pot.startTime) + uint256(period) * pot.periodSeconds;
        uint256 closesAt = opensAt + pot.periodSeconds + GRACE;
        if (block.timestamp < opensAt || block.timestamp >= closesAt) revert OutsideWindow();

        uint128 bit = uint128(1) << period;
        if (member.periodBits & bit != 0) revert AlreadyCheckedIn();
        member.periodBits |= bit;
        member.checkIns++;
        if (member.checkIns == pot.periods) pot.completerCount++;

        emit CheckedIn(potId, account, period, reps, evidenceHash);
    }

    function claim(uint256 potId) external nonReentrant {
        Pot storage pot = _getPot(potId);
        if (block.timestamp < endTime(potId) + GRACE) revert NotEnded();

        Member storage member = _members[potId][msg.sender];
        uint256 amount = _claimable(pot, member);
        if (amount == 0) revert NothingToClaim();

        member.claimed = true;
        pot.claimedCount++;
        pot.paidOut += SafeCast.toUint96(amount);

        emit Claimed(potId, msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Sends a finished pot's fee to the treasury. Anyone can trigger it.
    function collectFee(uint256 potId) external nonReentrant returns (uint256 fee) {
        Pot storage pot = _getPot(potId);
        if (block.timestamp < endTime(potId) + GRACE) revert NotEnded();
        fee = pot.feeCollected ? 0 : _fee(pot);
        if (fee == 0) revert NothingToClaim();

        pot.feeCollected = true;
        emit FeeCollected(potId, treasury, fee);
        usdc.safeTransfer(treasury, fee);
    }

    /// @notice Stops new pots and joins. Existing pots keep running: check-ins, leaving and
    /// claims are never blocked, so pausing can't lock anyone's stake.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Sets the oracle for pots created from now on. Existing pots keep theirs.
    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0) || revokedOracles[oracle_]) revert InvalidParams();
        oracle = oracle_;
        emit OracleUpdated(oracle_);
    }

    /// @notice Emergency switch for a compromised oracle key: it can no longer check anyone in,
    /// so its pots end without completers and every member is refunded.
    function revokeOracle(address oracle_) external onlyOwner {
        revokedOracles[oracle_] = true;
        if (oracle == oracle_) oracle = address(0);
        emit OracleRevoked(oracle_);
    }

    function setCurator(address curator_) external onlyOwner {
        if (curator_ == address(0)) revert InvalidParams();
        curator = curator_;
        emit CuratorUpdated(curator_);
    }

    /// @notice Stops new official challenges; existing ones are unaffected.
    function removeCurator() external onlyOwner {
        curator = address(0);
        emit CuratorUpdated(address(0));
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Sets the fee for pots created from now on. Existing pots keep theirs.
    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParams();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    /// @dev Without an owner nobody could pause new pots or rotate a compromised oracle.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function getPot(uint256 potId) external view returns (Pot memory) {
        return _getPot(potId);
    }

    function getMember(uint256 potId, address account) external view returns (Member memory) {
        return _members[potId][account];
    }

    function endTime(uint256 potId) public view returns (uint256) {
        Pot storage pot = _getPot(potId);
        return uint256(pot.startTime) + uint256(pot.periods) * pot.periodSeconds;
    }

    /// @return The active period index, or `type(uint256).max` before start and after the end.
    function currentPeriod(uint256 potId) external view returns (uint256) {
        Pot storage pot = _getPot(potId);
        if (block.timestamp < pot.startTime || block.timestamp >= endTime(potId)) {
            return type(uint256).max;
        }
        return (block.timestamp - pot.startTime) / pot.periodSeconds;
    }

    /// @notice Amount `account` can claim once the pot has ended, given the current state.
    function claimable(uint256 potId, address account) external view returns (uint256) {
        return _claimable(_getPot(potId), _members[potId][account]);
    }

    /// @notice Fee `collectFee` would send to the treasury once the pot has ended.
    function collectableFee(uint256 potId) external view returns (uint256) {
        Pot storage pot = _getPot(potId);
        return pot.feeCollected ? 0 : _fee(pot);
    }

    function _createPot(PotParams calldata params, bool official) private returns (uint256 potId) {
        if (paused || oracle == address(0)) revert Paused();
        uint256 titleLength = bytes(params.title).length;
        uint16 memberLimit = official ? MAX_CHALLENGE_MEMBERS : MAX_MEMBERS;
        if (
            params.stake < MIN_STAKE || params.stake > maxStake || params.repsPerPeriod == 0
                || params.repsPerPeriod > MAX_REPS || params.periods == 0
                || params.periods > MAX_PERIODS || params.periodSeconds < MIN_PERIOD
                || params.periodSeconds > MAX_PERIOD || params.startTime <= block.timestamp
                || params.startTime > block.timestamp + MAX_START_DELAY || params.maxMembers < 2
                || params.maxMembers > memberLimit || titleLength == 0
                || titleLength > MAX_TITLE_BYTES
        ) revert InvalidParams();
        _requirePrintable(params.title);

        potId = ++potCount;
        _pots[potId] = Pot({
            creator: msg.sender,
            startTime: params.startTime,
            periodSeconds: params.periodSeconds,
            periods: params.periods,
            repsPerPeriod: params.repsPerPeriod,
            maxMembers: params.maxMembers,
            memberCount: 0,
            completerCount: 0,
            claimedCount: 0,
            feeBps: feeBps,
            feeCollected: false,
            official: official,
            stake: params.stake,
            paidOut: 0,
            oracle: oracle
        });

        emit PotCreated(
            potId,
            msg.sender,
            params.title,
            params.stake,
            params.repsPerPeriod,
            params.periods,
            params.periodSeconds,
            params.startTime,
            params.maxMembers
        );
    }

    function _join(uint256 potId) private returns (uint256 stake) {
        if (paused) revert Paused();
        Pot storage pot = _getPot(potId);
        if (block.timestamp >= pot.startTime) revert JoiningClosed();
        if (pot.memberCount >= pot.maxMembers) revert PotFull();
        Member storage member = _members[potId][msg.sender];
        if (member.joined) revert AlreadyJoined();

        member.joined = true;
        pot.memberCount++;

        emit Joined(potId, msg.sender);
        return pot.stake;
    }

    function _collectStake(uint256 stake) private {
        usdc.safeTransferFrom(msg.sender, address(this), stake);
    }

    /// @dev A failed permit is ignored so a front-run signature can't block the call; the
    /// stake transfer that follows still fails if there is no allowance.
    function _permit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        try IERC20Permit(address(usdc))
            .permit(msg.sender, address(this), value, deadline, v, r, s) {}
            catch {}
    }

    /// @dev Titles are shown in apps and indexed off-chain; control characters only cause trouble.
    function _requirePrintable(string calldata title) private pure {
        bytes calldata raw = bytes(title);
        bool printable = true;
        for (uint256 i; i < raw.length; ++i) {
            printable = printable && raw[i] >= 0x20 && raw[i] != 0x7f;
        }
        if (!printable) revert InvalidParams();
    }

    function _getPot(uint256 potId) private view returns (Pot storage pot) {
        pot = _pots[potId];
        if (pot.creator == address(0)) revert PotNotFound();
    }

    function _claimable(Pot storage pot, Member storage member) private view returns (uint256) {
        if (!member.joined || member.claimed) return 0;
        if (pot.completerCount == 0) return pot.stake;
        if (member.checkIns != pot.periods) return 0;

        // The last completer to claim also takes the rounding remainder.
        uint256 prize = uint256(pot.stake) * pot.memberCount - _fee(pot);
        if (pot.claimedCount + 1 == pot.completerCount) return prize - pot.paidOut;
        return prize / pot.completerCount;
    }

    /// @dev The fee comes only out of forfeited stakes, and only when someone completed.
    function _fee(Pot storage pot) private view returns (uint256) {
        if (pot.completerCount == 0) return 0;
        uint256 forfeited = uint256(pot.stake) * (pot.memberCount - pot.completerCount);
        return forfeited * pot.feeBps / BPS;
    }
}
