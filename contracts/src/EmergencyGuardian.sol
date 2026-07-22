// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "./libraries/Types.sol";
import {IMarket} from "./interfaces/IMarket.sol";

contract EmergencyGuardian {
    address public immutable council;
    constructor(address council_) { council = council_; }

    function setReduceOnly(address market, bytes32 reason) external {
        require(msg.sender == council, "NOT_COUNCIL");
        IMarket(market).setState(Types.MarketState.ReduceOnly, reason);
    }

    function pauseMarket(address market, bytes32 reason) external {
        require(msg.sender == council, "NOT_COUNCIL");
        IMarket(market).setState(Types.MarketState.Paused, reason);
    }
}
