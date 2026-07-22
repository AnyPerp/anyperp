// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Types} from "./libraries/Types.sol";

interface IMarketStateView {
    function state() external view returns (Types.MarketState);
}

contract LiquidityVault is ERC20 {
    using SafeERC20 for IERC20;

    struct WithdrawalRequest {
        address owner;
        uint256 shares;
        uint256 executableAt;
        bool executed;
    }

    IERC20 public immutable asset;
    address public immutable factory;
    address public market;
    uint256 public immutable withdrawalDelay;
    uint256 public reservedAssets;
    uint256 public nextRequestId = 1;
    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;

    event Deposited(address indexed account, uint256 assets, uint256 shares);
    event WithdrawalRequested(uint256 indexed requestId, address indexed account, uint256 shares);
    event WithdrawalExecuted(uint256 indexed requestId, uint256 assets);

    constructor(address asset_, uint256 withdrawalDelay_, address factory_)
        ERC20("AnyPerp Isolated LP", "apLP")
    {
        require(asset_.code.length > 0 && factory_ != address(0), "CONFIG");
        asset = IERC20(asset_);
        factory = factory_;
        withdrawalDelay = withdrawalDelay_;
    }

    function setMarket(address market_) external {
        require(msg.sender == factory && market == address(0), "NOT_FACTORY");
        market = market_;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function freeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > reservedAssets ? assets - reservedAssets : 0;
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + 1e6, totalAssets() + 1);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + 1, totalSupply() + 1e6);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        return _depositFrom(msg.sender, assets, receiver);
    }

    function depositFor(address from, uint256 assets, address receiver) external returns (uint256 shares) {
        require(msg.sender == factory || msg.sender == market, "NOT_AUTHORIZED");
        return _depositFrom(from, assets, receiver);
    }

    function _depositFrom(address from, uint256 assets, address receiver) private returns (uint256 shares) {
        require(assets > 0, "ZERO_ASSETS");
        require(market != address(0), "MARKET_UNSET");
        Types.MarketState current = IMarketStateView(market).state();
        require(
            current == Types.MarketState.Bootstrapping || current == Types.MarketState.Active
                || current == Types.MarketState.ReduceOnly,
            "DEPOSIT_DISABLED"
        );
        shares = previewDeposit(assets);
        require(shares > 0, "ZERO_SHARES");
        uint256 beforeBalance = totalAssets();
        asset.safeTransferFrom(from, address(this), assets);
        require(totalAssets() - beforeBalance == assets, "UNSUPPORTED_TRANSFER");
        _mint(receiver, shares);
        emit Deposited(receiver, assets, shares);
    }

    function requestWithdraw(uint256 shares) external returns (uint256 requestId) {
        require(shares > 0, "ZERO_SHARES");
        _transfer(msg.sender, address(this), shares);
        requestId = nextRequestId++;
        withdrawalRequests[requestId] = WithdrawalRequest({
            owner: msg.sender,
            shares: shares,
            executableAt: block.timestamp + withdrawalDelay,
            executed: false
        });
        emit WithdrawalRequested(requestId, msg.sender, shares);
    }

    function executeWithdraw(uint256 requestId) external returns (uint256 assets) {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        require(request.owner != address(0) && !request.executed, "BAD_REQUEST");
        require(block.timestamp >= request.executableAt, "DELAY");
        assets = previewRedeem(request.shares);
        require(totalAssets() >= reservedAssets + assets, "RESERVED");
        request.executed = true;
        _burn(address(this), request.shares);
        asset.safeTransfer(request.owner, assets);
        emit WithdrawalExecuted(requestId, assets);
    }

    function setReservedAssets(uint256 amount) external {
        require(msg.sender == market, "NOT_MARKET");
        reservedAssets = amount;
    }

    function payFreeUpTo(address to, uint256 amount) external returns (uint256 paid) {
        require(msg.sender == market, "NOT_MARKET");
        paid = Math.min(amount, freeAssets());
        if (paid > 0) asset.safeTransfer(to, paid);
    }

    /// @notice Pays a recognized senior liability, including from reserved assets.
    /// The market must update the reserve before calling this function so a
    /// risk-reducing close releases only the reserve that its closed exposure used.
    function payUpTo(address to, uint256 amount) external returns (uint256 paid) {
        require(msg.sender == market, "NOT_MARKET");
        paid = Math.min(amount, totalAssets());
        if (paid > 0) asset.safeTransfer(to, paid);
    }
}
