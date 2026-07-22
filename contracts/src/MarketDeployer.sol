// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Market} from "./Market.sol";
import {Types} from "./libraries/Types.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice Versioned Market creation boundary. Keeping Market creation bytecode
/// outside the factory makes factory deployment portable to standard EVM limits.
contract MarketDeployer {
    address public immutable governance;
    address public immutable bootstrapper;
    address public immutable implementation;
    address public factory;

    event FactorySet(address indexed factory);

    constructor(address governance_, address bootstrapper_, address implementation_) {
        require(
            governance_ != address(0) && bootstrapper_ != address(0) && implementation_.code.length > 0,
            "CONFIG"
        );
        governance = governance_;
        bootstrapper = bootstrapper_;
        implementation = implementation_;
    }

    function setFactory(address factory_) external {
        require((msg.sender == governance || msg.sender == bootstrapper) && factory == address(0), "NOT_GOVERNANCE");
        require(factory_.code.length > 0, "NOT_CONTRACT");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function deploy(
        bytes32 id,
        address creator,
        address governance_,
        address guardian,
        address baseToken,
        address collateralToken,
        Types.RiskTier tier,
        Types.RiskParams calldata risk,
        address oracleRouter,
        bytes32 oracleRouteId,
        address collateralVault,
        address liquidityVault,
        address insuranceFund,
        address fundingEngine,
        address feeManager,
        address protocolBackstop
    ) external returns (address market) {
        require(msg.sender == factory, "NOT_FACTORY");
        market = Clones.cloneDeterministic(implementation, id);
        Market(market).initialize(
            id,
            creator,
            factory,
            governance_,
            guardian,
            baseToken,
            collateralToken,
            tier,
            risk,
            oracleRouter,
            oracleRouteId,
            collateralVault,
            liquidityVault,
            insuranceFund,
            fundingEngine,
            feeManager,
            protocolBackstop
        );
    }
}
