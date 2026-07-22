// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract MarketRegistry {
    address public immutable governance;
    address public immutable bootstrapper;
    address public factory;
    address[] private allMarkets;
    mapping(bytes32 => address) public marketById;
    mapping(address => bool) public isMarket;

    event FactorySet(address indexed factory);
    event MarketRegistered(bytes32 indexed marketId, address indexed market);

    constructor(address governance_, address bootstrapper_) {
        require(governance_ != address(0) && bootstrapper_ != address(0), "CONFIG");
        governance = governance_;
        bootstrapper = bootstrapper_;
    }

    function setFactory(address factory_) external {
        require((msg.sender == governance || msg.sender == bootstrapper) && factory == address(0), "NOT_GOVERNANCE");
        require(factory_.code.length > 0, "NOT_CONTRACT");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function register(bytes32 marketId, address market) external {
        require(msg.sender == factory, "NOT_FACTORY");
        require(marketById[marketId] == address(0) && market.code.length > 0, "DUPLICATE");
        marketById[marketId] = market;
        isMarket[market] = true;
        allMarkets.push(market);
        emit MarketRegistered(marketId, market);
    }

    function count() external view returns (uint256) { return allMarkets.length; }
    function at(uint256 index) external view returns (address) { return allMarkets[index]; }
}
