// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {Types} from "./libraries/Types.sol";

/// @notice Adapter boundary for a verified DEX-specific TWAP source. A production Uniswap
/// implementation must be configured only after the Robinhood deployment and pool factory
/// are independently confirmed. The source must calculate counterfactual TWAP on-chain.
interface IVerifiedTwapSource {
    function consult(address asset, uint32 window)
        external
        view
        returns (uint256 priceWad, uint256 liquidityWad, uint256 oldestObservation, uint256 confidenceBps);
}

contract DexTwapAdapter is IOracleAdapter {
    struct Config {
        IVerifiedTwapSource source;
        uint32 window;
        bool enabled;
    }

    address public immutable admin;
    mapping(address => Config) public configs;

    constructor(address admin_) {
        admin = admin_;
    }

    function configure(address asset, address source, uint32 window) external {
        require(msg.sender == admin, "NOT_ADMIN");
        require(source.code.length > 0 && window >= 300, "CONFIG");
        configs[asset] = Config(IVerifiedTwapSource(source), window, true);
    }

    function read(address asset) external view returns (Types.PriceData memory data) {
        Config storage config = configs[asset];
        require(config.enabled, "NO_TWAP");
        (uint256 price, uint256 liquidity, uint256 oldest, uint256 confidence) =
            config.source.consult(asset, config.window);
        require(price > 0 && oldest <= block.timestamp, "BAD_TWAP");
        data = Types.PriceData({
            priceWad: price,
            confidenceBps: confidence,
            updatedAt: block.timestamp,
            liquidityWad: liquidity,
            historySeconds: block.timestamp - oldest,
            validSources: 1
        });
    }
}
