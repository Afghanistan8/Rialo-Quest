import { ethers } from "hardhat";

async function main() {
  const QUEST_MANAGER = "0xC8E3c576c6aBC7536f7B158220e146aEE44C0725";
  const [signer] = await ethers.getSigners();

  console.log("Activating quests as:", signer.address);

  const QuestManager = await ethers.getContractAt("QuestManager", QUEST_MANAGER);

  const questIds = [
    "first-deploy",
    "discord-og",
    "github-first-pr",
    "first-irl-event",
    "thread-writer"
  ];

  for (const id of questIds) {
    try {
      const quest = await QuestManager.quests(id);
      console.log(`Quest "${id}" — currently active: ${quest.active}`);
      if (!quest.active) {
        const tx = await QuestManager.setQuestActive(id, true);
        await tx.wait();
        console.log(`  ✅ Activated. tx: ${tx.hash}`);
      } else {
        console.log(`  Already active`);
      }
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
