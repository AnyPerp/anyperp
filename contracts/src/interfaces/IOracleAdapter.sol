// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

interface IOracleAdapter {
    function read(address asset) external view returns (Types.PriceData memory);
}
