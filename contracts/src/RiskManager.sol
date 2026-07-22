// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Types} from "./libraries/Types.sol";

contract RiskManager is AccessControl {
    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    mapping(Types.RiskTier => Types.RiskParams) private envelopes;

    event EnvelopeSet(Types.RiskTier indexed tier, Types.RiskParams params);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);
    }

    function setEnvelope(Types.RiskTier tier, Types.RiskParams calldata params)
        external
        onlyRole(RISK_ADMIN_ROLE)
    {
        _validateInternals(params);
        envelopes[tier] = params;
        emit EnvelopeSet(tier, params);
    }

    function envelope(Types.RiskTier tier) external view returns (Types.RiskParams memory) {
        return envelopes[tier];
    }

    function validate(Types.RiskTier tier, Types.RiskParams calldata candidate) external view {
        _validateInternals(candidate);
        Types.RiskParams storage limit = envelopes[tier];
        require(limit.initialMarginBps != 0, "TIER_NOT_CONFIGURED");
        require(candidate.initialMarginBps >= limit.initialMarginBps, "IM_TOO_LOW");
        require(candidate.maintenanceMarginBps >= limit.maintenanceMarginBps, "MM_TOO_LOW");
        require(candidate.maxOpenInterestWad <= limit.maxOpenInterestWad, "OI_TOO_HIGH");
        require(candidate.maxSkewWad <= limit.maxSkewWad, "SKEW_TOO_HIGH");
        require(candidate.maxPositionWad <= limit.maxPositionWad, "POSITION_TOO_HIGH");
        require(candidate.maxUtilizationBps <= limit.maxUtilizationBps, "UTIL_TOO_HIGH");
        // More skew impact is protective for an isolated counterparty vault. The
        // tier value is therefore a floor, not a ceiling. A global user-protection
        // ceiling remains in _validateInternals.
        require(candidate.maxPriceImpactBps >= limit.maxPriceImpactBps, "IMPACT_TOO_LOW");
        require(candidate.tradingFeeBps <= limit.tradingFeeBps, "FEE_TOO_HIGH");
        require(candidate.liquidationPenaltyBps <= limit.liquidationPenaltyBps, "PENALTY_TOO_HIGH");
        require(candidate.minSeedLiquidityWad >= limit.minSeedLiquidityWad, "SEED_TOO_LOW");
        require(candidate.minInsuranceWad >= limit.minInsuranceWad, "INSURANCE_TOO_LOW");
        require(candidate.minOracleLiquidityWad >= limit.minOracleLiquidityWad, "ORACLE_LIQUIDITY");
        require(candidate.minOracleHistory >= limit.minOracleHistory, "ORACLE_HISTORY");
        require(candidate.maxOracleConfidenceBps <= limit.maxOracleConfidenceBps, "ORACLE_CONFIDENCE");
        require(candidate.maxOracleDeviationBps <= limit.maxOracleDeviationBps, "ORACLE_DEVIATION");
        require(candidate.oracleMaxAge <= limit.oracleMaxAge, "ORACLE_AGE");
        require(candidate.minOracleSources >= limit.minOracleSources, "ORACLE_SOURCES");
        require(candidate.minCreatorBondWad >= limit.minCreatorBondWad, "BOND_TOO_LOW");
        require(candidate.baseSpreadBps >= limit.baseSpreadBps, "SPREAD_TOO_LOW");
        require(candidate.longPayoutStressBps >= limit.longPayoutStressBps, "LONG_STRESS_TOO_LOW");
        require(candidate.shortPayoutStressBps >= limit.shortPayoutStressBps, "SHORT_STRESS_TOO_LOW");
        require(candidate.fundingVelocityWad <= limit.fundingVelocityWad, "FUNDING_VELOCITY");
        require(
            candidate.maxFundingRatePerSecondWad <= limit.maxFundingRatePerSecondWad,
            "FUNDING_RATE"
        );
        require(candidate.maxFundingAccrualSeconds <= limit.maxFundingAccrualSeconds, "FUNDING_INTERVAL");
    }

    function _validateInternals(Types.RiskParams calldata params) private pure {
        require(params.initialMarginBps > params.maintenanceMarginBps, "MARGIN_ORDER");
        require(params.initialMarginBps <= Types.BPS, "IM_RANGE");
        require(params.maxUtilizationBps <= 9_500, "UTIL_RANGE");
        require(params.maxOpenInterestWad > 0 && params.maxSkewWad > 0 && params.maxPositionWad > 0, "CAP_ZERO");
        require(params.minSeedLiquidityWad > 0 && params.minInsuranceWad > 0, "SEED_ZERO");
        require(params.tradingFeeBps > 0 && params.tradingFeeBps <= 200, "FEE_RANGE");
        require(params.liquidationPenaltyBps > 0 && params.liquidationPenaltyBps <= 2_000, "PENALTY_RANGE");
        require(params.maxPriceImpactBps > 0 && params.maxPriceImpactBps <= 2_000, "IMPACT_RANGE");
        require(params.baseSpreadBps <= 500, "SPREAD_RANGE");
        require(params.longPayoutStressBps >= Types.BPS, "LONG_STRESS_RANGE");
        require(params.shortPayoutStressBps > 0 && params.shortPayoutStressBps <= Types.BPS, "SHORT_STRESS_RANGE");
        require(params.minCreatorBondWad > 0, "BOND_ZERO");
        require(params.fundingVelocityWad > 0 && params.maxFundingRatePerSecondWad > 0, "FUNDING_ZERO");
        require(params.maxFundingAccrualSeconds > 0 && params.maxFundingAccrualSeconds <= 1 days, "FUNDING_INTERVAL_RANGE");
        require(params.oracleMaxAge > 0 && params.minOracleHistory > 0 && params.minOracleLiquidityWad > 0, "ORACLE_ZERO");
        require(params.minOracleSources > 0 && params.minOracleSources <= 5, "SOURCE_RANGE");
    }
}
