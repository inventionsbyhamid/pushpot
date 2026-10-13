// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PushPot} from "../src/PushPot.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PushPotTest is Test {
    PushPot internal pot;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal oracle = makeAddr("oracle");
    address internal treasury = makeAddr("treasury");
    address internal curator = makeAddr("curator");
    address internal alice;
    uint256 internal aliceKey;
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint128 internal constant STAKE = 10e6;
    uint128 internal constant MAX_STAKE = 50e6;
    uint32 internal constant DAY = 1 days;
    uint32 internal constant GRACE = 5 minutes;
    uint16 internal constant FEE_BPS = 500;

    function setUp() public {
        vm.warp(1_800_000_000);
        (alice, aliceKey) = makeAddrAndKey("alice");
        usdc = new MockUSDC();
        pot = new PushPot(_config());

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; i++) {
            usdc.mint(users[i], 1_000e6);
            vm.prank(users[i]);
            usdc.approve(address(pot), type(uint256).max);
        }
    }

    function _config() internal view returns (PushPot.Config memory) {
        return PushPot.Config({
            usdc: address(usdc),
            oracle: oracle,
            curator: curator,
            treasury: treasury,
            owner: owner,
            maxStake: MAX_STAKE,
            feeBps: FEE_BPS
        });
    }

    function _params() internal view returns (PushPot.PotParams memory) {
        return PushPot.PotParams({
            title: "Daily 10",
            stake: STAKE,
            repsPerPeriod: 10,
            periods: 3,
            periodSeconds: DAY,
            startTime: uint64(block.timestamp + 1 hours),
            maxMembers: 10
        });
    }

    function _createWith(PushPot.PotParams memory p) internal returns (uint256 id) {
        vm.prank(alice);
        id = pot.createPot(p);
    }

    function _create() internal returns (uint256) {
        return _createWith(_params());
    }

    function _join(uint256 id, address who) internal {
        vm.prank(who);
        pot.join(id);
    }

    function _checkIn(uint256 id, address who, uint16 period) internal {
        vm.prank(oracle);
        pot.checkIn(id, who, period, 10, keccak256(abi.encode(who, period)));
    }

    function _warpToPeriod(uint256 id, uint16 period) internal {
        PushPot.Pot memory p = pot.getPot(id);
        vm.warp(p.startTime + uint256(period) * p.periodSeconds + 1);
    }

    function _warpPastEnd(uint256 id) internal {
        vm.warp(pot.endTime(id) + GRACE);
    }

    function _completeAll(uint256 id, address who) internal {
        PushPot.Pot memory p = pot.getPot(id);
        for (uint16 i; i < p.periods; i++) {
            _warpToPeriod(id, i);
            _checkIn(id, who, i);
        }
    }

    // --- createPot ---

    function test_CreatePot_StoresParamsAndStakesCreator() public {
        uint256 id = _create();

        assertEq(id, 1);
        PushPot.Pot memory p = pot.getPot(id);
        assertEq(p.creator, alice);
        assertEq(p.stake, STAKE);
        assertEq(p.repsPerPeriod, 10);
        assertEq(p.periods, 3);
        assertEq(p.periodSeconds, DAY);
        assertEq(p.maxMembers, 10);
        assertEq(p.memberCount, 1);
        assertTrue(pot.getMember(id, alice).joined);
        assertEq(usdc.balanceOf(address(pot)), STAKE);
    }

    function test_CreatePot_EmitsEvent() public {
        PushPot.PotParams memory p = _params();
        vm.expectEmit(address(pot));
        emit PushPot.PotCreated(
            1,
            alice,
            p.title,
            p.stake,
            p.repsPerPeriod,
            p.periods,
            p.periodSeconds,
            p.startTime,
            p.maxMembers
        );
        _createWith(p);
    }

    function test_CreatePot_RevertsOnInvalidParams() public {
        PushPot.PotParams memory p;

        p = _params();
        p.stake = pot.MIN_STAKE() - 1;
        _expectInvalid(p);

        p = _params();
        p.stake = MAX_STAKE + 1;
        _expectInvalid(p);

        p = _params();
        p.repsPerPeriod = 0;
        _expectInvalid(p);

        p = _params();
        p.periods = 0;
        _expectInvalid(p);

        p = _params();
        p.periods = pot.MAX_PERIODS() + 1;
        _expectInvalid(p);

        p = _params();
        p.periodSeconds = pot.MIN_PERIOD() - 1;
        _expectInvalid(p);

        p = _params();
        p.periodSeconds = pot.MAX_PERIOD() + 1;
        _expectInvalid(p);

        p = _params();
        p.startTime = uint64(block.timestamp);
        _expectInvalid(p);

        p = _params();
        p.startTime = uint64(block.timestamp + pot.MAX_START_DELAY() + 1);
        _expectInvalid(p);

        p = _params();
        p.maxMembers = 1;
        _expectInvalid(p);

        p = _params();
        p.maxMembers = pot.MAX_MEMBERS() + 1;
        _expectInvalid(p);

        p = _params();
        p.title = "";
        _expectInvalid(p);

        p = _params();
        p.title = "gm\x00";
        _expectInvalid(p);

        p = _params();
        p.title = "line\nbreak";
        _expectInvalid(p);

        p = _params();
        p.title = "this title is definitely far too long to be shown nicely on a phone screen";
        _expectInvalid(p);
    }

    function _expectInvalid(PushPot.PotParams memory p) internal {
        vm.prank(alice);
        vm.expectRevert(PushPot.InvalidParams.selector);
        pot.createPot(p);
    }

    function test_CreatePotWithPermit_NoPriorApproval() public {
        address dave;
        uint256 daveKey;
        (dave, daveKey) = makeAddrAndKey("dave");
        usdc.mint(dave, STAKE);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(daveKey, dave, STAKE, deadline);

        vm.prank(dave);
        uint256 id = pot.createPotWithPermit(_params(), deadline, v, r, s);

        assertTrue(pot.getMember(id, dave).joined);
        assertEq(usdc.balanceOf(dave), 0);
    }

    // --- join / leave ---

    function test_Join_TransfersStake() public {
        uint256 id = _create();
        uint256 before = usdc.balanceOf(bob);

        vm.expectEmit(address(pot));
        emit PushPot.Joined(id, bob);
        _join(id, bob);

        assertEq(usdc.balanceOf(bob), before - STAKE);
        assertEq(pot.getPot(id).memberCount, 2);
        assertTrue(pot.getMember(id, bob).joined);
    }

    function test_Join_RevertsWhenAlreadyMember() public {
        uint256 id = _create();
        vm.prank(alice);
        vm.expectRevert(PushPot.AlreadyJoined.selector);
        pot.join(id);
    }

    function test_Join_RevertsAfterStart() public {
        uint256 id = _create();
        vm.warp(pot.getPot(id).startTime);
        vm.prank(bob);
        vm.expectRevert(PushPot.JoiningClosed.selector);
        pot.join(id);
    }

    function test_Join_RevertsWhenFull() public {
        PushPot.PotParams memory p = _params();
        p.maxMembers = 2;
        uint256 id = _createWith(p);
        _join(id, bob);

        vm.prank(carol);
        vm.expectRevert(PushPot.PotFull.selector);
        pot.join(id);
    }

    function test_Join_RevertsForUnknownPot() public {
        vm.prank(bob);
        vm.expectRevert(PushPot.PotNotFound.selector);
        pot.join(42);
    }

    function test_JoinWithPermit() public {
        uint256 id = _create();
        address dave;
        uint256 daveKey;
        (dave, daveKey) = makeAddrAndKey("dave");
        usdc.mint(dave, STAKE);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(daveKey, dave, STAKE, deadline);

        vm.prank(dave);
        pot.joinWithPermit(id, deadline, v, r, s);

        assertTrue(pot.getMember(id, dave).joined);
    }

    function test_JoinWithPermit_SucceedsWhenPermitFrontRun() public {
        uint256 id = _create();
        address dave;
        uint256 daveKey;
        (dave, daveKey) = makeAddrAndKey("dave");
        usdc.mint(dave, STAKE);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(daveKey, dave, STAKE, deadline);
        usdc.permit(dave, address(pot), STAKE, deadline, v, r, s);

        vm.prank(dave);
        pot.joinWithPermit(id, deadline, v, r, s);

        assertTrue(pot.getMember(id, dave).joined);
    }

    function test_Leave_RefundsBeforeStart() public {
        uint256 id = _create();
        _join(id, bob);
        uint256 before = usdc.balanceOf(bob);

        vm.expectEmit(address(pot));
        emit PushPot.Left(id, bob);
        vm.prank(bob);
        pot.leave(id);

        assertEq(usdc.balanceOf(bob), before + STAKE);
        assertEq(pot.getPot(id).memberCount, 1);
        assertFalse(pot.getMember(id, bob).joined);
    }

    function test_Leave_RevertsAfterStart() public {
        uint256 id = _create();
        _join(id, bob);
        vm.warp(pot.getPot(id).startTime);

        vm.prank(bob);
        vm.expectRevert(PushPot.JoiningClosed.selector);
        pot.leave(id);
    }

    function test_Leave_RevertsForNonMember() public {
        uint256 id = _create();
        vm.prank(bob);
        vm.expectRevert(PushPot.NotMember.selector);
        pot.leave(id);
    }

    // --- checkIn ---

    function test_CheckIn_RecordsPeriod() public {
        uint256 id = _create();
        _warpToPeriod(id, 0);
        bytes32 evidence = keccak256("session");

        vm.expectEmit(address(pot));
        emit PushPot.CheckedIn(id, alice, 0, 12, evidence);
        vm.prank(oracle);
        pot.checkIn(id, alice, 0, 12, evidence);

        PushPot.Member memory m = pot.getMember(id, alice);
        assertEq(m.checkIns, 1);
        assertEq(m.periodBits, 1);
    }

    function test_CheckIn_OnlyOracle() public {
        uint256 id = _create();
        _warpToPeriod(id, 0);
        vm.prank(alice);
        vm.expectRevert(PushPot.NotOracle.selector);
        pot.checkIn(id, alice, 0, 10, bytes32(0));
    }

    function test_CheckIn_RevertsForNonMember() public {
        uint256 id = _create();
        _warpToPeriod(id, 0);
        vm.prank(oracle);
        vm.expectRevert(PushPot.NotMember.selector);
        pot.checkIn(id, bob, 0, 10, bytes32(0));
    }

    function test_CheckIn_RevertsBelowTarget() public {
        uint256 id = _create();
        _warpToPeriod(id, 0);
        vm.prank(oracle);
        vm.expectRevert(PushPot.NotEnoughReps.selector);
        pot.checkIn(id, alice, 0, 9, bytes32(0));
    }

    function test_CheckIn_RevertsBeforePeriodStarts() public {
        uint256 id = _create();
        _warpToPeriod(id, 0);
        vm.prank(oracle);
        vm.expectRevert(PushPot.OutsideWindow.selector);
        pot.checkIn(id, alice, 1, 10, bytes32(0));
    }

    function test_CheckIn_AllowsGraceAfterPeriodEnds() public {
        uint256 id = _create();
        PushPot.Pot memory p = pot.getPot(id);
        vm.warp(p.startTime + p.periodSeconds + GRACE - 1);
        _checkIn(id, alice, 0);
        assertEq(pot.getMember(id, alice).checkIns, 1);
    }

    function test_CheckIn_RevertsAfterGrace() public {
        uint256 id = _create();
        PushPot.Pot memory p = pot.getPot(id);
        vm.warp(p.startTime + p.periodSeconds + GRACE);
        vm.prank(oracle);
        vm.expectRevert(PushPot.OutsideWindow.selector);
        pot.checkIn(id, alice, 0, 10, bytes32(0));
    }

    function test_CheckIn_RevertsForPeriodOutOfRange() public {
        uint256 id = _create();
        _warpToPeriod(id, 2);
        vm.prank(oracle);
        vm.expectRevert(PushPot.OutsideWindow.selector);
        pot.checkIn(id, alice, 3, 10, bytes32(0));
    }

    function test_CheckIn_RevertsOnDuplicate() public {
        uint256 id = _create();
        _warpToPeriod(id, 0);
        _checkIn(id, alice, 0);
        vm.prank(oracle);
        vm.expectRevert(PushPot.AlreadyCheckedIn.selector);
        pot.checkIn(id, alice, 0, 10, bytes32(0));
    }

    function test_CheckIn_CountsCompleters() public {
        uint256 id = _create();
        _join(id, bob);
        _completeAll(id, alice);
        assertEq(pot.getPot(id).completerCount, 1);
    }

    // --- claim ---

    function test_Claim_SplitsLoserStakesAmongCompleters() public {
        uint256 id = _create();
        _join(id, bob);
        _join(id, carol);

        PushPot.Pot memory p = pot.getPot(id);
        for (uint16 i; i < p.periods; i++) {
            _warpToPeriod(id, i);
            _checkIn(id, alice, i);
            _checkIn(id, bob, i);
            if (i == 0) _checkIn(id, carol, i);
        }
        _warpPastEnd(id);

        assertEq(pot.claimable(id, alice), 14.75e6);
        assertEq(pot.claimable(id, carol), 0);
        assertEq(pot.collectableFee(id), 0.5e6);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.expectEmit(address(pot));
        emit PushPot.Claimed(id, alice, 14.75e6);
        vm.prank(alice);
        pot.claim(id);
        vm.prank(bob);
        pot.claim(id);
        assertEq(usdc.balanceOf(alice), aliceBefore + 14.75e6);

        vm.expectEmit(address(pot));
        emit PushPot.FeeCollected(id, treasury, 0.5e6);
        pot.collectFee(id);
        assertEq(usdc.balanceOf(treasury), 0.5e6);
        assertEq(usdc.balanceOf(address(pot)), 0);

        vm.prank(carol);
        vm.expectRevert(PushPot.NothingToClaim.selector);
        pot.claim(id);
    }

    function test_Claim_LastCompleterGetsRemainder() public {
        PushPot.PotParams memory p = _params();
        p.stake = pot.MIN_STAKE() + 1;
        p.periods = 1;
        uint256 id = _createWith(p);
        _join(id, bob);
        _join(id, carol);

        _warpToPeriod(id, 0);
        _checkIn(id, alice, 0);
        _checkIn(id, bob, 0);
        _warpPastEnd(id);

        vm.prank(alice);
        pot.claim(id);
        vm.prank(bob);
        pot.claim(id);
        pot.collectFee(id);

        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    function test_Claim_RefundsEveryoneWhenNobodyCompletes() public {
        uint256 id = _create();
        _join(id, bob);
        _warpToPeriod(id, 0);
        _checkIn(id, alice, 0);
        _warpPastEnd(id);

        assertEq(pot.claimable(id, alice), STAKE);
        assertEq(pot.claimable(id, bob), STAKE);

        vm.prank(alice);
        pot.claim(id);
        vm.prank(bob);
        pot.claim(id);
        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    function test_Claim_EveryoneCompletesGetsStakeBack() public {
        uint256 id = _create();
        _join(id, bob);
        PushPot.Pot memory p = pot.getPot(id);
        for (uint16 i; i < p.periods; i++) {
            _warpToPeriod(id, i);
            _checkIn(id, alice, i);
            _checkIn(id, bob, i);
        }
        _warpPastEnd(id);

        assertEq(pot.claimable(id, alice), STAKE);
        assertEq(pot.claimable(id, bob), STAKE);
    }

    function test_Claim_RevertsBeforeEnd() public {
        uint256 id = _create();
        _completeAll(id, alice);
        vm.prank(alice);
        vm.expectRevert(PushPot.NotEnded.selector);
        pot.claim(id);
    }

    function test_Claim_RevertsOnSecondClaim() public {
        uint256 id = _create();
        _join(id, bob);
        _completeAll(id, alice);
        _warpPastEnd(id);

        vm.startPrank(alice);
        pot.claim(id);
        vm.expectRevert(PushPot.NothingToClaim.selector);
        pot.claim(id);
        vm.stopPrank();
    }

    function test_Claim_RevertsForNonMember() public {
        uint256 id = _create();
        _warpPastEnd(id);
        vm.prank(bob);
        vm.expectRevert(PushPot.NothingToClaim.selector);
        pot.claim(id);
    }

    // --- views ---

    function test_CurrentPeriod() public {
        uint256 id = _create();
        assertEq(pot.currentPeriod(id), type(uint256).max);
        _warpToPeriod(id, 1);
        assertEq(pot.currentPeriod(id), 1);
        _warpPastEnd(id);
        assertEq(pot.currentPeriod(id), type(uint256).max);
    }

    // --- admin ---

    function test_SetOracle() public {
        address next = makeAddr("next");
        vm.expectEmit(address(pot));
        emit PushPot.OracleUpdated(next);
        vm.prank(owner);
        pot.setOracle(next);
        assertEq(pot.oracle(), next);
    }

    function test_CreatePot_RecordsCurrentOracle() public {
        uint256 id = _create();
        assertEq(pot.getPot(id).oracle, oracle);
    }

    function test_SetOracle_DoesNotChangeExistingPots() public {
        uint256 id = _create();
        address next = makeAddr("next");
        vm.prank(owner);
        pot.setOracle(next);

        _warpToPeriod(id, 0);
        vm.prank(next);
        vm.expectRevert(PushPot.NotOracle.selector);
        pot.checkIn(id, alice, 0, 10, bytes32(0));

        _checkIn(id, alice, 0);
        assertEq(pot.getMember(id, alice).checkIns, 1);

        vm.prank(alice);
        uint256 later = pot.createPot(_params());
        assertEq(pot.getPot(later).oracle, next);
    }

    function test_RevokeOracle_StopsCheckInsAndRefundsEveryone() public {
        uint256 id = _create();
        _join(id, bob);
        _warpToPeriod(id, 0);
        _checkIn(id, alice, 0);

        vm.expectEmit(address(pot));
        emit PushPot.OracleRevoked(oracle);
        vm.prank(owner);
        pot.revokeOracle(oracle);
        assertEq(pot.oracle(), address(0));

        _warpToPeriod(id, 1);
        vm.prank(oracle);
        vm.expectRevert(PushPot.NotOracle.selector);
        pot.checkIn(id, alice, 1, 10, bytes32(0));

        _warpPastEnd(id);
        assertEq(pot.claimable(id, alice), STAKE);
        assertEq(pot.claimable(id, bob), STAKE);
    }

    function test_RevokeOracle_BlocksNewPotsUntilReplaced() public {
        vm.prank(owner);
        pot.revokeOracle(oracle);

        PushPot.PotParams memory p = _params();
        vm.prank(alice);
        vm.expectRevert(PushPot.Paused.selector);
        pot.createPot(p);

        vm.prank(owner);
        vm.expectRevert(PushPot.InvalidParams.selector);
        pot.setOracle(oracle);

        address next = makeAddr("next");
        vm.prank(owner);
        pot.setOracle(next);
        assertEq(pot.getPot(_createWith(p)).oracle, next);
    }

    function test_RevokeOracle_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.revokeOracle(oracle);
    }

    function test_Constructor_BoundsMaxStake() public {
        (uint128 min, uint128 max) = (pot.MIN_STAKE(), pot.MAX_STAKE_LIMIT());

        PushPot.Config memory config = _config();
        config.maxStake = max + 1;
        vm.expectRevert(PushPot.InvalidParams.selector);
        new PushPot(config);

        config.maxStake = min - 1;
        vm.expectRevert(PushPot.InvalidParams.selector);
        new PushPot(config);
    }

    function test_CollectFee_NothingWhenNobodyOrEverybodyFinishes() public {
        uint256 nobody = _create();
        _join(nobody, bob);
        uint256 everybody = _create();
        _join(everybody, bob);
        PushPot.Pot memory p = pot.getPot(everybody);
        for (uint16 i; i < p.periods; i++) {
            _warpToPeriod(everybody, i);
            _checkIn(everybody, alice, i);
            _checkIn(everybody, bob, i);
        }
        _warpPastEnd(everybody);

        for (uint256 id = nobody; id <= everybody; id++) {
            assertEq(pot.collectableFee(id), 0);
            vm.expectRevert(PushPot.NothingToClaim.selector);
            pot.collectFee(id);
        }
    }

    function test_CollectFee_RevertsBeforeEndAndOnlyOnce() public {
        uint256 id = _create();
        _join(id, bob);
        _completeAll(id, alice);

        vm.expectRevert(PushPot.NotEnded.selector);
        pot.collectFee(id);

        _warpPastEnd(id);
        pot.collectFee(id);
        vm.expectRevert(PushPot.NothingToClaim.selector);
        pot.collectFee(id);
    }

    function test_SetFee_AppliesToNewPotsOnly() public {
        uint256 before = _create();
        vm.expectEmit(address(pot));
        emit PushPot.FeeUpdated(1000);
        vm.prank(owner);
        pot.setFee(1000);

        assertEq(pot.getPot(before).feeBps, FEE_BPS);
        assertEq(pot.getPot(_create()).feeBps, 1000);
    }

    function test_SetFee_IsCappedAndOwnerOnly() public {
        uint16 max = pot.MAX_FEE_BPS();
        vm.prank(owner);
        vm.expectRevert(PushPot.InvalidParams.selector);
        pot.setFee(max + 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.setFee(0);
    }

    function test_SetTreasury() public {
        address next = makeAddr("next-treasury");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.setTreasury(next);

        vm.prank(owner);
        vm.expectRevert(PushPot.InvalidParams.selector);
        pot.setTreasury(address(0));

        vm.expectEmit(address(pot));
        emit PushPot.TreasuryUpdated(next);
        vm.prank(owner);
        pot.setTreasury(next);
        assertEq(pot.treasury(), next);
    }

    function test_Constructor_ValidatesFeeAndTreasury() public {
        PushPot.Config memory config = _config();
        config.feeBps = pot.MAX_FEE_BPS() + 1;
        vm.expectRevert(PushPot.InvalidParams.selector);
        new PushPot(config);

        config = _config();
        config.treasury = address(0);
        vm.expectRevert(PushPot.InvalidParams.selector);
        new PushPot(config);
    }

    function test_CreateChallenge_OpensPotWithoutCuratorStake() public {
        vm.expectEmit(address(pot));
        emit PushPot.ChallengeCreated(1);
        vm.prank(curator);
        uint256 id = pot.createChallenge(_params());

        PushPot.Pot memory p = pot.getPot(id);
        assertTrue(p.official);
        assertEq(p.memberCount, 0);
        assertEq(p.creator, curator);
        assertFalse(pot.getMember(id, curator).joined);
        assertEq(usdc.balanceOf(address(pot)), 0);

        _join(id, alice);
        _join(id, bob);
        _completeAll(id, alice);
        _warpPastEnd(id);
        assertEq(pot.claimable(id, alice), 19.5e6);
        assertEq(pot.collectableFee(id), 0.5e6);
    }

    function test_CreateChallenge_AllowsLargerGroups() public {
        PushPot.PotParams memory p = _params();
        p.maxMembers = pot.MAX_CHALLENGE_MEMBERS();
        vm.prank(curator);
        uint256 id = pot.createChallenge(p);
        assertEq(pot.getPot(id).maxMembers, p.maxMembers);

        vm.prank(alice);
        vm.expectRevert(PushPot.InvalidParams.selector);
        pot.createPot(p);
    }

    function test_CreateChallenge_OnlyCurator() public {
        PushPot.PotParams memory p = _params();
        vm.prank(alice);
        vm.expectRevert(PushPot.NotCurator.selector);
        pot.createChallenge(p);

        vm.prank(owner);
        pot.removeCurator();
        assertEq(pot.curator(), address(0));
        vm.prank(curator);
        vm.expectRevert(PushPot.NotCurator.selector);
        pot.createChallenge(p);
    }

    function test_SetCurator_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.setCurator(alice);

        vm.prank(owner);
        vm.expectRevert(PushPot.InvalidParams.selector);
        pot.setCurator(address(0));

        vm.expectEmit(address(pot));
        emit PushPot.CuratorUpdated(alice);
        vm.prank(owner);
        pot.setCurator(alice);
        assertEq(pot.curator(), alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.removeCurator();
    }

    function test_RenounceOwnership_IsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(PushPot.RenounceDisabled.selector);
        pot.renounceOwnership();
        assertEq(pot.owner(), owner);
    }

    function test_CreatePot_AcceptsUnicodeTitle() public {
        PushPot.PotParams memory p = _params();
        p.title = unicode"Morgenrunde 💪";
        uint256 id = _createWith(p);
        assertEq(pot.getPot(id).creator, alice);
    }

    function test_SetOracle_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.setOracle(alice);
    }

    function test_Pause_BlocksCreateAndJoin() public {
        uint256 id = _create();
        vm.expectEmit(address(pot));
        emit PushPot.PausedSet(true);
        vm.prank(owner);
        pot.setPaused(true);

        PushPot.PotParams memory p = _params();
        vm.prank(alice);
        vm.expectRevert(PushPot.Paused.selector);
        pot.createPot(p);

        vm.prank(bob);
        vm.expectRevert(PushPot.Paused.selector);
        pot.join(id);
    }

    function test_Pause_KeepsExistingPotsWorking() public {
        uint256 id = _create();
        _join(id, bob);
        _join(id, carol);
        vm.prank(owner);
        pot.setPaused(true);

        vm.prank(carol);
        pot.leave(id);

        _completeAll(id, alice);
        _warpPastEnd(id);
        vm.prank(alice);
        pot.claim(id);
        pot.collectFee(id);
        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    function test_SetPaused_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pot.setPaused(true);
    }

    // --- invariants ---

    function testFuzz_PayoutsConserveFunds(uint8 memberCount, uint64 completedMask, uint128 stake)
        public
    {
        memberCount = uint8(bound(memberCount, 2, 20));
        stake = uint128(bound(stake, pot.MIN_STAKE(), MAX_STAKE));

        PushPot.PotParams memory p = _params();
        p.stake = stake;
        p.periods = 1;
        p.maxMembers = memberCount;
        uint256 id = _createWith(p);

        address[] memory members = new address[](memberCount);
        members[0] = alice;
        for (uint256 i = 1; i < memberCount; i++) {
            members[i] = address(uint160(0x1000 + i));
            usdc.mint(members[i], stake);
            vm.prank(members[i]);
            usdc.approve(address(pot), stake);
            _join(id, members[i]);
        }

        _warpToPeriod(id, 0);
        for (uint256 i; i < memberCount; i++) {
            if (completedMask & (1 << i) != 0) _checkIn(id, members[i], 0);
        }
        _warpPastEnd(id);

        uint256 paid;
        for (uint256 i; i < memberCount; i++) {
            uint256 amount = pot.claimable(id, members[i]);
            if (amount == 0) continue;
            uint256 before = usdc.balanceOf(members[i]);
            vm.prank(members[i]);
            pot.claim(id);
            assertEq(usdc.balanceOf(members[i]) - before, amount);
            paid += amount;
        }

        uint256 fee = pot.collectableFee(id);
        if (fee > 0) pot.collectFee(id);

        assertEq(paid + fee, uint256(stake) * memberCount);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(pot)), 0);
    }

    function _signPermit(uint256 key, address holder, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                holder,
                address(pot),
                value,
                usdc.nonces(holder),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }
}
