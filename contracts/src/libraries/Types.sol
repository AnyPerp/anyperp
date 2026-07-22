// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

library Types {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    enum MarketState {
        Draft,
        PendingValidation,
        Bootstrapping,
        Active,
        ReduceOnly,
        Paused,
        Settling,
        Closed,
        Rejected
    }

    enum RiskTier {
        BlueChip,
        Established,
        Emerging,
        Experimental
    }

    struct PriceData {
        uint256 priceWad;
        uint256 confidenceBps;
        uint256 updatedAt;
        uint256 liquidityWad;
        uint256 historySeconds;
        uint8 validSources;
    }

    struct RiskParams {
        uint256 initialMarginBps;
        uint256 maintenanceMarginBps;
        uint256 maxOpenInterestWad;
        uint256 maxSkewWad;
        uint256 maxPositionWad;
        uint256 maxUtilizationBps;
        uint256 maxPriceImpactBps;
        uint256 tradingFeeBps;
        uint256 liquidationPenaltyBps;
        uint256 minSeedLiquidityWad;
        uint256 minInsuranceWad;
        uint256 minOracleLiquidityWad;
        uint256 minOracleHistory;
        uint256 maxOracleConfidenceBps;
        uint256 maxOracleDeviationBps;
        uint256 oracleMaxAge;
        uint8 minOracleSources;
        // Minimum creation capital and explicit market-risk budgets. Stress values
        // are percentage moves in basis points: 90_000 means a +900% move (10x
        // terminal price), while short stress may not exceed 10_000 (-100%).
        uint256 minCreatorBondWad;
        uint256 baseSpreadBps;
        uint256 longPayoutStressBps;
        uint256 shortPayoutStressBps;
        // Quote-WAD funding controls. The accrual interval cap prevents an oracle
        // or sequencer outage from being silently charged after recovery.
        uint256 fundingVelocityWad;
        uint256 maxFundingRatePerSecondWad;
        uint256 maxFundingAccrualSeconds;
    }

    struct Position {
        int256 sizeBaseWad;
        uint256 entryPriceWad;
        uint256 marginWad;
        int256 fundingCheckpointWad;
        uint256 lastModified;
    }

    struct CreateMarketParams {
        address baseToken;
        address collateralToken;
        Types.RiskTier tier;
        Types.RiskParams risk;
        bytes32 oracleRouteId;
        uint256 creatorBond;
        bytes32 userSalt;
    }
}
