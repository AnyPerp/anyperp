// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CollateralVault} from "./CollateralVault.sol";
import {LiquidityVault} from "./LiquidityVault.sol";
import {MarketInsuranceFund} from "./MarketInsuranceFund.sol";

/// @notice Versioned child deployer kept separate so MarketFactory does not
/// embed every vault's creation bytecode and exceed EIP-170 runtime limits.
contract VaultDeployer {
    address public immutable governance;
    address public immutable bootstrapper;
    address public factory;

    event FactorySet(address indexed factory);

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

    function deploy(bytes32 id, address asset, uint256 withdrawalDelay)
        external
        returns (address collateralVault, address liquidityVault, address insuranceFund)
    {
        require(msg.sender == factory, "NOT_FACTORY");
        collateralVault = address(
            new CollateralVault{salt: keccak256(abi.encode(id, "COLLATERAL"))}(asset, factory)
        );
        liquidityVault = address(
            new LiquidityVault{salt: keccak256(abi.encode(id, "LIQUIDITY"))}(
                asset, withdrawalDelay, factory
            )
        );
        insuranceFund = address(
            new MarketInsuranceFund{salt: keccak256(abi.encode(id, "INSURANCE"))}(asset, factory)
        );
    }
}
