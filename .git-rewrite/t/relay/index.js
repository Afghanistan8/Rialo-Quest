const express = require("express");
const cors = require("cors");
require("dotenv").config({ path: "../frontend/.env.local" });

const { createWalletClient, http, parseAbi } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { baseSepolia } = require("viem/chains");

const app = express();
app.use(cors());
app.use(express.json());

const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT;
const ALCHEMY_URL = process.env.NEXT_PUBLIC_ALCHEMY_URL;

const QUEST_MANAGER_ABI = parseAbi([
    "function completeQuestAsRelayer(address player, string calldata questId) external",
]);

async function verifyDeployOnBase(playerAddress) {
    try {
        const response = await fetch(ALCHEMY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: 1, jsonrpc: "2.0",
                method: "alchemy_getAssetTransfers",
                params: [{ fromAddress: playerAddress, category: ["external"], withMetadata: false, excludeZeroValue: false, maxCount: "0x64", toBlock: "latest", fromBlock: "0x0" }]
            })
        });
        const data = await response.json();
        const transfers = data?.result?.transfers || [];
        return transfers.some(tx => !tx.to || tx.to === "");
    } catch { return false; }
}

async function verifyGitHub(playerIdentifier) {
    try {
        const response = await fetch(
            `https://api.github.com/search/issues?q=author:${playerIdentifier}+type:pr+is:merged`,
            { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
        );
        const data = await response.json();
        return data.total_count > 0;
    } catch { return false; }
}

app.get("/api/complete-quest", (req, res) => {
    res.json({ status: "relay is alive" });
});

app.post("/api/complete-quest", async (req, res) => {
    try {
        const { questId, playerAddress, playerIdentifier, triggerType } = req.body;
        if (!questId || !playerAddress) return res.status(400).json({ error: "Missing fields" });

        let verified = false;
        switch (triggerType) {
            case "DeployOnBase": verified = await verifyDeployOnBase(playerAddress); break;
            case "GitHub": verified = await verifyGitHub(playerIdentifier); break;
            case "Content": verified = true; break;
            default: return res.status(400).json({ error: `Unknown type: ${triggerType}` });
        }

        if (!verified) return res.json({
            success: false, verified: false,
            message: triggerType === "DeployOnBase"
                ? "No contract deployments found for this wallet on Base Sepolia."
                : "Quest conditions not met."
        });

        const account = privateKeyToAccount(`0x${process.env.RELAYER_PRIVATE_KEY}`);
        const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(ALCHEMY_URL) });
        const txHash = await walletClient.writeContract({
            address: QUEST_MANAGER_ADDRESS,
            abi: QUEST_MANAGER_ABI,
            functionName: "completeQuestAsRelayer",
            args: [playerAddress, questId],
        });

        res.json({ success: true, verified: true, txHash, message: "Quest completed! XP and badge awarded." });
    } catch (error) {
        res.status(500).json({ error: error.message || "Internal server error" });
    }
});

app.listen(3000, () => console.log("Relay running at http://localhost:3000"));