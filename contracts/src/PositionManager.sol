// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "./libraries/Types.sol";
import {IMarket} from "./interfaces/IMarket.sol";

contract PositionManager {
    function getPosition(address market, address account) external view returns (Types.Position memory) {
        return IMarket(market).position(account);
    }

    function unrealizedPnl(Types.Position calldata position, uint256 markPriceWad)
        external
        pure
        returns (int256)
    {
        return position.sizeBaseWad * (int256(markPriceWad) - int256(position.entryPriceWad)) / int256(1e18);
    }
}
