// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Types} from "./libraries/Types.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {LiquidityVault} from "./LiquidityVault.sol";
import {MarketInsuranceFund} from "./MarketInsuranceFund.sol";
import {ProtocolBackstop} from "./ProtocolBackstop.sol";

/// @notice Read-only solvency lens. Kept off Market so the EIP-1167 implementation stays under EIP-170.
interface IMarketSolvencyView {
    function liquidityVault() external view returns (address);
    function insuranceFund() external view returns (address);
    function protocolBackstop() external view returns (address);
    function collateralToken() external view returns (address);
    function oracleRouter() external view returns (address);
    function oracleRouteId() external view returns (bytes32);
    function riskParams() external view returns (Types.RiskParams memory);
    function longOpenInterestBaseWad() external view returns (uint256);
    function shortOpenInterestBaseWad() external view returns (uint256);
    function fundingPoolWad() external view returns (uint256);
    function lossBudgetCapacityRaw() external view returns (uint256);
    function badDebtWad() external view returns (uint256);
}

contract MarketLens {
    function solvencySnapshot(address market)
        external
        view
        returns (
            uint256 totalLpRaw,
            uint256 freeLpRaw,
            uint256 reservedLpRaw,
            uint256 insuranceRaw,
            uint256 backstopRaw,
            uint256 lossBudgetCapacity,
            uint256 requiredReserveRaw,
            uint256 utilizationLimitRaw,
            uint256 longOiBaseWad,
            uint256 shortOiBaseWad,
            uint256 indexPriceWad,
            uint256 maxAdditionalLongBaseWad,
            uint256 maxAdditionalShortBaseWad
        )
    {
        IMarketSolvencyView m = IMarketSolvencyView(market);
        LiquidityVault vault = LiquidityVault(m.liquidityVault());
        totalLpRaw = vault.totalAssets();
        freeLpRaw = vault.freeAssets();
        reservedLpRaw = vault.reservedAssets();
        insuranceRaw = MarketInsuranceFund(m.insuranceFund()).balance();
        address backstop = m.protocolBackstop();
        address collateral = m.collateralToken();
        if (backstop != address(0)) {
            uint256 allowance = ProtocolBackstop(backstop).marketAllowance(collateral, market);
            backstopRaw = Math.min(allowance, IERC20(collateral).balanceOf(backstop));
        }
        lossBudgetCapacity = m.lossBudgetCapacityRaw();
        Types.RiskParams memory risk = m.riskParams();
        longOiBaseWad = m.longOpenInterestBaseWad();
        shortOiBaseWad = m.shortOpenInterestBaseWad();
        indexPriceWad = IOracleRouter(m.oracleRouter()).getPrice(m.oracleRouteId()).priceWad;
        requiredReserveRaw = _requiredReserveRaw(risk, longOiBaseWad, shortOiBaseWad, indexPriceWad, m.fundingPoolWad());
        utilizationLimitRaw = Math.mulDiv(totalLpRaw, risk.maxUtilizationBps, Types.BPS);
        uint256 capRaw = Math.min(lossBudgetCapacity, utilizationLimitRaw);
        maxAdditionalLongBaseWad = _maxAdditionalBase(
            true, risk, longOiBaseWad, shortOiBaseWad, indexPriceWad, capRaw, m.fundingPoolWad()
        );
        maxAdditionalShortBaseWad = _maxAdditionalBase(
            false, risk, longOiBaseWad, shortOiBaseWad, indexPriceWad, capRaw, m.fundingPoolWad()
        );
    }

    function _requiredReserveRaw(
        Types.RiskParams memory risk,
        uint256 longBase,
        uint256 shortBase,
        uint256 price,
        uint256 fundingPoolWad
    ) private pure returns (uint256) {
        uint256 longNotional = Math.mulDiv(longBase, price, 1e18);
        uint256 shortNotional = Math.mulDiv(shortBase, price, 1e18);
        uint256 longStress = Math.mulDiv(longNotional, risk.longPayoutStressBps, Types.BPS);
        uint256 shortStress = Math.mulDiv(shortNotional, risk.shortPayoutStressBps, Types.BPS);
        uint256 riskWad = Math.max(longStress, shortStress) + fundingPoolWad;
        // WAD→raw assumes 6-decimal collateral for lens display; market uses exact decimals on write path.
        return Math.ceilDiv(riskWad, 1e12);
    }

    function _maxAdditionalBase(
        bool forLong,
        Types.RiskParams memory risk,
        uint256 longOi,
        uint256 shortOi,
        uint256 priceWad,
        uint256 capRaw,
        uint256 fundingPoolWad
    ) private pure returns (uint256) {
        if (priceWad == 0 || capRaw == 0) return 0;
        uint256 stressBps = forLong ? risk.longPayoutStressBps : risk.shortPayoutStressBps;
        if (stressBps == 0) return 0;
        uint256 fundingRaw = Math.ceilDiv(fundingPoolWad, 1e12);
        if (capRaw <= fundingRaw) return 0;
        uint256 riskCapWad = (capRaw - fundingRaw) * 1e12;
        uint256 maxSideBase = Math.mulDiv(Math.mulDiv(riskCapWad, Types.BPS, stressBps), 1e18, priceWad);
        uint256 currentSide = forLong ? longOi : shortOi;
        if (maxSideBase <= currentSide) return 0;
        uint256 limit = maxSideBase - currentSide;
        uint256 other = forLong ? shortOi : longOi;
        uint256 bySkew = other + risk.maxSkewWad > currentSide ? other + risk.maxSkewWad - currentSide : 0;
        if (bySkew < limit) limit = bySkew;
        uint256 byPos = Math.mulDiv(risk.maxPositionWad, 1e18, priceWad);
        if (byPos < limit) limit = byPos;
        uint256 totalBase = longOi + shortOi;
        uint256 maxOiBase = Math.mulDiv(risk.maxOpenInterestWad, 1e18, priceWad);
        uint256 byOi = maxOiBase > totalBase ? maxOiBase - totalBase : 0;
        if (byOi < limit) limit = byOi;
        return limit;
    }
}
