// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Types} from "./libraries/Types.sol";
import {RiskManager} from "./RiskManager.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {Market} from "./Market.sol";
import {CollateralVault} from "./CollateralVault.sol";
import {LiquidityVault} from "./LiquidityVault.sol";
import {MarketInsuranceFund} from "./MarketInsuranceFund.sol";
import {VaultDeployer} from "./VaultDeployer.sol";
import {MarketDeployer} from "./MarketDeployer.sol";

contract MarketFactory {
    using SafeERC20 for IERC20;

    struct Deployment {
        address market;
        address collateralVault;
        address liquidityVault;
        address insuranceFund;
        address creator;
        address collateral;
        uint256 bond;
        uint256 createdAt;
        bool bondClaimed;
    }

    address public immutable governance;
    address public immutable guardian;
    RiskManager public immutable riskManager;
    IOracleRouter public immutable oracleRouter;
    MarketRegistry public immutable registry;
    address public immutable fundingEngine;
    address public immutable feeManager;
    address public immutable liquidationEngine;
    address public immutable triggerOrderManager;
    address public immutable protocolBackstop;
    VaultDeployer public immutable vaultDeployer;
    MarketDeployer public immutable marketDeployer;
    uint256 public immutable withdrawalDelay;
    uint256 public immutable validationTimeout;
    uint256 public immutable bondLockPeriod;

    mapping(address => bool) public supportedCollateral;
    mapping(bytes32 => Deployment) public deployments;

    event CollateralStatusChanged(address indexed collateral, bool supported);
    event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed creator);
    event MarketValidated(bytes32 indexed marketId);
    event MarketSeeded(bytes32 indexed marketId, uint256 lpAssets, uint256 insuranceAssets);
    event MarketActivated(bytes32 indexed marketId);
    event CreatorBondClaimed(bytes32 indexed marketId, address indexed creator, uint256 amount);

    constructor(
        address governance_,
        address guardian_,
        address riskManager_,
        address oracleRouter_,
        address registry_,
        address fundingEngine_,
        address feeManager_,
        address liquidationEngine_,
        address triggerOrderManager_,
        address protocolBackstop_,
        address vaultDeployer_,
        address marketDeployer_,
        uint256 withdrawalDelay_
    ) {
        governance = governance_;
        guardian = guardian_;
        riskManager = RiskManager(riskManager_);
        oracleRouter = IOracleRouter(oracleRouter_);
        registry = MarketRegistry(registry_);
        fundingEngine = fundingEngine_;
        feeManager = feeManager_;
        liquidationEngine = liquidationEngine_;
        triggerOrderManager = triggerOrderManager_;
        protocolBackstop = protocolBackstop_;
        vaultDeployer = VaultDeployer(vaultDeployer_);
        marketDeployer = MarketDeployer(marketDeployer_);
        withdrawalDelay = withdrawalDelay_;
        validationTimeout = 7 days;
        bondLockPeriod = 30 days;
    }

    function setSupportedCollateral(address collateral, bool supported) external {
        require(msg.sender == governance, "NOT_GOVERNANCE");
        require(collateral.code.length > 0, "NOT_CONTRACT");
        supportedCollateral[collateral] = supported;
        emit CollateralStatusChanged(collateral, supported);
    }

    function createMarket(Types.CreateMarketParams calldata params) external returns (bytes32 id, address marketAddress) {
        require(params.baseToken.code.length > 0, "BASE_NOT_CONTRACT");
        require(supportedCollateral[params.collateralToken], "COLLATERAL_UNSUPPORTED");
        require(params.baseToken != params.collateralToken, "SAME_TOKEN");
        uint8 baseDecimals = IERC20Metadata(params.baseToken).decimals();
        require(baseDecimals <= 18, "BASE_DECIMALS");
        riskManager.validate(params.tier, params.risk);
        oracleRouter.validate(params.oracleRouteId, params.risk);
        uint8 collateralDecimals = IERC20Metadata(params.collateralToken).decimals();
        require(collateralDecimals <= 18, "COLLATERAL_DECIMALS");
        uint256 bondWad = params.creatorBond * (10 ** (18 - collateralDecimals));
        require(bondWad >= params.risk.minCreatorBondWad, "BOND_REQUIRED");

        id = keccak256(abi.encode(block.chainid, params.baseToken, params.collateralToken, params.oracleRouteId, params.userSalt));
        require(deployments[id].market == address(0), "MARKET_EXISTS");
        IERC20(params.collateralToken).safeTransferFrom(msg.sender, address(this), params.creatorBond);

        (address collateralVaultAddress, address liquidityVaultAddress, address insuranceFundAddress) =
            vaultDeployer.deploy(id, params.collateralToken, withdrawalDelay);
        address marketAddress_ = marketDeployer.deploy(
            id,
            msg.sender,
            governance,
            guardian,
            params.baseToken,
            params.collateralToken,
            params.tier,
            params.risk,
            address(oracleRouter),
            params.oracleRouteId,
            collateralVaultAddress,
            liquidityVaultAddress,
            insuranceFundAddress,
            fundingEngine,
            feeManager,
            protocolBackstop
        );
        Market market = Market(marketAddress_);
        CollateralVault collateralVault = CollateralVault(collateralVaultAddress);
        LiquidityVault liquidityVault = LiquidityVault(liquidityVaultAddress);
        MarketInsuranceFund insuranceFund = MarketInsuranceFund(insuranceFundAddress);
        collateralVault.setMarket(marketAddress_);
        liquidityVault.setMarket(marketAddress_);
        insuranceFund.setMarket(marketAddress_);
        market.setLiquidationEngine(liquidationEngine);
        market.setTriggerOrderManager(triggerOrderManager);

        deployments[id] = Deployment({
            market: marketAddress_,
            collateralVault: collateralVaultAddress,
            liquidityVault: liquidityVaultAddress,
            insuranceFund: insuranceFundAddress,
            creator: msg.sender,
            collateral: params.collateralToken,
            bond: params.creatorBond,
            createdAt: block.timestamp,
            bondClaimed: false
        });
        registry.register(id, marketAddress_);
        emit MarketCreated(id, marketAddress_, msg.sender);
        return (id, marketAddress_);
    }

    function validateMarket(bytes32 id) external {
        Deployment storage deployment = deployments[id];
        require(deployment.market != address(0), "UNKNOWN_MARKET");
        Market market = Market(deployment.market);
        oracleRouter.validate(market.oracleRouteId(), market.riskParams());
        market.setState(Types.MarketState.Bootstrapping, keccak256("VALIDATED"));
        emit MarketValidated(id);
    }

    function seedMarket(bytes32 id, uint256 lpAssets, uint256 insuranceAssets) external {
        Deployment storage deployment = deployments[id];
        require(deployment.market != address(0), "UNKNOWN_MARKET");
        require(Market(deployment.market).state() == Types.MarketState.Bootstrapping, "NOT_BOOTSTRAPPING");
        LiquidityVault(deployment.liquidityVault).depositFor(msg.sender, lpAssets, msg.sender);
        if (insuranceAssets > 0) {
            require(msg.sender == deployment.creator, "CREATOR_INSURANCE_ONLY");
            MarketInsuranceFund(deployment.insuranceFund).depositFrom(msg.sender, insuranceAssets);
        }
        emit MarketSeeded(id, lpAssets, insuranceAssets);
    }

    function activateMarket(bytes32 id) external {
        Deployment storage deployment = deployments[id];
        Market market = Market(deployment.market);
        require(market.state() == Types.MarketState.Bootstrapping, "NOT_BOOTSTRAPPING");
        Types.RiskParams memory risk = market.riskParams();
        uint8 decimals = IERC20Metadata(deployment.collateral).decimals();
        uint256 scale = 10 ** (18 - decimals);
        require(IERC20(deployment.collateral).balanceOf(deployment.liquidityVault) * scale >= risk.minSeedLiquidityWad, "LP_SEED");
        require(IERC20(deployment.collateral).balanceOf(deployment.insuranceFund) * scale >= risk.minInsuranceWad, "INSURANCE_SEED");
        oracleRouter.validate(market.oracleRouteId(), risk);
        market.setState(Types.MarketState.Active, keccak256("ACTIVATED"));
        emit MarketActivated(id);
    }

    function rejectExpiredMarket(bytes32 id) external {
        Deployment storage deployment = deployments[id];
        require(deployment.market != address(0), "UNKNOWN_MARKET");
        require(block.timestamp > deployment.createdAt + validationTimeout, "NOT_EXPIRED");
        Types.MarketState current = Market(deployment.market).state();
        require(current == Types.MarketState.PendingValidation || current == Types.MarketState.Bootstrapping, "NOT_REJECTABLE");
        Market(deployment.market).setState(Types.MarketState.Rejected, keccak256("VALIDATION_TIMEOUT"));
    }

    function claimCreatorBond(bytes32 id) external {
        Deployment storage deployment = deployments[id];
        require(msg.sender == deployment.creator && !deployment.bondClaimed, "NOT_CREATOR");
        Types.MarketState current = Market(deployment.market).state();
        if (current == Types.MarketState.Active) {
            require(block.timestamp >= deployment.createdAt + bondLockPeriod, "BOND_LOCKED");
        } else {
            require(current == Types.MarketState.Rejected, "NOT_CLAIMABLE");
        }
        deployment.bondClaimed = true;
        IERC20(deployment.collateral).safeTransfer(deployment.creator, deployment.bond);
        emit CreatorBondClaimed(id, deployment.creator, deployment.bond);
    }
}
