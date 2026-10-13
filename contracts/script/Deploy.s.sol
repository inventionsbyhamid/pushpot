// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {PushPot} from "../src/PushPot.sol";

contract Deploy is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (PushPot pot) {
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        uint128 maxStake = uint128(vm.envOr("MAX_STAKE", uint256(50e6)));

        vm.startBroadcast();
        address owner = vm.envOr("OWNER_ADDRESS", msg.sender);
        pot = new PushPot(usdc, oracle, maxStake, owner);
        vm.stopBroadcast();

        console.log("PushPot deployed at", address(pot));
        console.log("block", block.number);
    }
}
