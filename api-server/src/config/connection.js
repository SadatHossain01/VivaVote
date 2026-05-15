/*
 * connection.js — Hyperledger Fabric Gateway Connection
 *
 * This module sets up the gRPC connection to a Fabric peer and returns
 * a Gateway + contract references.  Only used when USE_FABRIC=true.
 *
 * It reads crypto materials from the test-network directory:
 *   fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/
 */

"use strict";

const grpc = require("@grpc/grpc-js");
const { connect, signers } = require("@hyperledger/fabric-gateway");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Path to the test-network crypto materials. Resolve symlinks only when a real
// Fabric connection is requested so mock-mode tooling does not fail on import.
const FABRIC_SAMPLES_PATH =
  process.env.FABRIC_SAMPLES_PATH ||
  path.resolve(__dirname, "..", "..", "..", "fabric-samples");

const CHANNEL_NAME = process.env.CHANNEL_NAME || "mychannel";
const ORG1_MSP = "Org1MSP";

function getOrgPath() {
  if (!fs.existsSync(FABRIC_SAMPLES_PATH)) {
    throw new Error(
      `Fabric samples directory not found at ${FABRIC_SAMPLES_PATH}. ` +
        "Start the Fabric network first or set FABRIC_SAMPLES_PATH.",
    );
  }

  const resolvedFabricSamplesPath = fs.realpathSync(FABRIC_SAMPLES_PATH);
  return path.join(
    FABRIC_SAMPLES_PATH,
    "test-network",
    "organizations",
    "peerOrganizations",
    "org1.example.com",
  );
}

/**
 * Connect to the Fabric Gateway and return contract references.
 *
 * @returns {{ gateway, vivavoteContract, baselineContract, close }}
 */
async function connectToFabric() {
  const orgPath = getOrgPath();

  // 1. Load TLS certificate for the peer
  const tlsCertPath = path.join(
    orgPath,
    "peers",
    "peer0.org1.example.com",
    "tls",
    "ca.crt",
  );
  const tlsCert = fs.readFileSync(tlsCertPath);

  // 2. Load user identity (certificate)
  const certDir = path.join(
    orgPath,
    "users",
    "User1@org1.example.com",
    "msp",
    "signcerts",
  );
  const certFiles = fs.readdirSync(certDir);
  const certificate = fs.readFileSync(path.join(certDir, certFiles[0]));

  // 3. Load user private key
  const keyDir = path.join(
    orgPath,
    "users",
    "User1@org1.example.com",
    "msp",
    "keystore",
  );
  const keyFiles = fs.readdirSync(keyDir);
  const privateKeyPem = fs.readFileSync(path.join(keyDir, keyFiles[0]));

  // 4. Create gRPC connection with TLS
  const tlsCredentials = grpc.credentials.createSsl(tlsCert);
  const client = new grpc.Client("localhost:7051", tlsCredentials, {
    "grpc.ssl_target_name_override": "peer0.org1.example.com",
  });

  // 5. Create identity and signer
  const identity = { mspId: ORG1_MSP, credentials: certificate };
  const signer = signers.newPrivateKeySigner(
    crypto.createPrivateKey(privateKeyPem),
  );

  // 6. Connect to the gateway
  const gateway = connect({ client, identity, signer });
  const network = gateway.getNetwork(CHANNEL_NAME);

  // 7. Get contract references
  const vivavoteContract = network.getContract("vivavote");
  const baselineContract = network.getContract("baseline");

  console.log("✅ Connected to Hyperledger Fabric gateway");

  return {
    gateway,
    vivavoteContract,
    baselineContract,
    close: () => {
      gateway.close();
      client.close();
    },
  };
}

module.exports = { connectToFabric };
