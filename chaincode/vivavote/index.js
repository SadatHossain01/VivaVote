/*
 * SPDX-License-Identifier: MIT
 * VivaVote Chaincode - Entry Point
 *
 * This file tells Hyperledger Fabric which smart contract classes to load.
 * Fabric calls the "start" npm script, which invokes fabric-chaincode-node,
 * and this module exports the contract(s) to register.
 */

'use strict';

const VivaVoteContract = require('./lib/vivavote');

module.exports.VivaVoteContract = VivaVoteContract;
module.exports.contracts = [VivaVoteContract];
