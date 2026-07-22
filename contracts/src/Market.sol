// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Types} from "./libraries/Types.sol";
import {FixedPointMath} from "./libraries/FixedPointMath.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {IMarket} from "./interfaces/IMarket.sol";
import {CollateralVault} from "./CollateralVault.sol";
import {LiquidityVault} from "./LiquidityVault.sol";
import {MarketInsuranceFund} from "./MarketInsuranceFund.sol";
import {FundingEngine} from "./FundingEngine.sol";
import {FeeManager} from "./FeeManager.sol";
import {ProtocolBackstop} from "./ProtocolBackstop.sol";

/// @dev Optional testnet collateral (apUSD) — public mint for float settlement.
interface ITestnetMintable {
    function mint(address to, uint256 amount) external;
}

contract Market is IMarket, ReentrancyGuard {
    using FixedPointMath for uint256;

    bytes32 public override marketId;
    address public creator;
    address public controller;
    address public governance;
    address public guardian;
    address public baseToken;
    IERC20Metadata public collateralToken;
    uint8 public collateralDecimals;
    IOracleRouter public oracleRouter;
    bytes32 public oracleRouteId;
    CollateralVault public collateralVault;
    LiquidityVault public liquidityVault;
    MarketInsuranceFund public insuranceFund;
    FundingEngine public fundingEngine;
    FeeManager public feeManager;
    ProtocolBackstop public protocolBackstop;
    Types.RiskTier public tier;
    Types.MarketState public override state;
    Types.RiskParams private _risk;

    address public liquidationEngine;
    address public triggerOrderManager;
    uint256 public longOpenInterestBaseWad;
    uint256 public shortOpenInterestBaseWad;
    int256 public cumulativeFundingPerBaseWad;
    uint256 public lastFundingTime;
    uint256 public badDebtWad;
    uint256 public unpaidFundingWad;
    uint256 public settlementPriceWad;
    uint256 public settlementStartPriceWad;
    uint256 public settlementStartedAt;
    int256 public settlementFundingIndexWad;
    uint256 public fundingPoolWad;
    mapping(address => uint256) public pendingPnlClaimsWad;
    mapping(address => uint256) public pendingFundingClaimsWad;
    mapping(address => Types.Position) private positions;
    bool private initialized;

    event MarketStateChanged(Types.MarketState indexed previous, Types.MarketState indexed next, bytes32 reason);
    event MarginDeposited(address indexed account, uint256 amountRaw, uint256 amountWad);
    event MarginWithdrawn(address indexed account, uint256 amountRaw, uint256 amountWad);
    event TradeExecuted(
        address indexed account,
        int256 sizeDeltaBaseWad,
        int256 newSizeBaseWad,
        uint256 executionPriceWad,
        int256 realizedPnlWad,
        uint256 feeWad
    );
    event FundingUpdated(int256 ratePerSecondWad, int256 cumulativeFundingPerBaseWad, uint256 elapsed);
    event FundingSkipped(uint256 elapsed, bytes32 reason);
    event Liquidated(address indexed account, address indexed liquidator, uint256 closedNotionalWad, uint256 rewardWad, uint256 badDebtWad);
    event BadDebtRecorded(uint256 amountWad, uint256 totalBadDebtWad);
    event DeferredClaimRecorded(address indexed account, uint256 pnlWad, uint256 fundingWad);
    event DeferredClaimPaid(address indexed account, uint256 amountRaw, uint256 remainingWad);

    /// @dev Locks the implementation instance. EIP-1167 clones have independent
    /// storage and start with initialized=false.
    constructor() {
        initialized = true;
    }

    function initialize(
        bytes32 marketId_,
        address creator_,
        address controller_,
        address governance_,
        address guardian_,
        address baseToken_,
        address collateralToken_,
        Types.RiskTier tier_,
        Types.RiskParams memory risk_,
        address oracleRouter_,
        bytes32 oracleRouteId_,
        address collateralVault_,
        address liquidityVault_,
        address insuranceFund_,
        address fundingEngine_,
        address feeManager_,
        address protocolBackstop_
    ) external {
        require(!initialized, "ALREADY_INITIALIZED");
        initialized = true;
        marketId = marketId_;
        creator = creator_;
        require(controller_ != address(0), "CONTROLLER");
        controller = controller_;
        governance = governance_;
        guardian = guardian_;
        baseToken = baseToken_;
        collateralToken = IERC20Metadata(collateralToken_);
        uint8 decimals = IERC20Metadata(collateralToken_).decimals();
        require(decimals <= 18, "COLLATERAL_DECIMALS");
        collateralDecimals = decimals;
        tier = tier_;
        _risk = risk_;
        oracleRouter = IOracleRouter(oracleRouter_);
        oracleRouteId = oracleRouteId_;
        collateralVault = CollateralVault(collateralVault_);
        liquidityVault = LiquidityVault(liquidityVault_);
        insuranceFund = MarketInsuranceFund(insuranceFund_);
        fundingEngine = FundingEngine(fundingEngine_);
        feeManager = FeeManager(feeManager_);
        protocolBackstop = ProtocolBackstop(protocolBackstop_);
        state = Types.MarketState.PendingValidation;
        lastFundingTime = block.timestamp;
    }

    function riskParams() external view returns (Types.RiskParams memory) {
        return _risk;
    }

    function position(address account) external view returns (Types.Position memory) {
        return positions[account];
    }

    function indexPrice() external view returns (uint256) {
        return oracleRouter.validate(oracleRouteId, _risk).priceWad;
    }

    /// @notice LP + insurance + drawable backstop. Risk-increasing trades revert LOSS_BUDGET if stress reserve exceeds this.
    function lossBudgetCapacityRaw() public view returns (uint256) {
        uint256 capacity = liquidityVault.totalAssets() + insuranceFund.balance();
        if (address(protocolBackstop) == address(0)) return capacity;
        uint256 allowance = protocolBackstop.marketAllowance(address(collateralToken), address(this));
        uint256 bal = IERC20(address(collateralToken)).balanceOf(address(protocolBackstop));
        return capacity + Math.min(allowance, bal);
    }

    function setLiquidationEngine(address engine) external {
        require((msg.sender == governance || msg.sender == controller) && engine.code.length > 0, "NOT_GOVERNANCE");
        require(liquidationEngine == address(0), "ALREADY_SET");
        liquidationEngine = engine;
    }

    function setTriggerOrderManager(address manager) external {
        require((msg.sender == governance || msg.sender == controller) && manager.code.length > 0, "NOT_GOVERNANCE");
        require(triggerOrderManager == address(0), "ALREADY_SET");
        triggerOrderManager = manager;
    }

    function setState(Types.MarketState next, bytes32 reason) external {
        require(msg.sender == controller || msg.sender == governance || msg.sender == guardian, "NOT_AUTHORIZED");
        Types.MarketState previous = state;
        if (msg.sender == guardian) {
            require(next == Types.MarketState.ReduceOnly || next == Types.MarketState.Paused, "GUARDIAN_SCOPE");
        }
        require(_validTransition(previous, next), "INVALID_TRANSITION");
        state = next;
        if (next == Types.MarketState.Settling) {
            Types.PriceData memory data = oracleRouter.validate(oracleRouteId, _risk);
            _updateFunding(data.priceWad);
            settlementStartPriceWad = data.priceWad;
            settlementFundingIndexWad = cumulativeFundingPerBaseWad;
            settlementStartedAt = block.timestamp;
        }
        emit MarketStateChanged(previous, next, reason);
    }

    function beginSettlement(bytes32 reason) external {
        require(msg.sender == governance || msg.sender == controller, "NOT_GOVERNANCE");
        Types.MarketState previous = state;
        require(
            previous == Types.MarketState.Active || previous == Types.MarketState.ReduceOnly
                || previous == Types.MarketState.Paused,
            "INVALID_TRANSITION"
        );
        Types.PriceData memory data = oracleRouter.validate(oracleRouteId, _risk);
        _updateFunding(data.priceWad);
        state = Types.MarketState.Settling;
        settlementStartPriceWad = data.priceWad;
        settlementFundingIndexWad = cumulativeFundingPerBaseWad;
        settlementStartedAt = block.timestamp;
        emit MarketStateChanged(previous, state, reason);
    }

    function finalizeSettlement() external {
        require(msg.sender == governance || msg.sender == controller, "NOT_GOVERNANCE");
        require(state == Types.MarketState.Settling && block.timestamp >= settlementStartedAt + 1 days, "DISPUTE_WINDOW");
        Types.PriceData memory data = oracleRouter.validate(oracleRouteId, _risk);
        settlementPriceWad = Math.average(settlementStartPriceWad, data.priceWad);
        Types.MarketState previous = state;
        state = Types.MarketState.Closed;
        emit MarketStateChanged(previous, state, keccak256("SETTLEMENT_FINALIZED"));
    }

    function claimSettlement() external nonReentrant {
        require(state == Types.MarketState.Closed && settlementPriceWad > 0, "NOT_FINALIZED");
        Types.Position storage p = positions[msg.sender];
        int256 oldSize = p.sizeBaseWad;
        require(oldSize != 0, "NO_POSITION");
        _settleFunding(msg.sender, p);
        uint256 closeBase = FixedPointMath.abs(oldSize);
        int256 realizedPnl = int256(closeBase) * (int256(settlementPriceWad) - int256(p.entryPriceWad)) / int256(1e18);
        if (oldSize < 0) realizedPnl = -realizedPnl;
        (uint256 projectedLong, uint256 projectedShort) = _projectOpenInterest(oldSize, 0);
        liquidityVault.setReservedAssets(_requiredReserveRaw(projectedLong, projectedShort, settlementPriceWad));
        _applyPnl(msg.sender, p, realizedPnl);
        p.sizeBaseWad = 0;
        p.entryPriceWad = 0;
        _updateOpenInterest(oldSize, 0);
        _refreshReserve(settlementPriceWad);
        emit TradeExecuted(msg.sender, -oldSize, 0, settlementPriceWad, realizedPnl, 0);
    }

    function depositMargin(uint256 amount) external nonReentrant {
        require(state != Types.MarketState.Closed && state != Types.MarketState.Rejected, "MARKET_ENDED");
        uint256 wad = _toWad(amount);
        require(wad > 0, "DUST");
        collateralVault.pull(msg.sender, amount);
        positions[msg.sender].marginWad += wad;
        emit MarginDeposited(msg.sender, amount, wad);
    }

    function withdrawMargin(uint256 amount) external nonReentrant {
        require(state != Types.MarketState.Paused, "PAUSED");
        Types.Position storage p = positions[msg.sender];
        uint256 wad = _toWad(amount);
        require(p.marginWad >= wad, "INSUFFICIENT_MARGIN");
        uint256 price;
        if (p.sizeBaseWad != 0) {
            Types.PriceData memory data = oracleRouter.validate(oracleRouteId, _risk);
            price = data.priceWad;
            _updateFunding(price);
        }
        _settleFunding(msg.sender, p);
        p.marginWad -= wad;
        if (p.sizeBaseWad != 0) require(_isInitialMarginSafe(p, price), "INITIAL_MARGIN");
        collateralVault.pay(msg.sender, amount);
        if (price > 0) _refreshReserve(price);
        emit MarginWithdrawn(msg.sender, amount, wad);
    }

    function executeTrade(int256 sizeDelta, uint256 limitPrice, uint256 deadline) external nonReentrant {
        _executeTrade(msg.sender, sizeDelta, limitPrice, deadline);
    }

    function executeTradeFor(address account, int256 sizeDelta, uint256 limitPrice, uint256 deadline)
        external
        nonReentrant
    {
        require(msg.sender == triggerOrderManager, "NOT_TRIGGER_MANAGER");
        _executeTrade(account, sizeDelta, limitPrice, deadline);
    }

    function _executeTrade(address account, int256 sizeDelta, uint256 limitPrice, uint256 deadline) private {
        require(block.timestamp <= deadline, "DEADLINE");
        require(state == Types.MarketState.Active || state == Types.MarketState.ReduceOnly, "NOT_TRADABLE");
        require(sizeDelta != 0, "ZERO_SIZE");
        Types.Position storage p = positions[account];
        if (state == Types.MarketState.ReduceOnly) {
            require(p.sizeBaseWad != 0 && !FixedPointMath.sameSign(p.sizeBaseWad, sizeDelta), "REDUCE_ONLY");
            require(FixedPointMath.abs(sizeDelta) <= FixedPointMath.abs(p.sizeBaseWad), "NO_FLIP");
        }
        Types.PriceData memory priceData = oracleRouter.validate(oracleRouteId, _risk);
        _updateFunding(priceData.priceWad);
        _settleFunding(account, p);
        uint256 executionPrice = _executionPrice(priceData.priceWad, sizeDelta);
        if (sizeDelta > 0) require(executionPrice <= limitPrice, "PRICE_ABOVE_LIMIT");
        else require(executionPrice >= limitPrice, "PRICE_BELOW_LIMIT");

        int256 oldSize = p.sizeBaseWad;
        uint256 oldAbs = FixedPointMath.abs(oldSize);
        int256 newSize = oldSize + sizeDelta;
        uint256 newAbs = FixedPointMath.abs(newSize);
        (uint256 projectedLong, uint256 projectedShort) = _projectOpenInterest(oldSize, newSize);
        _checkCaps(priceData.priceWad, newSize, projectedLong, projectedShort);
        uint256 projectedReserve = _requiredReserveRaw(projectedLong, projectedShort, priceData.priceWad);
        if (newAbs > oldAbs || !FixedPointMath.sameSign(oldSize, newSize)) {
            uint256 utilizationLimit = Math.mulDiv(
                liquidityVault.totalAssets(), _risk.maxUtilizationBps, Types.BPS
            );
            require(projectedReserve <= utilizationLimit, "UTILIZATION_CAP");
            require(projectedReserve <= lossBudgetCapacityRaw(), "LOSS_BUDGET");
        }
        // Release the reserve consumed by the part being closed before paying
        // realized PnL. Any unpaid amount becomes an explicit deferred claim.
        liquidityVault.setReservedAssets(projectedReserve);
        int256 realizedPnl;

        if (oldSize == 0 || FixedPointMath.sameSign(oldSize, sizeDelta)) {
            uint256 weightedOld = oldAbs * p.entryPriceWad;
            uint256 weightedNew = FixedPointMath.abs(sizeDelta) * executionPrice;
            p.entryPriceWad = (weightedOld + weightedNew) / newAbs;
        } else {
            uint256 closeBase = Math.min(oldAbs, FixedPointMath.abs(sizeDelta));
            realizedPnl = int256(closeBase) * (int256(executionPrice) - int256(p.entryPriceWad)) / int256(1e18);
            if (oldSize < 0) realizedPnl = -realizedPnl;
            _applyPnl(account, p, realizedPnl);
            if (newSize == 0) p.entryPriceWad = 0;
            else if (!FixedPointMath.sameSign(oldSize, newSize)) p.entryPriceWad = executionPrice;
        }

        uint256 quotedFeeWad = Math.mulDiv(FixedPointMath.abs(sizeDelta), executionPrice, 1e18);
        quotedFeeWad = Math.mulDiv(quotedFeeWad, _risk.tradingFeeBps, Types.BPS, Math.Rounding.Ceil);
        uint256 feeWad = _chargeFee(p, quotedFeeWad);
        p.sizeBaseWad = newSize;
        p.fundingCheckpointWad = cumulativeFundingPerBaseWad;
        p.lastModified = block.timestamp;
        _updateOpenInterest(oldSize, newSize);
        if (newAbs > oldAbs || !FixedPointMath.sameSign(oldSize, newSize)) {
            require(_isInitialMarginSafe(p, priceData.priceWad), "INITIAL_MARGIN");
        }
        _refreshReserve(priceData.priceWad);
        emit TradeExecuted(account, sizeDelta, newSize, executionPrice, realizedPnl, feeWad);
    }

    function updateFunding() external {
        require(state == Types.MarketState.Active || state == Types.MarketState.ReduceOnly, "NOT_ACTIVE");
        try oracleRouter.validate(oracleRouteId, _risk) returns (Types.PriceData memory data) {
            _updateFunding(data.priceWad);
        } catch {
            uint256 elapsed = block.timestamp - lastFundingTime;
            lastFundingTime = block.timestamp;
            emit FundingSkipped(elapsed, keccak256("INVALID_ORACLE_INTERVAL"));
        }
    }

    function accountEquityWad(address account) public view returns (int256) {
        Types.Position storage p = positions[account];
        if (p.sizeBaseWad == 0) return int256(p.marginWad);
        Types.PriceData memory priceData = oracleRouter.getPrice(oracleRouteId);
        int256 pnl = p.sizeBaseWad * (int256(priceData.priceWad) - int256(p.entryPriceWad)) / int256(1e18);
        int256 funding = p.sizeBaseWad * (cumulativeFundingPerBaseWad - p.fundingCheckpointWad) / int256(1e18);
        return int256(p.marginWad) + pnl - funding;
    }

    /// @notice Claims payout that could not be paid synchronously without
    /// consuming reserves belonging to still-open positions. Claims remain
    /// market-local and never debit another market.
    function claimDeferredPayout() external nonReentrant returns (uint256 paidRaw) {
        uint256 fundingClaim = pendingFundingClaimsWad[msg.sender];
        if (fundingClaim > 0 && fundingPoolWad > 0) {
            uint256 available = Math.min(fundingClaim, fundingPoolWad);
            uint256 fundingRaw = liquidityVault.payUpTo(msg.sender, _fromWadDown(available));
            uint256 fundingPaidWad = _toWad(fundingRaw);
            pendingFundingClaimsWad[msg.sender] -= fundingPaidWad;
            fundingPoolWad -= fundingPaidWad;
            paidRaw += fundingRaw;
        }

        uint256 pnlClaim = pendingPnlClaimsWad[msg.sender];
        if (pnlClaim > 0) {
            uint256 requestedRaw = _fromWadDown(pnlClaim);
            uint256 pnlRaw = liquidityVault.payFreeUpTo(msg.sender, requestedRaw);
            uint256 remainingRaw = requestedRaw - pnlRaw;
            if (remainingRaw > 0) {
                uint256 insurancePaid = insuranceFund.cover(msg.sender, remainingRaw);
                pnlRaw += insurancePaid;
                remainingRaw -= insurancePaid;
            }
            if (remainingRaw > 0 && address(protocolBackstop) != address(0)) {
                pnlRaw += protocolBackstop.draw(address(collateralToken), remainingRaw, msg.sender);
                remainingRaw = requestedRaw > pnlRaw ? requestedRaw - pnlRaw : 0;
            }
            // Testnet: mint float into vault then pay claim so trader is not stuck
            if (remainingRaw > 0) {
                uint256 minted = _mintCollateralIntoVault(remainingRaw);
                if (minted > 0) {
                    uint256 extra = liquidityVault.payFreeUpTo(msg.sender, remainingRaw);
                    pnlRaw += extra;
                    remainingRaw = requestedRaw > pnlRaw ? requestedRaw - pnlRaw : 0;
                }
            }
            uint256 pnlPaidWad = _toWad(pnlRaw);
            pendingPnlClaimsWad[msg.sender] -= pnlPaidWad;
            paidRaw += pnlRaw;
        }
        require(paidRaw > 0, "NOTHING_PAYABLE");
        uint256 remaining = pendingPnlClaimsWad[msg.sender] + pendingFundingClaimsWad[msg.sender];
        try oracleRouter.getPrice(oracleRouteId) returns (Types.PriceData memory data) {
            _refreshReserve(data.priceWad);
        } catch { }
        emit DeferredClaimPaid(msg.sender, paidRaw, remaining);
    }

    function liquidateFromEngine(address account, uint256 maxCloseNotionalWad, address liquidator)
        external
        nonReentrant
        returns (uint256 closedNotionalWad, uint256 rewardWad, uint256 newBadDebtWad)
    {
        require(msg.sender == liquidationEngine, "NOT_ENGINE");
        require(state == Types.MarketState.Active || state == Types.MarketState.ReduceOnly, "NOT_LIQUIDATABLE");
        Types.Position storage p = positions[account];
        require(p.sizeBaseWad != 0, "NO_POSITION");
        Types.PriceData memory priceData = oracleRouter.validate(oracleRouteId, _risk);
        _updateFunding(priceData.priceWad);
        _settleFunding(account, p);
        uint256 notional = Math.mulDiv(FixedPointMath.abs(p.sizeBaseWad), priceData.priceWad, 1e18);
        int256 equity = _equityAt(p, priceData.priceWad);
        uint256 maintenance = Math.mulDiv(notional, _risk.maintenanceMarginBps, Types.BPS, Math.Rounding.Ceil);
        require(equity < int256(maintenance), "HEALTHY");

        closedNotionalWad = Math.min(maxCloseNotionalWad, notional);
        if (equity <= 0 || closedNotionalWad == 0) closedNotionalWad = notional;
        uint256 closeBase = Math.mulDiv(FixedPointMath.abs(p.sizeBaseWad), closedNotionalWad, notional, Math.Rounding.Ceil);
        int256 delta = p.sizeBaseWad > 0 ? -int256(closeBase) : int256(closeBase);
        int256 oldSize = p.sizeBaseWad;
        int256 newSize = oldSize + delta;
        (uint256 projectedLong, uint256 projectedShort) = _projectOpenInterest(oldSize, newSize);
        liquidityVault.setReservedAssets(_requiredReserveRaw(projectedLong, projectedShort, priceData.priceWad));
        int256 realizedPnl = int256(closeBase) * (int256(priceData.priceWad) - int256(p.entryPriceWad)) / int256(1e18);
        if (oldSize < 0) realizedPnl = -realizedPnl;
        _applyPnl(account, p, realizedPnl);
        rewardWad = Math.mulDiv(closedNotionalWad, _risk.liquidationPenaltyBps, Types.BPS);
        if (rewardWad > p.marginWad) rewardWad = p.marginWad;
        uint256 rewardRaw = _fromWadDown(rewardWad);
        rewardWad = _toWad(rewardRaw);
        p.marginWad -= rewardWad;
        if (rewardRaw > 0) collateralVault.pay(liquidator, rewardRaw);
        p.sizeBaseWad = newSize;
        if (p.sizeBaseWad == 0) p.entryPriceWad = 0;
        p.lastModified = block.timestamp;
        _updateOpenInterest(oldSize, p.sizeBaseWad);
        int256 remainingEquity = _equityAt(p, priceData.priceWad);
        if (p.sizeBaseWad != 0 && remainingEquity >= 0) {
            uint256 remainingNotional = Math.mulDiv(
                FixedPointMath.abs(p.sizeBaseWad), priceData.priceWad, 1e18
            );
            uint256 targetMaintenance = Math.mulDiv(
                remainingNotional,
                _risk.maintenanceMarginBps * 11,
                Types.BPS * 10,
                Math.Rounding.Ceil
            );
            require(remainingEquity >= int256(targetMaintenance), "PARTIAL_STILL_UNHEALTHY");
        }
        if (remainingEquity < 0) {
            newBadDebtWad = uint256(-remainingEquity);
            p.marginWad = 0;
            badDebtWad += newBadDebtWad;
            emit BadDebtRecorded(newBadDebtWad, badDebtWad);
        }
        _refreshReserve(priceData.priceWad);
        emit Liquidated(account, liquidator, closedNotionalWad, rewardWad, newBadDebtWad);
    }

    function _executionPrice(uint256 indexPriceWad, int256 sizeDelta) private view returns (uint256) {
        int256 preSkew = int256(longOpenInterestBaseWad) - int256(shortOpenInterestBaseWad);
        int256 postSkew = preSkew + sizeDelta;
        int256 averageSkew = (preSkew + postSkew) / 2;
        int256 impactBps = averageSkew * int256(_risk.maxPriceImpactBps) / int256(_risk.maxSkewWad);
        int256 cap = int256(_risk.maxPriceImpactBps);
        if (impactBps > cap) impactBps = cap;
        if (impactBps < -cap) impactBps = -cap;
        impactBps += sizeDelta > 0 ? int256(_risk.baseSpreadBps) : -int256(_risk.baseSpreadBps);
        int256 adjusted = int256(indexPriceWad) * (int256(Types.BPS) + impactBps) / int256(Types.BPS);
        require(adjusted > 0, "BAD_EXECUTION_PRICE");
        return uint256(adjusted);
    }

    function _updateFunding(uint256 validPriceWad) private {
        uint256 totalElapsed = block.timestamp - lastFundingTime;
        if (totalElapsed == 0) return;
        uint256 elapsed = Math.min(totalElapsed, _risk.maxFundingAccrualSeconds);
        if (totalElapsed > elapsed) {
            emit FundingSkipped(totalElapsed - elapsed, keccak256("ACCRUAL_INTERVAL_CAPPED"));
        }
        int256 skew = int256(longOpenInterestBaseWad) - int256(shortOpenInterestBaseWad);
        int256 rate = fundingEngine.computeRate(
            validPriceWad,
            skew,
            _risk.maxSkewWad,
            _risk.fundingVelocityWad,
            _risk.maxFundingRatePerSecondWad
        );
        cumulativeFundingPerBaseWad += rate * int256(elapsed);
        lastFundingTime = block.timestamp;
        emit FundingUpdated(rate, cumulativeFundingPerBaseWad, elapsed);
    }

    function _settleFunding(address account, Types.Position storage p) private {
        if (p.sizeBaseWad == 0) {
            p.fundingCheckpointWad = cumulativeFundingPerBaseWad;
            return;
        }
        int256 payment = p.sizeBaseWad * (cumulativeFundingPerBaseWad - p.fundingCheckpointWad) / int256(1e18);
        p.fundingCheckpointWad = cumulativeFundingPerBaseWad;
        if (payment > 0) {
            uint256 owed = uint256(payment);
            uint256 payableWad = Math.min(owed, p.marginWad);
            uint256 paidRaw = Math.min(_fromWadUp(payableWad), _fromWadDown(p.marginWad));
            uint256 paidWad = _toWad(paidRaw);
            p.marginWad -= paidWad;
            if (paidRaw > 0) collateralVault.pay(address(liquidityVault), paidRaw);
            fundingPoolWad += paidWad;
            if (paidWad < owed) unpaidFundingWad += owed - paidWad;
        } else if (payment < 0) {
            uint256 credit = uint256(-payment);
            uint256 available = Math.min(credit, fundingPoolWad);
            uint256 requestedRaw = _fromWadDown(available);
            uint256 paidRaw = liquidityVault.payUpTo(address(collateralVault), requestedRaw);
            uint256 paidWad = _toWad(paidRaw);
            p.marginWad += paidWad;
            fundingPoolWad -= paidWad;
            if (paidWad < credit) {
                pendingFundingClaimsWad[account] += credit - paidWad;
                emit DeferredClaimRecorded(account, 0, credit - paidWad);
            }
        }
    }

    /// @dev Testnet apUSD is mintable. If the vault / insurance / backstop cannot
    /// cover trader profit, mint collateral into the LP vault and pay through so
    /// the trader is settled immediately. Protocol rebalances inventory later.
    function _mintCollateralIntoVault(uint256 amountRaw) private returns (uint256 minted) {
        if (amountRaw == 0) return 0;
        try ITestnetMintable(address(collateralToken)).mint(address(liquidityVault), amountRaw) {
            return amountRaw;
        } catch {
            return 0;
        }
    }

    function _applyPnl(address account, Types.Position storage p, int256 pnl) private {
        if (pnl >= 0) {
            uint256 profit = uint256(pnl);
            uint256 requestedRaw = _fromWadDown(profit);
            uint256 paidRaw = liquidityVault.payFreeUpTo(address(collateralVault), requestedRaw);
            uint256 remainingRaw = requestedRaw - paidRaw;
            if (remainingRaw > 0) {
                uint256 insurancePaid = insuranceFund.cover(address(collateralVault), remainingRaw);
                paidRaw += insurancePaid;
                remainingRaw -= insurancePaid;
            }
            if (remainingRaw > 0 && address(protocolBackstop) != address(0)) {
                paidRaw += protocolBackstop.draw(
                    address(collateralToken), remainingRaw, address(collateralVault)
                );
                remainingRaw = requestedRaw - paidRaw;
            }
            // Testnet float: mint apUSD into LP vault when protocol inventory is short
            if (remainingRaw > 0) {
                uint256 minted = _mintCollateralIntoVault(remainingRaw);
                if (minted > 0) {
                    uint256 extra = liquidityVault.payFreeUpTo(address(collateralVault), remainingRaw);
                    paidRaw += extra;
                    remainingRaw = requestedRaw > paidRaw ? requestedRaw - paidRaw : 0;
                }
            }
            uint256 paidWad = _toWad(paidRaw);
            p.marginWad += paidWad;
            if (paidWad < profit) {
                pendingPnlClaimsWad[account] += profit - paidWad;
                emit DeferredClaimRecorded(account, profit - paidWad, 0);
            }
        } else {
            uint256 loss = uint256(-pnl);
            uint256 collectibleWad = Math.min(loss, p.marginWad);
            uint256 paidRaw = _fromWadDown(collectibleWad);
            uint256 paidWad = _toWad(paidRaw);
            p.marginWad -= paidWad;
            if (paidRaw > 0) collateralVault.pay(address(liquidityVault), paidRaw);
            uint256 shortfall = loss - paidWad;
            if (shortfall > 0) {
                uint256 coveredRaw = insuranceFund.cover(address(liquidityVault), _fromWadDown(shortfall));
                uint256 coveredWad = _toWad(coveredRaw);
                if (shortfall > coveredWad) {
                    badDebtWad += shortfall - coveredWad;
                    emit BadDebtRecorded(shortfall - coveredWad, badDebtWad);
                }
            }
        }
    }

    function _chargeFee(Types.Position storage p, uint256 quotedFeeWad) private returns (uint256 chargedWad) {
        uint256 raw = _fromWadUp(quotedFeeWad);
        chargedWad = _toWad(raw);
        require(p.marginWad >= chargedWad, "FEE_EXCEEDS_MARGIN");
        p.marginWad -= chargedWad;
        uint256 insuranceRaw = Math.mulDiv(raw, feeManager.insuranceShareBps(), Types.BPS);
        uint256 protocolRaw = Math.mulDiv(raw, feeManager.protocolShareBps(), Types.BPS);
        uint256 creatorRaw = Math.mulDiv(raw, feeManager.creatorShareBps(), Types.BPS);
        uint256 lpRaw = raw - insuranceRaw - protocolRaw - creatorRaw;
        if (insuranceRaw > 0) collateralVault.pay(address(insuranceFund), insuranceRaw);
        if (protocolRaw > 0) collateralVault.pay(feeManager.protocolTreasury(), protocolRaw);
        if (creatorRaw > 0) collateralVault.pay(creator, creatorRaw);
        if (lpRaw > 0) collateralVault.pay(address(liquidityVault), lpRaw);
    }

    function _updateOpenInterest(int256 oldSize, int256 newSize) private {
        if (oldSize > 0) longOpenInterestBaseWad -= uint256(oldSize);
        else if (oldSize < 0) shortOpenInterestBaseWad -= uint256(-oldSize);
        if (newSize > 0) longOpenInterestBaseWad += uint256(newSize);
        else if (newSize < 0) shortOpenInterestBaseWad += uint256(-newSize);
    }

    function _checkCaps(uint256 price, int256 positionSize, uint256 projectedLong, uint256 projectedShort)
        private
        view
    {
        uint256 totalBase = projectedLong + projectedShort;
        uint256 totalNotional = Math.mulDiv(totalBase, price, 1e18);
        require(totalNotional <= _risk.maxOpenInterestWad, "OI_CAP");
        uint256 skew = projectedLong > projectedShort
            ? projectedLong - projectedShort
            : projectedShort - projectedLong;
        require(skew <= _risk.maxSkewWad, "SKEW_CAP");
        uint256 positionNotional = Math.mulDiv(FixedPointMath.abs(positionSize), price, 1e18);
        require(positionNotional <= _risk.maxPositionWad, "POSITION_CAP");
    }

    function _isInitialMarginSafe(Types.Position storage p, uint256 price) private view returns (bool) {
        if (p.sizeBaseWad == 0) return true;
        uint256 notional = Math.mulDiv(FixedPointMath.abs(p.sizeBaseWad), price, 1e18);
        int256 equity = _equityAt(p, price);
        return equity >= int256(Math.mulDiv(notional, _risk.initialMarginBps, Types.BPS, Math.Rounding.Ceil));
    }

    function _refreshReserve(uint256 price) private {
        uint256 required = _requiredReserveRaw(longOpenInterestBaseWad, shortOpenInterestBaseWad, price);
        liquidityVault.setReservedAssets(required);
        uint256 limit = Math.mulDiv(liquidityVault.totalAssets(), _risk.maxUtilizationBps, Types.BPS);
        if (required > limit && state == Types.MarketState.Active) {
            Types.MarketState previous = state;
            state = Types.MarketState.ReduceOnly;
            emit MarketStateChanged(previous, state, keccak256("UTILIZATION_AUTO_REDUCE_ONLY"));
        }
    }

    function _requiredReserveRaw(uint256 longBase, uint256 shortBase, uint256 price)
        private
        view
        returns (uint256)
    {
        uint256 longNotional = Math.mulDiv(longBase, price, 1e18);
        uint256 shortNotional = Math.mulDiv(shortBase, price, 1e18);
        uint256 longStressLoss = Math.mulDiv(longNotional, _risk.longPayoutStressBps, Types.BPS);
        uint256 shortStressLoss = Math.mulDiv(shortNotional, _risk.shortPayoutStressBps, Types.BPS);
        uint256 riskReserveWad = Math.max(longStressLoss, shortStressLoss);
        return _fromWadUp(riskReserveWad + fundingPoolWad);
    }

    function _projectOpenInterest(int256 oldSize, int256 newSize)
        private
        view
        returns (uint256 projectedLong, uint256 projectedShort)
    {
        projectedLong = longOpenInterestBaseWad;
        projectedShort = shortOpenInterestBaseWad;
        if (oldSize > 0) projectedLong -= uint256(oldSize);
        else if (oldSize < 0) projectedShort -= uint256(-oldSize);
        if (newSize > 0) projectedLong += uint256(newSize);
        else if (newSize < 0) projectedShort += uint256(-newSize);
    }

    function _equityAt(Types.Position storage p, uint256 price) private view returns (int256) {
        if (p.sizeBaseWad == 0) return int256(p.marginWad);
        int256 pnl = p.sizeBaseWad * (int256(price) - int256(p.entryPriceWad)) / int256(1e18);
        int256 funding = p.sizeBaseWad * (cumulativeFundingPerBaseWad - p.fundingCheckpointWad) / int256(1e18);
        return int256(p.marginWad) + pnl - funding;
    }

    function _toWad(uint256 raw) private view returns (uint256) {
        return raw * (10 ** (18 - collateralDecimals));
    }

    function _fromWadDown(uint256 wad) private view returns (uint256) {
        return wad / (10 ** (18 - collateralDecimals));
    }

    function _fromWadUp(uint256 wad) private view returns (uint256) {
        uint256 scale = 10 ** (18 - collateralDecimals);
        return Math.ceilDiv(wad, scale);
    }

    function _validTransition(Types.MarketState from, Types.MarketState to) private pure returns (bool) {
        if (from == Types.MarketState.PendingValidation) {
            return to == Types.MarketState.Bootstrapping || to == Types.MarketState.Rejected;
        }
        if (from == Types.MarketState.Bootstrapping) {
            return to == Types.MarketState.Active || to == Types.MarketState.Rejected;
        }
        if (from == Types.MarketState.Active) {
            return to == Types.MarketState.ReduceOnly || to == Types.MarketState.Paused || to == Types.MarketState.Settling;
        }
        if (from == Types.MarketState.ReduceOnly) {
            return to == Types.MarketState.Active || to == Types.MarketState.Paused || to == Types.MarketState.Settling;
        }
        if (from == Types.MarketState.Paused) {
            return to == Types.MarketState.ReduceOnly || to == Types.MarketState.Settling;
        }
        if (from == Types.MarketState.Settling) return to == Types.MarketState.Closed;
        return false;
    }
}
