// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FundingEngine} from "../src/FundingEngine.sol";
import {MarginManager} from "../src/MarginManager.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Types} from "../src/libraries/Types.sol";

contract ProtocolMathTest {
    function testMarginRoundsUp() external {
        MarginManager manager = new MarginManager();
        require(manager.requiredInitialMargin(10_001, 1_000) == 1_001, "ROUNDING");
    }

    function testLongAndShortPnlAreOpposite() external {
        PositionManager manager = new PositionManager();
        Types.Position memory longPosition = Types.Position(2e18, 100e18, 0, 0, 0);
        Types.Position memory shortPosition = Types.Position(-2e18, 100e18, 0, 0, 0);
        int256 longPnl = manager.unrealizedPnl(longPosition, 110e18);
        int256 shortPnl = manager.unrealizedPnl(shortPosition, 110e18);
        require(longPnl == 20e18 && shortPnl == -20e18, "PNL");
    }

    function testFundingDirectionFollowsSkew() external {
        FundingEngine engine = new FundingEngine();
        int256 positive = engine.computeRate(100e18, 10e18, 100e18, 1e12, 1e18);
        int256 negative = engine.computeRate(100e18, -10e18, 100e18, 1e12, 1e18);
        require(positive > 0 && negative == -positive, "FUNDING_DIRECTION");
    }
}
