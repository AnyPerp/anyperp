// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ProtocolBackstop {
    using SafeERC20 for IERC20;
    address public immutable governance;
    mapping(address => mapping(address => uint256)) public marketAllowance;

    constructor(address governance_) {
        governance = governance_;
    }

    function allocate(address asset, address market, uint256 amount) external {
        require(msg.sender == governance, "NOT_GOVERNANCE");
        marketAllowance[asset][market] = amount;
    }

    function draw(address asset, uint256 amount, address recipient) external returns (uint256 covered) {
        uint256 allowance = marketAllowance[asset][msg.sender];
        covered = amount > allowance ? allowance : amount;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (covered > balance) covered = balance;
        marketAllowance[asset][msg.sender] = allowance - covered;
        if (covered > 0) IERC20(asset).safeTransfer(recipient, covered);
    }
}
