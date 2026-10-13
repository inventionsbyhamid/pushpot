// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PushPot} from "../src/PushPot.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PushPotHandler is Test {
    PushPot internal immutable pot;
    MockUSDC internal immutable usdc;

    address[] internal actors;
    address[] internal oracles;
    uint256[] public potIds;
    mapping(uint256 potId => address) public oracleAtCreation;

    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public checkIns;
    uint256 public claims;
    uint256 public currentTime;

    modifier useCurrentTime() {
        vm.warp(currentTime);
        _;
    }

    constructor(PushPot pot_, MockUSDC usdc_) {
        pot = pot_;
        usdc = usdc_;
        currentTime = block.timestamp;
        oracles.push(pot_.oracle());
        oracles.push(makeAddr("oracle-b"));
        oracles.push(makeAddr("oracle-c"));
        for (uint256 i; i < 5; i++) {
            address actor = address(uint160(0xA000 + i));
            actors.push(actor);
            usdc.mint(actor, 1_000_000e6);
            vm.prank(actor);
            usdc.approve(address(pot), type(uint256).max);
        }
    }

    function potCount() external view returns (uint256) {
        return potIds.length;
    }

    function createPot(uint256 actorSeed, uint128 stake, uint16 periods, uint16 maxMembers)
        external
        useCurrentTime
    {
        address actor = _actor(actorSeed);
        PushPot.PotParams memory p = PushPot.PotParams({
            title: "fuzz",
            stake: uint128(bound(stake, pot.MIN_STAKE(), pot.maxStake())),
            repsPerPeriod: 10,
            periods: uint16(bound(periods, 1, 3)),
            periodSeconds: pot.MIN_PERIOD(),
            startTime: uint64(block.timestamp + 30 minutes),
            maxMembers: uint16(bound(maxMembers, 2, actors.length))
        });
        vm.prank(actor);
        try pot.createPot(p) returns (uint256 id) {
            potIds.push(id);
            oracleAtCreation[id] = pot.oracle();
            deposited += p.stake;
        } catch {}
    }

    function join(uint256 potSeed, uint256 actorSeed) external useCurrentTime {
        if (potIds.length == 0) return;
        uint256 id = _pot(potSeed);
        vm.prank(_actor(actorSeed));
        try pot.join(id) {
            deposited += pot.getPot(id).stake;
        } catch {}
    }

    function leave(uint256 potSeed, uint256 actorSeed) external useCurrentTime {
        if (potIds.length == 0) return;
        uint256 id = _pot(potSeed);
        vm.prank(_actor(actorSeed));
        try pot.leave(id) {
            withdrawn += pot.getPot(id).stake;
        } catch {}
    }

    function checkIn(uint256 potSeed, uint8 memberMask) external useCurrentTime {
        if (potIds.length == 0) return;
        uint256 id = _pot(potSeed);
        uint256 period = pot.currentPeriod(id);
        if (period == type(uint256).max) return;
        for (uint256 i; i < actors.length; i++) {
            if (memberMask & (1 << i) == 0) continue;
            vm.prank(pot.getPot(id).oracle);
            try pot.checkIn(id, actors[i], uint16(period), 10, bytes32(0)) {
                checkIns++;
            } catch {}
        }
    }

    function createChallenge(uint128 stake, uint16 periods) external useCurrentTime {
        PushPot.PotParams memory p = PushPot.PotParams({
            title: "official",
            stake: uint128(bound(stake, pot.MIN_STAKE(), pot.maxStake())),
            repsPerPeriod: 20,
            periods: uint16(bound(periods, 1, 3)),
            periodSeconds: pot.MIN_PERIOD(),
            startTime: uint64(block.timestamp + 30 minutes),
            maxMembers: uint16(actors.length)
        });
        vm.prank(pot.curator());
        try pot.createChallenge(p) returns (uint256 id) {
            potIds.push(id);
            oracleAtCreation[id] = pot.oracle();
        } catch {}
    }

    function collectFee(uint256 potSeed) external useCurrentTime {
        if (potIds.length == 0) return;
        try pot.collectFee(_pot(potSeed)) returns (uint256 fee) {
            withdrawn += fee;
        } catch {}
    }

    function setFee(uint16 feeBps) external {
        pot.setFee(uint16(bound(feeBps, 0, pot.MAX_FEE_BPS())));
    }

    function rotateOracle(uint256 seed) external {
        address candidate = oracles[seed % oracles.length];
        if (seed % 5 == 0) {
            pot.revokeOracle(candidate);
        } else {
            try pot.setOracle(candidate) {} catch {}
        }
    }

    function warp(uint256 secondsSeed) external {
        currentTime += bound(secondsSeed, 1, 20 minutes);
    }

    function claim(uint256 potSeed) external useCurrentTime {
        if (potIds.length == 0) return;
        uint256 id = _pot(potSeed);
        for (uint256 i; i < actors.length; i++) {
            address actor = actors[i];
            uint256 before = usdc.balanceOf(actor);
            vm.prank(actor);
            try pot.claim(id) {
                withdrawn += usdc.balanceOf(actor) - before;
                claims++;
            } catch {}
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pot(uint256 seed) internal view returns (uint256) {
        return potIds[seed % potIds.length];
    }
}

contract PushPotInvariantTest is Test {
    PushPot internal pot;
    MockUSDC internal usdc;
    PushPotHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        pot = new PushPot(
            PushPot.Config({
                usdc: address(usdc),
                oracle: makeAddr("oracle"),
                curator: makeAddr("curator"),
                treasury: makeAddr("treasury"),
                owner: address(this),
                maxStake: 50e6,
                feeBps: 500
            })
        );
        handler = new PushPotHandler(pot, usdc);
        pot.transferOwnership(address(handler));
        vm.prank(address(handler));
        pot.acceptOwnership();
        targetContract(address(handler));
    }

    function invariant_BalanceMatchesFlows() public view {
        assertEq(usdc.balanceOf(address(pot)), handler.deposited() - handler.withdrawn());
    }

    function invariant_BalanceCoversEveryPot() public view {
        uint256 owed;
        for (uint256 i; i < handler.potCount(); i++) {
            PushPot.Pot memory p = pot.getPot(handler.potIds(i));
            uint256 total = uint256(p.stake) * p.memberCount;
            uint256 fee = p.feeCollected ? _expectedFee(p) : 0;
            assertLe(p.paidOut + fee, total);
            assertLe(p.completerCount, p.memberCount);
            owed += total - p.paidOut - fee;
        }
        assertEq(usdc.balanceOf(address(pot)), owed);
    }

    function invariant_PotsKeepTheirOracle() public view {
        for (uint256 i; i < handler.potCount(); i++) {
            uint256 id = handler.potIds(i);
            assertEq(pot.getPot(id).oracle, handler.oracleAtCreation(id));
        }
    }

    /// Fee as specified: a share of the forfeited stakes, and nothing if nobody completed.
    function _expectedFee(PushPot.Pot memory p) internal pure returns (uint256) {
        if (p.completerCount == 0) return 0;
        return uint256(p.stake) * (p.memberCount - p.completerCount) * p.feeBps / 10_000;
    }
}
