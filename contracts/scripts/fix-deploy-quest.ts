import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const QUEST_MANAGER = "0xC8E3c576c6aBC7536f7B158220e146aEE44C0725";
  const qm = await ethers.getContractAt("QuestManager", QUEST_MANAGER);

  console.log("Updating Deploy on Base quest...");

  const tx1 = await qm.setQuestActive("first-deploy", false);
  await tx1.wait();
  console.log("Deactivated old quest");

  const tx2 = await qm.createQuest(
    "deploy-on-base",
    "Deploy on Base",
    150,
    3,
    1
  );
  await tx2.wait();
  console.log("Created new Deploy on Base quest");

  console.log("Done!");
}

main().catch((e) => { console.error(e); process.exit(1); });