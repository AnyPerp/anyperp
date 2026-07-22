// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ITriggerMarket {
    function executeTradeFor(address account, int256 sizeDelta, uint256 limitPrice, uint256 deadline) external;
    function indexPrice() external view returns (uint256);
}

contract TriggerOrderManager {
    enum TriggerType { Limit, Stop }

    struct Order {
        address account;
        address market;
        int256 sizeDelta;
        uint256 triggerPrice;
        uint256 acceptablePrice;
        uint256 deadline;
        uint256 executionFee;
        TriggerType triggerType;
        bool active;
    }

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    event OrderPlaced(uint256 indexed orderId, address indexed account, address indexed market);
    event OrderCancelled(uint256 indexed orderId);
    event OrderExecuted(uint256 indexed orderId, address indexed executor);

    function placeTriggerOrder(
        address market,
        int256 sizeDelta,
        uint256 triggerPrice,
        uint256 acceptablePrice,
        uint256 deadline,
        TriggerType triggerType
    ) external payable returns (uint256 orderId) {
        require(market.code.length > 0 && sizeDelta != 0, "ORDER");
        require(deadline > block.timestamp && msg.value > 0, "EXECUTION_FEE");
        orderId = nextOrderId++;
        orders[orderId] = Order({
            account: msg.sender,
            market: market,
            sizeDelta: sizeDelta,
            triggerPrice: triggerPrice,
            acceptablePrice: acceptablePrice,
            deadline: deadline,
            executionFee: msg.value,
            triggerType: triggerType,
            active: true
        });
        emit OrderPlaced(orderId, msg.sender, market);
    }

    function cancelTriggerOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(order.active && order.account == msg.sender, "NOT_OWNER");
        order.active = false;
        uint256 refund = order.executionFee;
        order.executionFee = 0;
        (bool success,) = payable(msg.sender).call{value: refund}("");
        require(success, "REFUND_FAILED");
        emit OrderCancelled(orderId);
    }

    function executeTriggerOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(order.active && block.timestamp <= order.deadline, "INACTIVE");
        uint256 indexPrice = ITriggerMarket(order.market).indexPrice();
        bool condition = order.triggerType == TriggerType.Limit
            ? (order.sizeDelta > 0 ? indexPrice <= order.triggerPrice : indexPrice >= order.triggerPrice)
            : (order.sizeDelta > 0 ? indexPrice >= order.triggerPrice : indexPrice <= order.triggerPrice);
        require(condition, "NOT_TRIGGERED");
        order.active = false;
        ITriggerMarket(order.market).executeTradeFor(
            order.account, order.sizeDelta, order.acceptablePrice, order.deadline
        );
        uint256 fee = order.executionFee;
        order.executionFee = 0;
        (bool success,) = payable(msg.sender).call{value: fee}("");
        require(success, "KEEPER_PAYMENT_FAILED");
        emit OrderExecuted(orderId, msg.sender);
    }
}
