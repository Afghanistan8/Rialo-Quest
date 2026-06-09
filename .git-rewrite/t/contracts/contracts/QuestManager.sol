// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./CharacterNFT.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract QuestManager is Ownable {

    // ─── Data Structures ──────────────────────────────────────────────────────

    // The five ways a quest can be verified
    enum TriggerType { Onchain, GitHub, Event, Content, Vouching }

    // A Quest defines what players need to do and what they get for doing it
    struct Quest {
        string      id;           // unique identifier e.g. "github-first-pr"
        string      name;         // display name e.g. "First GitHub PR"
        uint32      xpReward;     // how much XP completing this gives
        uint8       badgeType;    // 0=Event 1=GitHub 2=Content 3=Onchain 4=Vouching
        TriggerType triggerType;  // how this quest gets verified
        bool        active;       // can be paused by admin
    }

    // ─── State Variables ──────────────────────────────────────────────────────

    // Reference to the CharacterNFT contract
    CharacterNFT public characterNFT;

    // questId → Quest definition
    mapping(string => Quest) public quests;

    // List of all quest IDs (so we can loop through them)
    string[] public questIds;

    // questId → player address → has completed
    // Prevents the same player completing the same quest twice
    mapping(string => mapping(address => bool)) public completions;

    // Trusted relayers — your backend wallet signs and submits completions
    // This is the temporary layer that gets replaced by Rialo's native HTTP calls
    mapping(address => bool) public trustedRelayers;

    // Vouching: questId → player → list of addresses who vouched for them
    mapping(string => mapping(address => address[])) public vouchers;

    // ─── Events ───────────────────────────────────────────────────────────────

    event QuestCreated(string questId, string name, uint32 xpReward);
    event QuestCompleted(address indexed player, string questId, uint32 xpAwarded);
    event VouchSubmitted(address indexed voucher, address indexed player, string questId);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _characterNFT) Ownable(msg.sender) {
        characterNFT = CharacterNFT(_characterNFT);
    }

    // ─── Admin: Relayer Management ────────────────────────────────────────────

    // Add your backend wallet as a trusted relayer
    // The relayer is the only address allowed to submit verified quest completions
    function addRelayer(address relayer) external onlyOwner {
        trustedRelayers[relayer] = true;
    }

    function removeRelayer(address relayer) external onlyOwner {
        trustedRelayers[relayer] = false;
    }

    // ─── Admin: Quest Management ──────────────────────────────────────────────

    // Create a new quest — only the contract owner can do this
    function createQuest(
        string calldata id,
        string calldata name,
        uint32 xpReward,
        uint8 badgeType,
        TriggerType triggerType
    ) external onlyOwner {
        require(bytes(quests[id].id).length == 0, "Quest ID already exists");

        quests[id] = Quest({
            id:          id,
            name:        name,
            xpReward:    xpReward,
            badgeType:   badgeType,
            triggerType: triggerType,
            active:      true
        });
        questIds.push(id);

        emit QuestCreated(id, name, xpReward);
    }

    // Pause or unpause a quest
    function setQuestActive(string calldata questId, bool active) external onlyOwner {
        quests[questId].active = active;
    }

    // ─── Player Registration ──────────────────────────────────────────────────

    // Any player can register themselves
    // Creates their character NFT if they don't have one yet
    function registerPlayer() external {
        require(characterNFT.playerToken(msg.sender) == 0, "Already registered");
        characterNFT.registerPlayer(msg.sender);
    }

    // ─── Quest Completion: Relayer Path ───────────────────────────────────────
    // Used for GitHub, Event, and Content quests on Base Sepolia.
    // Your backend verifies the condition off-chain, then calls this function.
    // When we migrate to Rialo, this function gets replaced by a direct HTTP call
    // inside the contract itself — the backend relay is no longer needed.

    function completeQuestAsRelayer(
        address player,
        string calldata questId
    ) external {
        require(trustedRelayers[msg.sender], "Not a trusted relayer");
        _completeQuest(player, questId);
    }

    // ─── Quest Completion: Onchain Path ───────────────────────────────────────
    // Used for quests that can be verified directly onchain.
    // The player calls this themselves — no relayer needed.

    function completeOnchainQuest(string calldata questId) external {
        Quest storage q = quests[questId];
        require(q.active, "Quest is not active");
        require(q.triggerType == TriggerType.Onchain, "Use relayer path for this quest");
        require(!completions[questId][msg.sender], "Already completed");

        // For the "first-deploy" quest — just completing this transaction
        // proves the player is interacting with the chain
        _completeQuest(msg.sender, questId);
    }

    // ─── Quest Completion: Vouching Path ──────────────────────────────────────
    // Used when API verification isn't available.
    // Requires 3 verified community members (who already hold the badge) to vouch.

    function submitVouch(
        address player,
        string calldata questId
    ) external {
        // The person vouching must already hold this badge themselves
        require(
            characterNFT.hasBadge(msg.sender, questId),
            "You must hold this badge to vouch for others"
        );
        require(!completions[questId][player], "Player already completed this quest");

        address[] storage vs = vouchers[questId][player];

        // Make sure this address hasn't already vouched
        for (uint i = 0; i < vs.length; i++) {
            require(vs[i] != msg.sender, "You have already vouched for this player");
        }

        vs.push(msg.sender);
        emit VouchSubmitted(msg.sender, player, questId);

        // Once 3 people have vouched, automatically complete the quest
        if (vs.length >= 3) {
            _completeQuest(player, questId);
        }
    }

    // ─── Internal Completion Logic ────────────────────────────────────────────

    // All three paths above call this single internal function
    // This keeps the reward logic in one place
    function _completeQuest(address player, string memory questId) internal {
        Quest storage q = quests[questId];
        require(q.active, "Quest is not active");
        require(!completions[questId][player], "Already completed");

        // Mark as completed first (prevents re-entry attacks)
        completions[questId][player] = true;

        // Auto-register player if they haven't registered yet
        if (characterNFT.playerToken(player) == 0) {
            characterNFT.registerPlayer(player);
        }

        // Award XP and badge via the CharacterNFT contract
        characterNFT.awardQuestCompletion(
            player,
            questId,
            q.badgeType,
            q.xpReward
        );

        emit QuestCompleted(player, questId, q.xpReward);
    }

    // ─── Read Helpers ─────────────────────────────────────────────────────────

    // Returns all quests as an array — useful for the frontend
    function getAllQuests() external view returns (Quest[] memory) {
        Quest[] memory result = new Quest[](questIds.length);
        for (uint i = 0; i < questIds.length; i++) {
            result[i] = quests[questIds[i]];
        }
        return result;
    }

    // Returns how many people have vouched for a player on a specific quest
    function getVouchCount(
        string calldata questId,
        address player
    ) external view returns (uint256) {
        return vouchers[questId][player].length;
    }

    // Check if a specific player has completed a specific quest
    function hasCompleted(
        string calldata questId,
        address player
    ) external view returns (bool) {
        return completions[questId][player];
    }
}