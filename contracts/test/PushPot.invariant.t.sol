// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PushPot} from "../src/PushPot.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PushPotHandler is Test {
    PushPot internal immutable pot;
    MockUSDC internal immutable usdc;
    address internal immutable oracle;

    address[] internal actors;
    uint256[] public potIds;

    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public checkIns;
    uint256 public claims;
    uint256 public currentTime;

    modifier useCurrentTime() {
        vm.warp(currentTime);
        _;
    }

    constructor(PushPot pot_, MockUSDC usdc_, address oracle_) {
        pot = pot_;
        usdc = usdc_;
        oracle = oracle_;
        currentTime = block.timestamp;
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
            stake: uint128(bound(stake, 1, pot.maxStake())),
            repsPerPeriod: 10,
            periods: uint16(bound(periods, 1, 3)),
            periodSeconds: pot.MIN_PERIOD(),
            startTime: uint64(block.timestamp + 30 minutes),
            maxMembers: uint16(bound(maxMembers, 2, actors.length))
        });
        vm.prank(actor);
        uint256 id = pot.createPot(p);
        potIds.push(id);
        deposited += p.stake;
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
            vm.prank(oracle);
            try pot.checkIn(id, actors[i], uint16(period), 10, bytes32(0)) {
                checkIns++;
            } catch {}
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
        address oracle = makeAddr("oracle");
        pot = new PushPot(address(usdc), oracle, 50e6, address(this));
        handler = new PushPotHandler(pot, usdc, oracle);
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
            assertLe(p.paidOut, total);
            assertLe(p.completerCount, p.memberCount);
            owed += total - p.paidOut;
        }
        assertEq(usdc.balanceOf(address(pot)), owed);
    }
}
