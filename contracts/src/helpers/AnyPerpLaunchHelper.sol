// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Types} from "../libraries/Types.sol";

interface IMockOracleAdapter {
    function set(address asset, Types.PriceData calldata data) external;
}

interface IOracleRouterLite {
    function createRoute(address asset, address[] calldata adapters) external returns (bytes32 routeId);
}

interface IMarketFactoryLite {
    struct CreateMarketParams {
        address baseToken;
        address collateralToken;
        Types.RiskTier tier;
        Types.RiskParams risk;
        bytes32 oracleRouteId;
        uint256 creatorBond;
        bytes32 userSalt;
    }

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

    function createMarket(CreateMarketParams calldata params) external returns (bytes32 id, address marketAddress);
    function validateMarket(bytes32 id) external;
    function seedMarket(bytes32 id, uint256 lpAssets, uint256 insuranceAssets) external;
    function activateMarket(bytes32 id) external;
    function deployments(bytes32 id) external view returns (Deployment memory);
}

/// @notice One-tx market launch for testnet UX: user approves this helper once, then calls launch().
/// Pulls bond+LP+insurance, sets mock oracles, creates route, create/validate/seed/activate.
contract AnyPerpLaunchHelper {
    using SafeERC20 for IERC20;

    event MarketLaunched(
        address indexed launcher,
        address indexed market,
        bytes32 marketId,
        address baseToken,
        address sourceHint,
        string symbol
    );

    /// @param deployMirror If true, deploys MockERC20 named `m:{sourceHint}` for Dex re-link.
    /// @param sourceHint Mainnet RH CA (or bytes20) stored in mirror name; pass baseToken=0 when deployMirror.
    function launch(
        address factory,
        address collateral,
        address oracleRouter,
        address[] calldata adapters,
        address baseToken,
        bool deployMirror,
        address sourceHint,
        string calldata symbol,
        Types.RiskParams calldata risk,
        uint8 tier,
        uint256 creatorBond,
        uint256 lpAssets,
        uint256 insuranceAssets,
        bytes32 userSalt,
        Types.PriceData calldata price
    ) external returns (bytes32 marketId, address market, address usedBase) {
        require(factory != address(0) && collateral != address(0), "BAD_ADDR");
        require(adapters.length >= 1, "NO_ADAPTERS");
        require(creatorBond > 0 && lpAssets > 0, "BAD_AMOUNTS");

        usedBase = baseToken;
        if (deployMirror) {
            require(usedBase == address(0), "BASE_SET");
            // name encodes source for off-chain Dex keepers: m:0x…
            string memory name_ = string.concat("m:", _toHex(sourceHint));
            usedBase = address(new MockERC20(name_, symbol, 18));
        } else {
            require(usedBase != address(0) && usedBase.code.length > 0, "BASE_REQUIRED");
        }

        uint256 total = creatorBond + lpAssets + insuranceAssets;
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), total);

        // Fresh mock price for this base (testnet)
        for (uint256 i; i < adapters.length; ++i) {
            IMockOracleAdapter(adapters[i]).set(usedBase, price);
        }

        bytes32 routeId;
        try IOracleRouterLite(oracleRouter).createRoute(usedBase, adapters) returns (bytes32 id) {
            routeId = id;
        } catch {
            // ROUTE_EXISTS — deterministic id matches OracleRouter
            routeId = keccak256(abi.encode(block.chainid, usedBase, adapters));
        }

        IERC20(collateral).forceApprove(factory, creatorBond);

        IMarketFactoryLite.CreateMarketParams memory params = IMarketFactoryLite.CreateMarketParams({
            baseToken: usedBase,
            collateralToken: collateral,
            tier: Types.RiskTier(tier),
            risk: risk,
            oracleRouteId: routeId,
            creatorBond: creatorBond,
            userSalt: userSalt
        });

        (marketId, market) = IMarketFactoryLite(factory).createMarket(params);
        IMarketFactoryLite(factory).validateMarket(marketId);

        IMarketFactoryLite.Deployment memory dep = IMarketFactoryLite(factory).deployments(marketId);
        IERC20(collateral).forceApprove(dep.liquidityVault, lpAssets);
        if (insuranceAssets > 0) {
            IERC20(collateral).forceApprove(dep.insuranceFund, insuranceAssets);
        }
        IMarketFactoryLite(factory).seedMarket(marketId, lpAssets, insuranceAssets);
        IMarketFactoryLite(factory).activateMarket(marketId);

        emit MarketLaunched(msg.sender, market, marketId, usedBase, sourceHint, symbol);
        return (marketId, market, usedBase);
    }

    function _toHex(address a) private pure returns (string memory) {
        bytes20 data = bytes20(a);
        bytes memory hexChars = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i; i < 20; ++i) {
            str[2 + i * 2] = hexChars[uint8(data[i] >> 4)];
            str[3 + i * 2] = hexChars[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
