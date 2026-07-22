// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {Types} from "../libraries/Types.sol";

contract MockOracleAdapter is IOracleAdapter {
    mapping(address => Types.PriceData) public prices;

    function set(address asset, Types.PriceData calldata data) external {
        prices[asset] = data;
    }

    function read(address asset) external view returns (Types.PriceData memory) {
        Types.PriceData memory data = prices[asset];
        require(data.priceWad > 0, "NO_PRICE");
        return data;
    }
}
