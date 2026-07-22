// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract MarginManager {
    function requiredInitialMargin(uint256 notionalWad, uint256 initialMarginBps)
        external
        pure
        returns (uint256)
    {
        return Math.mulDiv(notionalWad, initialMarginBps, 10_000, Math.Rounding.Ceil);
    }

    function requiredMaintenanceMargin(uint256 notionalWad, uint256 maintenanceMarginBps)
        external
        pure
        returns (uint256)
    {
        return Math.mulDiv(notionalWad, maintenanceMarginBps, 10_000, Math.Rounding.Ceil);
    }
}
