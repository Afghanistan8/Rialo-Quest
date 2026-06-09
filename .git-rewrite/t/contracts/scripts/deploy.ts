import { ethers } from "hardhat";

async function main() {
    // Get the deployer wallet from your .env PRIVATE_KEY
    const [deployer] = await ethers.getSigners();

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Deploying IRL Quest Engine contracts...");
    console.log("Deployer wallet:", deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Wallet balance:", ethers.formatEther(balance), "ETH");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── Step 1: Deploy CharacterNFT ─────────────────────────────────────────────
    // Pass a placeholder metadata URL — you'll update this after deploying frontend
    console.log("\n[1/4] Deploying CharacterNFT...");
    const CharacterNFT = await ethers.getContractFactory("CharacterNFT");
    const characterNFT = await CharacterNFT.deploy(
        "https://placeholder.example.com"
    );
    await characterNFT.waitForDeployment();
    const characterAddr = await characterNFT.getAddress();
    console.log("✅ CharacterNFT deployed to:", characterAddr);

    // ── Step 2: Deploy QuestManager ─────────────────────────────────────────────
    console.log("\n[2/4] Deploying QuestManager...");
    const QuestManager = await ethers.getContractFactory("QuestManager");
    const questManager = await QuestManager.deploy(characterAddr);
    await questManager.waitForDeployment();
    const questManagerAddr = await questManager.getAddress();
    console.log("✅ QuestManager deployed to:", questManagerAddr);

    // ── Step 3: Wire the two contracts together ──────────────────────────────────
    // This tells CharacterNFT to only accept calls from QuestManager
    console.log("\n[3/4] Wiring contracts together...");
    const wireTx = await characterNFT.setQuestManager(questManagerAddr);
    await wireTx.wait();
    console.log("✅ QuestManager set on CharacterNFT");

    // Add your deployer wallet as a trusted relayer
    // This allows your backend to submit verified quest completions
    const relayerTx = await questManager.addRelayer(deployer.address);
    await relayerTx.wait();
    console.log("✅ Deployer added as trusted relayer:", deployer.address);

    // ── Step 4: Create the 5 MVP quests ─────────────────────────────────────────
    console.log("\n[4/4] Creating starter quests...");

    const quests = [
        {
            id: "first-deploy",
            name: "Deploy on Base",
            xp: 150,
            badgeType: 3,   // Onchain
            triggerType: 0,   // TriggerType.Onchain
        },
        {
            id: "discord-og",
            name: "Discord OG",
            xp: 100,
            badgeType: 4,   // Vouching
            triggerType: 4,   // TriggerType.Vouching
        },
        {
            id: "github-first-pr",
            name: "First GitHub PR",
            xp: 200,
            badgeType: 1,   // GitHub
            triggerType: 1,   // TriggerType.GitHub
        },
        {
            id: "first-irl-event",
            name: "Show Up IRL",
            xp: 350,
            badgeType: 0,   // Event
            triggerType: 2,   // TriggerType.Event
        },
        {
            id: "thread-writer",
            name: "Thread Writer",
            xp: 175,
            badgeType: 2,   // Content
            triggerType: 3,   // TriggerType.Content
        },
    ];

    for (const q of quests) {
        const tx = await questManager.createQuest(
            q.id,
            q.name,
            q.xp,
            q.badgeType,
            q.triggerType
        );
        await tx.wait();
        console.log(`✅ Quest created: "${q.name}" (${q.xp} XP)`);
    }

    // ── Summary ──────────────────────────────────────────────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🎉 Deployment complete!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("CharacterNFT: ", characterAddr);
    console.log("QuestManager: ", questManagerAddr);
    console.log("\n📋 Copy these into your frontend/.env.local:");
    console.log(`NEXT_PUBLIC_CHARACTER_CONTRACT=${characterAddr}`);
    console.log(`NEXT_PUBLIC_QUEST_MANAGER_CONTRACT=${questManagerAddr}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});