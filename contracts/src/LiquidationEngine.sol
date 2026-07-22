// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarket} from "./interfaces/IMarket.sol";

contract LiquidationEngine {
    event LiquidationExecuted(
        address indexed market,
        address indexed account,
        address indexed liquidator,
        uint256 closedNotionalWad,
        uint256 rewardWad,
        uint256 badDebtWad
    );

    function liquidate(address market, address account, uint256 maxCloseNotionalWad) external {
        (uint256 closed, uint256 reward, uint256 debt) =
            IMarket(market).liquidateFromEngine(account, maxCloseNotionalWad, msg.sender);
        emit LiquidationExecuted(market, account, msg.sender, closed, reward, debt);
    }
}
