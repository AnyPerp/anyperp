// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract FundingEngine {
    /// @return ratePerSecondWad Signed quote funding per base unit and second.
    function computeRate(
        uint256 priceWad,
        int256 skewBaseWad,
        uint256 skewScaleBaseWad,
        uint256 velocityWad,
        uint256 maxRatePerSecondWad
    ) external pure returns (int256 ratePerSecondWad) {
        if (skewScaleBaseWad == 0) return 0;
        uint256 magnitude = Math.mulDiv(
            uint256(skewBaseWad < 0 ? -skewBaseWad : skewBaseWad), velocityWad, skewScaleBaseWad
        );
        magnitude = Math.mulDiv(magnitude, priceWad, 1e18);
        if (magnitude > maxRatePerSecondWad) magnitude = maxRatePerSecondWad;
        return skewBaseWad < 0 ? -int256(magnitude) : int256(magnitude);
    }
}
