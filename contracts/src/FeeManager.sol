// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract FeeManager {
    address public immutable governance;
    address public protocolTreasury;
    uint256 public protocolShareBps = 1_000;
    uint256 public insuranceShareBps = 2_000;
    uint256 public creatorShareBps = 500;

    event FeeSharesSet(uint256 protocolBps, uint256 insuranceBps, uint256 creatorBps);

    constructor(address governance_, address treasury_) {
        governance = governance_;
        protocolTreasury = treasury_;
    }

    function setShares(uint256 protocolBps, uint256 insuranceBps, uint256 creatorBps) external {
        require(msg.sender == governance, "NOT_GOVERNANCE");
        require(protocolBps + insuranceBps + creatorBps <= 10_000, "SHARE_RANGE");
        protocolShareBps = protocolBps;
        insuranceShareBps = insuranceBps;
        creatorShareBps = creatorBps;
        emit FeeSharesSet(protocolBps, insuranceBps, creatorBps);
    }
}
