// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library FixedPointMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    function mulWadDown(uint256 a, uint256 b) internal pure returns (uint256) {
        return Math.mulDiv(a, b, WAD, Math.Rounding.Floor);
    }

    function mulWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return Math.mulDiv(a, b, WAD, Math.Rounding.Ceil);
    }

    function mulBpsUp(uint256 a, uint256 bps) internal pure returns (uint256) {
        return Math.mulDiv(a, bps, BPS, Math.Rounding.Ceil);
    }

    function abs(int256 value) internal pure returns (uint256) {
        require(value != type(int256).min, "ABS_OVERFLOW");
        return uint256(value < 0 ? -value : value);
    }

    function sameSign(int256 a, int256 b) internal pure returns (bool) {
        return (a >= 0 && b >= 0) || (a <= 0 && b <= 0);
    }
}
