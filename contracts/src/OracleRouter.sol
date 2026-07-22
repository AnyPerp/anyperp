// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {Types} from "./libraries/Types.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract OracleRouter is AccessControl, IOracleRouter {
    bytes32 public constant ADAPTER_ADMIN_ROLE = keccak256("ADAPTER_ADMIN_ROLE");
    uint256 public constant MAX_ROUTE_SOURCES = 5;

    struct Route {
        address asset;
        address[] adapters;
        uint8 liquiditySources;
        bool exists;
    }

    mapping(address => bool) public enabledAdapter;
    mapping(address => bytes32) public adapterFamily;
    mapping(address => bool) public adapterIsLiquiditySource;
    mapping(bytes32 => Route) private routes;

    event AdapterStatusChanged(address indexed adapter, bool enabled, bytes32 indexed family, bool liquiditySource);
    event RouteCreated(bytes32 indexed routeId, address indexed asset, address[] adapters);

    error InvalidRoute();
    error InvalidPrice();
    error InsufficientSources(uint256 actual, uint256 required);
    error OracleDeviation(uint256 minPrice, uint256 maxPrice, uint256 medianPrice);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADAPTER_ADMIN_ROLE, admin);
    }

    function setAdapter(address adapter, bool enabled, bytes32 family, bool liquiditySource)
        external
        onlyRole(ADAPTER_ADMIN_ROLE)
    {
        require(adapter.code.length > 0, "NOT_CONTRACT");
        require(!enabled || family != bytes32(0), "FAMILY_REQUIRED");
        enabledAdapter[adapter] = enabled;
        adapterFamily[adapter] = family;
        adapterIsLiquiditySource[adapter] = liquiditySource;
        emit AdapterStatusChanged(adapter, enabled, family, liquiditySource);
    }

    function createRoute(address asset, address[] calldata adapters) external returns (bytes32 routeId) {
        require(asset.code.length > 0, "ASSET_NOT_CONTRACT");
        require(adapters.length > 0 && adapters.length <= MAX_ROUTE_SOURCES, "SOURCE_COUNT");
        uint8 liquiditySources;
        for (uint256 i; i < adapters.length; ++i) {
            require(enabledAdapter[adapters[i]], "ADAPTER_DISABLED");
            bytes32 family = adapterFamily[adapters[i]];
            require(family != bytes32(0), "FAMILY_REQUIRED");
            for (uint256 j; j < i; ++j) {
                require(adapters[i] != adapters[j], "DUPLICATE_ADAPTER");
                require(family != adapterFamily[adapters[j]], "CORRELATED_SOURCE");
            }
            if (adapterIsLiquiditySource[adapters[i]]) ++liquiditySources;
        }
        require(liquiditySources > 0, "DEX_LIQUIDITY_SOURCE_REQUIRED");
        routeId = keccak256(abi.encode(block.chainid, asset, adapters));
        require(!routes[routeId].exists, "ROUTE_EXISTS");
        Route storage routeConfig = routes[routeId];
        routeConfig.asset = asset;
        routeConfig.liquiditySources = liquiditySources;
        routeConfig.exists = true;
        for (uint256 i; i < adapters.length; ++i) routeConfig.adapters.push(adapters[i]);
        emit RouteCreated(routeId, asset, adapters);
    }

    function route(bytes32 routeId) external view returns (address asset, address[] memory adapters) {
        Route storage value = routes[routeId];
        if (!value.exists) revert InvalidRoute();
        return (value.asset, value.adapters);
    }

    function getPrice(bytes32 routeId) public view returns (Types.PriceData memory aggregate) {
        Route storage routeConfig = routes[routeId];
        if (!routeConfig.exists) revert InvalidRoute();

        Types.PriceData[MAX_ROUTE_SOURCES] memory observations;
        uint256 count;
        uint256 minimumDexLiquidity = type(uint256).max;
        for (uint256 i; i < routeConfig.adapters.length; ++i) {
            if (!enabledAdapter[routeConfig.adapters[i]]) continue;
            try IOracleAdapter(routeConfig.adapters[i]).read(routeConfig.asset) returns (
                Types.PriceData memory observation
            ) {
                if (observation.priceWad == 0 || observation.updatedAt == 0) continue;
                observations[count++] = observation;
                if (adapterIsLiquiditySource[routeConfig.adapters[i]]) {
                    minimumDexLiquidity = Math.min(minimumDexLiquidity, observation.liquidityWad);
                }
            } catch { }
        }
        if (count == 0) revert InvalidPrice();

        for (uint256 i = 1; i < count; ++i) {
            Types.PriceData memory key = observations[i];
            uint256 j = i;
            while (j > 0 && observations[j - 1].priceWad > key.priceWad) {
                observations[j] = observations[j - 1];
                --j;
            }
            observations[j] = key;
        }

        uint256 medianPrice = observations[(count - 1) / 2].priceWad;
        if (count % 2 == 0) {
            medianPrice = Math.average(observations[count / 2 - 1].priceWad, observations[count / 2].priceWad);
        }
        uint256 oldestUpdate = type(uint256).max;
        uint256 minimumHistory = type(uint256).max;
        uint256 widestConfidence;
        for (uint256 i; i < count; ++i) {
            oldestUpdate = Math.min(oldestUpdate, observations[i].updatedAt);
            minimumHistory = Math.min(minimumHistory, observations[i].historySeconds);
            widestConfidence = Math.max(widestConfidence, observations[i].confidenceBps);
        }
        aggregate = Types.PriceData({
            priceWad: medianPrice,
            confidenceBps: widestConfidence,
            updatedAt: oldestUpdate,
            liquidityWad: minimumDexLiquidity,
            historySeconds: minimumHistory,
            validSources: uint8(count)
        });
    }

    function validate(bytes32 routeId, Types.RiskParams calldata risk)
        external
        view
        returns (Types.PriceData memory data)
    {
        data = getPrice(routeId);
        if (data.validSources < risk.minOracleSources) {
            revert InsufficientSources(data.validSources, risk.minOracleSources);
        }
        require(block.timestamp >= data.updatedAt && block.timestamp - data.updatedAt <= risk.oracleMaxAge, "STALE");
        require(data.confidenceBps <= risk.maxOracleConfidenceBps, "LOW_CONFIDENCE");
        require(data.liquidityWad >= risk.minOracleLiquidityWad, "LOW_LIQUIDITY");
        require(data.historySeconds >= risk.minOracleHistory, "SHORT_HISTORY");

        Route storage routeConfig = routes[routeId];
        uint256 minPrice = type(uint256).max;
        uint256 maxPrice;
        for (uint256 i; i < routeConfig.adapters.length; ++i) {
            if (!enabledAdapter[routeConfig.adapters[i]]) continue;
            try IOracleAdapter(routeConfig.adapters[i]).read(routeConfig.asset) returns (
                Types.PriceData memory observation
            ) {
                if (observation.priceWad == 0 || observation.updatedAt == 0) continue;
                minPrice = Math.min(minPrice, observation.priceWad);
                maxPrice = Math.max(maxPrice, observation.priceWad);
            } catch { }
        }
        uint256 deviation = Math.mulDiv(maxPrice - minPrice, Types.BPS, data.priceWad);
        if (deviation > risk.maxOracleDeviationBps) {
            revert OracleDeviation(minPrice, maxPrice, data.priceWad);
        }
    }
}
