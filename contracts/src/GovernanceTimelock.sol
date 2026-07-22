// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract GovernanceTimelock is TimelockController {
    constructor(uint256 minimumDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minimumDelay, proposers, executors, admin)
    { }
}
