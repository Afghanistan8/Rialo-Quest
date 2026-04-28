// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// We import OpenZeppelin's battle-tested ERC-721 and Ownable contracts.
// Instead of writing NFT logic from scratch, we build on top of audited code.
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract CharacterNFT is ERC721, Ownable {
    using Strings for uint256;

    // ─── Data Structures ──────────────────────────────────────────────────────

    // The five classes a character can reach based on their activity type
    enum CharacterClass { Explorer, Contributor, Builder, CoreBuilder, Educator }

    // A Badge is a permanent record of a completed quest — stored inside the character
    struct Badge {
        string  questId;      // e.g. "github-first-pr"
        uint8   badgeType;    // 0=Event 1=GitHub 2=Content 3=Onchain 4=Vouching
        uint64  earnedAt;     // unix timestamp of when it was earned
        uint32  xpAwarded;    // how much XP this badge gave
    }

    // The Character is the core data attached to each NFT token
    struct Character {
        uint8          level;           // current level (1-100)
        uint32         xp;              // total XP accumulated
        CharacterClass charClass;       // current class
        uint16         streakDays;      // consecutive active days
        uint64         lastActiveDay;   // last day the character was active
        Badge[]        badges;          // all badges earned (grows over time)
    }

    // ─── State Variables ──────────────────────────────────────────────────────

    // Tracks the next token ID to mint (starts at 1)
    uint256 private _nextTokenId;

    // Base URL for metadata — your server returns character data from here
    string public baseMetadataUrl;

    // Maps token ID → Character data
    mapping(uint256 => Character) public characters;

    // Maps wallet address → token ID (one character per wallet)
    mapping(address => uint256) public playerToken;

    // Tracks which token IDs actually exist
    mapping(uint256 => bool) private _tokenExists;

    // ─── Access Control ───────────────────────────────────────────────────────

    // Only the QuestManager contract can award XP and badges
    address public questManager;

    modifier onlyQuestManager() {
        require(msg.sender == questManager, "Only QuestManager can call this");
        _;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    // Emitted when a new player registers
    event CharacterCreated(address indexed player, uint256 tokenId);

    // Emitted when a character gains a level
    event LevelUp(uint256 indexed tokenId, uint8 newLevel);

    // Emitted when a badge is earned
    event BadgeEarned(uint256 indexed tokenId, string questId, uint32 xp);

    // ─── Constructor ──────────────────────────────────────────────────────────

    // Called once when the contract is deployed
    // Sets the NFT name, symbol, and metadata server URL
    constructor(string memory _baseMetadataUrl)
        ERC721("IRL Quest Character", "IRLQC")
        Ownable(msg.sender)
    {
        baseMetadataUrl = _baseMetadataUrl;
    }

    // ─── Admin Functions ──────────────────────────────────────────────────────

    // Called after deploying QuestManager — links the two contracts together
    function setQuestManager(address _questManager) external onlyOwner {
        questManager = _questManager;
    }

    // Update the metadata URL if your server changes
    function setBaseMetadataUrl(string calldata _url) external onlyOwner {
        baseMetadataUrl = _url;
    }

    // ─── Player Registration ──────────────────────────────────────────────────

    // Creates a new character NFT for a player
    // Called by QuestManager when a new player interacts for the first time
    function registerPlayer(address player) external onlyQuestManager returns (uint256) {
        require(playerToken[player] == 0, "Player already has a character");

        // Mint the next token ID to this player
        uint256 tokenId = ++_nextTokenId;
        _safeMint(player, tokenId);
        _tokenExists[tokenId] = true;

        // Set starting stats
        Character storage c = characters[tokenId];
        c.level         = 1;
        c.xp            = 0;
        c.charClass     = CharacterClass.Explorer;
        c.streakDays    = 0;
        c.lastActiveDay = uint64(block.timestamp / 86400);

        // Record which token belongs to this player
        playerToken[player] = tokenId;

        emit CharacterCreated(player, tokenId);
        return tokenId;
    }

    // ─── Quest Completion (called by QuestManager) ────────────────────────────

    function awardQuestCompletion(
        address player,
        string calldata questId,
        uint8   badgeType,
        uint32  xpReward
    ) external onlyQuestManager {
        uint256 tokenId = playerToken[player];
        require(_tokenExists[tokenId], "Character not found");

        Character storage c = characters[tokenId];

        // Add XP
        c.xp += xpReward;

        // Check if the player levelled up
        uint8 newLevel = calculateLevel(c.xp);
        if (newLevel > c.level) {
            c.level = newLevel;
            emit LevelUp(tokenId, newLevel);
        }

        // Mint a soulbound badge inside the character
        c.badges.push(Badge({
            questId:   questId,
            badgeType: badgeType,
            earnedAt:  uint64(block.timestamp),
            xpAwarded: xpReward
        }));

        // Recalculate class based on badge history
        c.charClass = calculateClass(tokenId);

        // Update the activity streak
        _updateStreak(tokenId);

        emit BadgeEarned(tokenId, questId, xpReward);
    }

    // ─── Streak Tracking ──────────────────────────────────────────────────────

    function _updateStreak(uint256 tokenId) internal {
        Character storage c = characters[tokenId];
        uint64 today = uint64(block.timestamp / 86400);
        uint64 diff  = today - c.lastActiveDay;

        if (diff == 0) return;          // already active today, no change
        if (diff == 1) {
            c.streakDays++;             // consecutive day — streak continues
        } else {
            c.streakDays = 1;           // gap in activity — streak resets
        }
        c.lastActiveDay = today;
    }

    // ─── Level Formula ────────────────────────────────────────────────────────

    // XP thresholds:
    // Levels  1-10:  100 XP each  (total 1,000 XP to reach level 10)
    // Levels 11-30:  250 XP each  (total 6,000 XP to reach level 30)
    // Levels 31-60:  500 XP each  (total 21,000 XP to reach level 60)
    // Levels 61-100: 1000 XP each (total 61,000 XP to reach level 100)
    function calculateLevel(uint32 xp) public pure returns (uint8) {
        if (xp < 1000)  return uint8(xp / 100) + 1;
        if (xp < 6000)  return uint8((xp - 1000) / 250) + 11;
        if (xp < 21000) return uint8((xp - 6000) / 500) + 31;
        uint8 level = uint8((xp - 21000) / 1000) + 61;
        return level > 100 ? 100 : level;
    }

    // ─── Class Formula ────────────────────────────────────────────────────────

    // Class is determined by what kind of badges you've earned the most
    function calculateClass(uint256 tokenId) public view returns (CharacterClass) {
        Badge[] storage badges = characters[tokenId].badges;
        uint16 github  = 0;
        uint16 events  = 0;
        uint16 content = 0;

        for (uint i = 0; i < badges.length; i++) {
            if (badges[i].badgeType == 1) github++;
            if (badges[i].badgeType == 0) events++;
            if (badges[i].badgeType == 2) content++;
        }

        if (github  >= 10) return CharacterClass.CoreBuilder;
        if (events  >= 5)  return CharacterClass.Builder;
        if (content >= 5)  return CharacterClass.Educator;
        if (github  >= 1 || events >= 1 || content >= 1)
                           return CharacterClass.Contributor;
        return CharacterClass.Explorer;
    }

    // ─── Token URI ────────────────────────────────────────────────────────────

    // Returns the metadata URL for a given token
    // Wallets and marketplaces call this to display the character
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_tokenExists[tokenId], "Token does not exist");
        return string(abi.encodePacked(
            baseMetadataUrl, "/metadata/", tokenId.toString()
        ));
    }

    // ─── Soulbound: Block All Transfers ───────────────────────────────────────

    // Characters cannot be bought or sold — they can only be earned
    // This override blocks all transfers except the initial mint
    function _update(address to, uint256 tokenId, address auth)
        internal override returns (address)
    {
        address from = _ownerOf(tokenId);
        require(
            from == address(0) || to == address(0),
            "Character NFT is soulbound and cannot be transferred"
        );
        return super._update(to, tokenId, auth);
    }

    // ─── Read Helpers ─────────────────────────────────────────────────────────

    // Returns all badges for a character
    function getBadges(uint256 tokenId) external view returns (Badge[] memory) {
        return characters[tokenId].badges;
    }

    // Checks if a player has earned a specific quest badge
    // Used by QuestManager for the vouching system
    function hasBadge(address player, string calldata questId)
        external view returns (bool)
    {
        uint256 tokenId = playerToken[player];
        if (!_tokenExists[tokenId]) return false;

        Badge[] storage badges = characters[tokenId].badges;
        for (uint i = 0; i < badges.length; i++) {
            if (keccak256(bytes(badges[i].questId)) == keccak256(bytes(questId))) {
                return true;
            }
        }
        return false;
    }
}