// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

interface IOracleRouter {
    function getPrice(bytes32 routeId) external view returns (Types.PriceData memory);
    function validate(bytes32 routeId, Types.RiskParams calldata risk)
        external
        view
        returns (Types.PriceData memory);
}
