// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {Types} from "./libraries/Types.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract ChainlinkAdapter is IOracleAdapter {
    struct FeedConfig {
        IAggregatorV3 feed;
        uint256 heartbeat;
        uint256 confidenceBps;
        uint256 reportedLiquidityWad;
        uint256 historySeconds;
        bytes32 descriptionHash;
        bool enabled;
    }

    address public immutable admin;
    IAggregatorV3 public immutable sequencerUptimeFeed;
    uint256 public immutable sequencerGracePeriod;
    mapping(address => FeedConfig) public feeds;

    event FeedConfigured(address indexed asset, address indexed feed, uint256 heartbeat);

    constructor(address admin_, address sequencerFeed_, uint256 gracePeriod_) {
        admin = admin_;
        sequencerUptimeFeed = IAggregatorV3(sequencerFeed_);
        sequencerGracePeriod = gracePeriod_;
    }

    function configure(
        address asset,
        address feed,
        uint256 heartbeat,
        uint256 confidenceBps,
        uint256 reportedLiquidityWad,
        uint256 historySeconds,
        bytes32 expectedDescriptionHash
    ) external {
        require(msg.sender == admin, "NOT_ADMIN");
        require(asset.code.length > 0 && feed.code.length > 0, "NOT_CONTRACT");
        require(heartbeat > 0, "HEARTBEAT");
        require(expectedDescriptionHash != bytes32(0), "DESCRIPTION_REQUIRED");
        require(keccak256(bytes(IAggregatorV3(feed).description())) == expectedDescriptionHash, "FEED_DENOMINATION");
        feeds[asset] = FeedConfig({
            feed: IAggregatorV3(feed),
            heartbeat: heartbeat,
            confidenceBps: confidenceBps,
            reportedLiquidityWad: reportedLiquidityWad,
            historySeconds: historySeconds,
            descriptionHash: expectedDescriptionHash,
            enabled: true
        });
        emit FeedConfigured(asset, feed, heartbeat);
    }

    function read(address asset) external view returns (Types.PriceData memory data) {
        FeedConfig storage config = feeds[asset];
        require(config.enabled, "NO_FEED");
        if (address(sequencerUptimeFeed) != address(0)) {
            (, int256 status, uint256 startedAt, uint256 sequencerUpdatedAt,) = sequencerUptimeFeed.latestRoundData();
            require(status == 0, "SEQUENCER_DOWN");
            require(sequencerUpdatedAt > 0 && block.timestamp >= sequencerUpdatedAt, "SEQUENCER_ROUND");
            require(block.timestamp > startedAt + sequencerGracePeriod, "SEQUENCER_GRACE");
        }
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = config.feed.latestRoundData();
        require(answer > 0 && updatedAt > 0, "BAD_ROUND");
        require(answeredInRound >= roundId, "INCOMPLETE_ROUND");
        require(block.timestamp >= updatedAt && block.timestamp - updatedAt <= config.heartbeat, "STALE_FEED");
        uint8 decimals = config.feed.decimals();
        require(decimals <= 36, "DECIMALS");
        uint256 price = uint256(answer);
        uint256 priceWad = decimals == 18
            ? price
            : decimals < 18 ? price * (10 ** (18 - decimals)) : price / (10 ** (decimals - 18));
        data = Types.PriceData({
            priceWad: priceWad,
            confidenceBps: config.confidenceBps,
            updatedAt: updatedAt,
            liquidityWad: config.reportedLiquidityWad,
            historySeconds: config.historySeconds,
            validSources: 1
        });
    }
}
