// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSD
 * @notice A 6-decimal stablecoin stand-in (like USDC) used as the settlement
 *         currency on local and test networks. Every USD figure in the UI maps
 *         1:1 to this token: `$2,000.00` is `2_000_000000` units.
 *
 *         `faucet()` hands any caller a fixed amount so a MetaMask account can
 *         fund its LandVest wallet without a bank rail. Remove it (or swap the
 *         whole contract for real USDC) before a production deployment.
 */
contract MockUSD is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 10_000 * 1e6;

    event Faucet(address indexed to, uint256 amount);

    constructor(address owner) ERC20("LandVest Test USD", "tUSD") Ownable(owner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Demo-only: mint 10,000 tUSD to the caller.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
        emit Faucet(msg.sender, FAUCET_AMOUNT);
    }
}
