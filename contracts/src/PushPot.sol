// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title PushPot
/// @notice Group pushup challenges with USDC stakes. Members who check in every period split
/// the whole pot; if nobody completes, everyone is refunded. Check-ins are submitted by an
/// oracle that verifies workouts off-chain, and are only accepted inside the period window.
/// Neither the owner nor the oracle can move staked funds.
contract PushPot is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint32 public constant MIN_PERIOD = 10 minutes;
    uint32 public constant MAX_PERIOD = 7 days;
    uint16 public constant MAX_PERIODS = 90;
    uint16 public constant MAX_MEMBERS = 50;
    uint16 public constant MAX_REPS = 1000;
    uint32 public constant GRACE = 5 minutes;
    uint64 public constant MAX_START_DELAY = 30 days;
    uint256 public constant MAX_TITLE_BYTES = 48;

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
        uint128 stake;
        uint128 paidOut;
    }

    struct Member {
        bool joined;
        bool claimed;
        uint16 checkIns;
        uint128 periodBits;
    }

    IERC20 public immutable usdc;
    uint128 public immutable maxStake;
    address public oracle;
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
    event OracleUpdated(address indexed oracle);

    error InvalidParams();
    error PotNotFound();
    error PotFull();
    error JoiningClosed();
    error AlreadyJoined();
    error NotMember();
    error NotOracle();
    error NotEnoughReps();
    error OutsideWindow();
    error AlreadyCheckedIn();
    error NotEnded();
    error NothingToClaim();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    constructor(address usdc_, address oracle_, uint128 maxStake_, address owner_) Ownable(owner_) {
        if (usdc_ == address(0) || oracle_ == address(0) || maxStake_ == 0) {
            revert InvalidParams();
        }
        usdc = IERC20(usdc_);
        maxStake = maxStake_;
        oracle = oracle_;
        emit OracleUpdated(oracle_);
    }

    function createPot(PotParams calldata params) external nonReentrant returns (uint256) {
        return _createPot(params);
    }

    function createPotWithPermit(
        PotParams calldata params,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        _permit(params.stake, deadline, v, r, s);
        return _createPot(params);
    }

    function join(uint256 potId) external nonReentrant {
        _join(potId);
    }

    function joinWithPermit(uint256 potId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        _permit(_getPot(potId).stake, deadline, v, r, s);
        _join(potId);
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
    ) external onlyOracle {
        Pot storage pot = _getPot(potId);
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
        pot.paidOut += SafeCast.toUint128(amount);

        emit Claimed(potId, msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert InvalidParams();
        oracle = oracle_;
        emit OracleUpdated(oracle_);
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

    function _createPot(PotParams calldata params) private returns (uint256 potId) {
        uint256 titleLength = bytes(params.title).length;
        if (
            params.stake == 0 || params.stake > maxStake || params.repsPerPeriod == 0
                || params.repsPerPeriod > MAX_REPS || params.periods == 0
                || params.periods > MAX_PERIODS || params.periodSeconds < MIN_PERIOD
                || params.periodSeconds > MAX_PERIOD || params.startTime <= block.timestamp
                || params.startTime > block.timestamp + MAX_START_DELAY || params.maxMembers < 2
                || params.maxMembers > MAX_MEMBERS || titleLength == 0
                || titleLength > MAX_TITLE_BYTES
        ) revert InvalidParams();

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
            stake: params.stake,
            paidOut: 0
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
        _join(potId);
    }

    function _join(uint256 potId) private {
        Pot storage pot = _getPot(potId);
        if (block.timestamp >= pot.startTime) revert JoiningClosed();
        if (pot.memberCount >= pot.maxMembers) revert PotFull();
        Member storage member = _members[potId][msg.sender];
        if (member.joined) revert AlreadyJoined();

        member.joined = true;
        pot.memberCount++;

        emit Joined(potId, msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), pot.stake);
    }

    /// @dev A failed permit is ignored so a front-run signature can't block the call; the
    /// transfer below still fails if there is no allowance.
    function _permit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        try IERC20Permit(address(usdc))
            .permit(msg.sender, address(this), value, deadline, v, r, s) {}
            catch {}
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
        uint256 total = uint256(pot.stake) * pot.memberCount;
        if (pot.claimedCount + 1 == pot.completerCount) return total - pot.paidOut;
        return total / pot.completerCount;
    }
}
