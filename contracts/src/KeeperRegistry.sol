// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract KeeperRegistry {
    mapping(address => string) public metadataUri;
    mapping(address => bool) public active;
    event KeeperRegistered(address indexed keeper, string metadataUri);
    event KeeperStatusChanged(address indexed keeper, bool active);

    function register(string calldata uri) external {
        require(bytes(uri).length <= 256, "URI_TOO_LONG");
        metadataUri[msg.sender] = uri;
        active[msg.sender] = true;
        emit KeeperRegistered(msg.sender, uri);
    }

    function setActive(bool value) external {
        require(bytes(metadataUri[msg.sender]).length > 0, "NOT_REGISTERED");
        active[msg.sender] = value;
        emit KeeperStatusChanged(msg.sender, value);
    }
}
