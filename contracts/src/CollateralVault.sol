// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CollateralVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    address public immutable factory;
    address public market;

    constructor(address asset_, address factory_) {
        require(asset_.code.length > 0 && factory_ != address(0), "CONFIG");
        asset = IERC20(asset_);
        factory = factory_;
    }

    function setMarket(address market_) external {
        require(msg.sender == factory && market == address(0), "NOT_FACTORY");
        market = market_;
    }

    function pull(address from, uint256 amount) external {
        require(msg.sender == market, "NOT_MARKET");
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        require(asset.balanceOf(address(this)) - beforeBalance == amount, "UNSUPPORTED_TRANSFER");
    }

    function pay(address to, uint256 amount) external {
        require(msg.sender == market, "NOT_MARKET");
        asset.safeTransfer(to, amount);
    }
}
