// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

interface IMarket {
    function marketId() external view returns (bytes32);
    function state() external view returns (Types.MarketState);
    function setState(Types.MarketState next, bytes32 reason) external;
    function depositMargin(uint256 amount) external;
    function withdrawMargin(uint256 amount) external;
    function executeTrade(int256 sizeDelta, uint256 limitPrice, uint256 deadline) external;
    function updateFunding() external;
    function liquidateFromEngine(address account, uint256 maxCloseNotionalWad, address liquidator)
        external
        returns (uint256 closedNotionalWad, uint256 rewardWad, uint256 badDebtWad);
    function position(address account) external view returns (Types.Position memory);
}
