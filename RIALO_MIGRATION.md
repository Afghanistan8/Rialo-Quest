# Rialo Quest → Rialo Migration

> A technical case study demonstrating why **Rialo Quest** — currently deployed on Base Sepolia with relay-as-glue — is a textbook candidate for Rialo's "real-world blockchain" architecture, and exactly how the codebase would change if migrated.

**Author:** Emmanuel ([@Afghanistan8](https://github.com/Afghanistan8))
**Project:** [Rialo Quest — IRL Quest Engine](https://rialo-quest.vercel.app)
**Date:** May 2026
**Status:** Proposal · open for discussion

---

## TL;DR

Rialo Quest currently has **5 quests across 4 verification mechanisms**: self-signed onchain, OAuth (GitHub), code-based attendance, and admin review. To make any of these work today on Base Sepolia, I had to build a **separate Vercel relay** that:

- Calls GitHub's REST API on behalf of the contract
- Writes/reads OAuth state to Redis
- Holds a hot relayer wallet that signs `completeQuestAsRelayer(...)` transactions
- Mediates every off-chain proof before the contract even hears about it

This relay is **the entire reason Rialo exists**. It's a 6-file, ~600-line second deployment whose only job is "translate the real world into something the contract can verify." On Rialo, most of it disappears into the protocol. This document walks through the current architecture, identifies each piece that becomes obsolete, and shows the exact contract-level changes the migration would require.

---

## 1 · The current architecture (Base Sepolia)

```
                    ┌─────────────────────┐
                    │   Frontend (Vercel) │
                    │  rialo-quest.vc.app │
                    └──────────┬──────────┘
                               │
            ┌──────────────────┼─────────────────┐
            ▼                  ▼                 ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │ Wallet (OKX) │  │  Relay API   │  │ Base Sepolia │
     │              │  │ rialo-quest- │  │  RPC (read)  │
     │ self-sign    │  │   9ny7.vc    │  │              │
     │  Quest 1     │  │              │  │              │
     └──────┬───────┘  │ - github     │  └──────────────┘
            │          │ - oauth      │
            │          │ - irl-code   │
            │          │ - admin      │
            │          │ - host-events│
            │          └──┬─────┬─────┘
            │             │     │
            │             ▼     ▼
            │     ┌─────────┐ ┌──────────┐
            │     │  Redis  │ │  GitHub  │
            │     │(Upstash)│ │   API    │
            │     └─────────┘ └──────────┘
            │             │
            └─────────────┼────────┐
                          ▼        ▼
                 ┌──────────────────────┐
                 │    QuestManager.sol  │
                 │   (Base Sepolia)     │
                 │ 0xC8E3...44C0725     │
                 └──────────────────────┘
```

### Files that exist purely to bridge real world ↔ contract

| File | Lines | Purpose | Survives on Rialo? |
|------|------:|---------|-------------------|
| `relay-vercel/api/complete-quest.js` | 240 | Validates IRL codes from Redis, queues manual reviews, calls relayer | **Mostly gone** |
| `relay-vercel/api/github-auth.js` | 60 | Initiates OAuth, stores state in Redis | **Gone** |
| `relay-vercel/api/github-callback.js` | 220 | Exchanges OAuth code, queries GitHub API, mints onchain | **Gone** |
| `relay-vercel/api/admin-approve.js` | 165 | Authenticates admin, mints approved submissions | **Slimmer** (no minting, just status flag) |
| `relay-vercel/api/create-event.js` | 110 | Generates codes, writes to Redis | **Optional** (could move into contract) |
| `relay-vercel/api/list-events.js` | 90 | Reads events from Redis | **Gone** (read directly from contract) |
| `contracts/QuestManager.sol` | ~180 | The actual quest logic | **Stays** (minus relayer pattern) |

That's **~885 lines of "glue" code**, plus a hot wallet, plus a Redis instance, plus an OAuth client secret, plus `ADMIN_SECRET` — all to do what should be one HTTPS call from inside the contract.

### Trust assumptions today

To trust that "@Afghanistan8 has a Rialo repo on GitHub," a user must trust:

1. The frontend correctly initiates OAuth with my client_id
2. The relay's `RELAYER_PRIVATE_KEY` hasn't leaked
3. The relay's GitHub query logic isn't lying about what it found
4. Vercel hasn't been compromised
5. Upstash Redis hasn't been tampered with
6. The relayer wallet has enough Base Sepolia ETH to pay gas

**Six trust assumptions for one badge.** None of them are crypto-native.

---

## 2 · What Rialo eliminates

Per Rialo's [public materials](https://www.rialo.io/posts/introducing-rialo), the protocol introduces native primitives that collapse this entire stack:

> *"Real World Data: Pull live data anywhere with a one-liner HTTPS call in your smart contract."*
> *"Real World Programmability: Welcome Future/Promise/.await, event-driven logic [...] to smart contracts."*
> *"Real World Usability: Bring back familiar experiences such as [...] social logins."*

Mapping each Rialo capability to a piece of Rialo Quest's current relay:

| Current relay function | Rialo native primitive | Net change |
|------------------------|------------------------|-----------|
| `github-callback.js` calls `api.github.com/user` and `/search/issues` | `http.get()` directly inside the contract | **Delete file**, move logic into Solidity-equivalent |
| `github-auth.js` stores OAuth state in Redis | Native social login → wallet binding at protocol level | **Delete file** |
| `RELAYER_PRIVATE_KEY` signs gasless txs | Sponsored gas / built-in meta-tx primitives | **Delete env var** |
| `create-event.js` generates codes, stores in Redis | Contract storage + onchain RNG | **Move into contract** |
| `complete-quest.js` queues manual review in Redis | `submission` struct in contract storage with admin role | **Move into contract** |
| Admin approval mints onchain | Admin role in contract directly approves | **Same logic, no relay** |

The relay disappears. Redis disappears. The hot relayer wallet disappears. **What remains is one contract.**

---

## 3 · The migration, file by file

Below is what each piece of the codebase looks like today vs. what it could become on Rialo. Note: Rialo's exact SDK is not yet publicly documented at time of writing (project is in private DevNet), so the Rialo-side syntax below is **illustrative**, based on what their public posts describe — one-line HTTPS, async/await primitives, native social login. The real syntax may differ; the architectural shape will not.

### 3.1 GitHub Builder verification

#### Today (Base Sepolia + Vercel relay)

**Frontend:** redirects to `/api/github-auth?wallet=0x...`

**Relay (`github-auth.js`):**
```js
const state = crypto.randomBytes(16).toString('hex');
await redis.set(`oauth-state:${state}`, wallet.toLowerCase(), { EX: 600 });
res.redirect(githubAuthUrl + `&state=${state}`);
```

**Relay (`github-callback.js`):** ~150 lines that:
1. Read wallet from Redis using `state` param
2. Exchange code for access token (HTTPS POST to `github.com/login/oauth/access_token`)
3. Fetch profile (HTTPS GET to `api.github.com/user`)
4. Multi-criteria check: merged PRs, Rialo repo, public repo with 5+ commits
5. Call `contract.completeQuestAsRelayer(wallet, "github-first-pr")` from a hot wallet

**Contract:** trusts the relayer because the relayer holds `RELAYER_ROLE`.

#### On Rialo (illustrative)

```solidity
// Pseudocode using Rialo's described primitives
contract QuestManager {

    function verifyGitHubBuilder(string calldata oauthCode) external async {
        address player = msg.sender;
        require(!completed["github-first-pr"][player], "Already completed");

        // 1. Exchange OAuth code for token — ONE LINE, native HTTPS
        bytes memory tokenResp = await http.post(
            "https://github.com/login/oauth/access_token",
            abi.encode(CLIENT_ID, env.secret("GITHUB_CLIENT_SECRET"), oauthCode)
        );
        string memory accessToken = parseJson(tokenResp, "access_token");

        // 2. Query user profile
        bytes memory userResp = await http.get(
            "https://api.github.com/user",
            headers("Authorization", string.concat("Bearer ", accessToken))
        );
        string memory username = parseJson(userResp, "login");

        // 3. Multi-criteria check (PRs OR Rialo repo OR public repo)
        bool qualifies = await checkBuilderCriteria(username, accessToken);
        require(qualifies, "Not a builder yet");

        // 4. Mint — same wallet, no relayer, no separate transaction
        completed["github-first-pr"][player] = true;
        emit QuestCompleted(player, "github-first-pr", 200);
    }
}
```

**What changes**:

- **Relay deleted.** No more `github-auth.js`, no more `github-callback.js`, no more Redis OAuth state.
- **No hot wallet.** The contract makes its own HTTPS call. There's no relayer holding a private key on a Vercel server.
- **One transaction, not two.** Today: user clicks → OAuth round-trip → relay mints (separate tx the user can't see in their wallet history as their own action). On Rialo: user signs once, contract verifies and mints in the same execution.
- **The OAuth client secret stops being a Vercel env var** — it's stored in the Rialo protocol's secret manager, not a JS process the relayer team can read.

### 3.2 IRL event codes

#### Today

**Host creates event** → `create-event.js` (relay) generates codes via `crypto.randomBytes`, stores each as `event-code:{code}` in Redis.

**Attendee submits code** → `complete-quest.js` reads Redis, marks the code used, increments `event.claimsCount`, then mints via the relayer.

#### On Rialo

The codes can live entirely in contract storage with onchain RNG. Pseudocode:

```solidity
struct Event {
    string name;
    string location;
    address host;
    uint256 codeCount;
    uint256 claimsCount;
}

mapping(string => Event) public events;
mapping(bytes32 => string) public codeToEventId; // hash(code) → eventId
mapping(bytes32 => bool) public codeUsed;

function createEvent(
    string calldata name,
    string calldata location,
    uint256 codeCount
) external returns (string memory eventId, bytes32[] memory codeHashes) {
    eventId = generateEventId();
    events[eventId] = Event(name, location, msg.sender, codeCount, 0);

    codeHashes = new bytes32[](codeCount);
    for (uint i = 0; i < codeCount; i++) {
        // Native onchain randomness (per Rialo's "Real World Programmability")
        bytes32 codeHash = keccak256(abi.encode(rand.bytes32(), eventId, i));
        codeToEventId[codeHash] = eventId;
        codeHashes[i] = codeHash;
    }
    // Host receives hashes, generates display codes off-chain
    return (eventId, codeHashes);
}

function claimEventCode(string calldata code) external {
    bytes32 codeHash = keccak256(abi.encode(code));
    string memory eventId = codeToEventId[codeHash];
    require(bytes(eventId).length > 0, "Invalid code");
    require(!codeUsed[codeHash], "Already used");

    codeUsed[codeHash] = true;
    events[eventId].claimsCount++;
    completed["first-irl-event"][msg.sender] = true;
    emit QuestCompleted(msg.sender, "first-irl-event", 350);
}
```

**What changes**:

- **Redis deleted.** The 30 MB Upstash instance currently storing all codes/events/submissions is no longer needed. State is contract storage.
- **`list-events.js` deleted.** The frontend reads directly from contract via `events(eventId)` and emitted events.
- **Better trust model.** Today, the host trusts that I (the developer running Vercel + Redis) won't tamper with their codes. On Rialo, codes are committed to chain by their creator — only the host (or an attendee with a valid pre-image) can alter state.
- **Free side benefit:** code state is now part of the chain's reorg/finality guarantees. No "Redis crashed and we lost half the codes" scenario.

### 3.3 Manual admin review (Discord OG, Thread Writer)

#### Today

`complete-quest.js` saves submission to Redis sorted set `pending-submissions`. Admin opens `/admin.html`, enters `ADMIN_SECRET`, lists submissions via `admin-approve.js`, clicks "Approve" → relay mints via `completeQuestAsRelayer`.

#### On Rialo

The admin role lives in the contract. Approval is a regular transaction signed by the admin wallet — **no separate API**, no shared secret, no Redis queue.

```solidity
struct Submission {
    address user;
    string questId;
    string proof;
    uint256 submittedAt;
    SubmissionStatus status;
    address reviewedBy;
}

mapping(uint256 => Submission) public submissions;
uint256 public submissionCount;

bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

function submitForReview(string calldata questId, string calldata proof) external {
    submissions[++submissionCount] = Submission(
        msg.sender, questId, proof, block.timestamp, SubmissionStatus.Pending, address(0)
    );
    emit SubmissionCreated(submissionCount, msg.sender, questId);
}

function reviewSubmission(uint256 id, bool approve) external onlyRole(ADMIN_ROLE) {
    Submission storage s = submissions[id];
    require(s.status == SubmissionStatus.Pending, "Already reviewed");
    s.status = approve ? SubmissionStatus.Approved : SubmissionStatus.Rejected;
    s.reviewedBy = msg.sender;

    if (approve) {
        completed[s.questId][s.user] = true;
        emit QuestCompleted(s.user, s.questId, questXP[s.questId]);
    }
}
```

**What changes**:

- **`admin-approve.js` mostly deleted.** The frontend talks to the contract directly: `submissions(id)` to read, `reviewSubmission(id, approve)` to act.
- **`ADMIN_SECRET` deleted.** Authorization is "do you hold the wallet with `ADMIN_ROLE`?" Granted, transferable, revocable onchain — same as any role-based access in OpenZeppelin.
- **Audit trail.** Every approval/rejection is a transaction with a block number and signer address. Today's audit trail is "trust my Redis logs."

### 3.4 Sponsored gas / Quest 1 (Deploy on Base)

#### Today

Frontend uses `ethers.BrowserProvider` to make user sign `completeOnchainQuest("first-deploy")` themselves. They pay gas. They need testnet ETH from a faucet. This is friction.

#### On Rialo

Per Rialo's promise of "stable, predictable costs so users don't think about gas at all" — the contract can sponsor gas at the protocol level for specific functions, removing the faucet step entirely. New users could complete Quest 1 on their first interaction without ever holding any tokens.

**What changes:** The "Need testnet ETH? Get it from Alchemy Faucet" hint in the modal disappears. Onboarding becomes one tap.

---

## 4 · The numbers

| Metric | Today | On Rialo | Change |
|--------|------:|---------:|-------:|
| Lines of relay JS | ~885 | ~50 (frontend ↔ contract proxy) | **-94%** |
| Vercel projects | 2 (frontend + relay) | 1 (frontend) | **-50%** |
| External services | Redis (Upstash), GitHub OAuth, Vercel × 2 | GitHub OAuth (only because GitHub itself doesn't speak Rialo yet) | **-67%** |
| Hot wallets | 1 (relayer with private key in Vercel env) | 0 | **-100%** |
| Env vars | 8 secrets | 1 (GITHUB_CLIENT_SECRET, in protocol secret manager) | **-87%** |
| Trust assumptions per badge | 6 (frontend, relay, OAuth, Vercel, Redis, relayer wallet) | 2 (chain finality, GitHub itself) | **-67%** |
| User signatures per onchain quest | 0 (relayer signs) or 1 (self-sign) | 1 (consistently) | **+honest UX** |
| Cold-start latency on relay | 800-2000ms (serverless wake) | 0 | **eliminated** |

---

## 5 · What I'd want from Rialo to make this real

This isn't a critique — it's a builder's wishlist based on actually having shipped the working version:

1. **A Hardhat-equivalent for Rialo** that lets me test `await http.get(...)` calls against mocked endpoints locally. Today I can't test the migrated contract without a live devnet account.

2. **Clear deterministic-execution rules for HTTPS**. If two validators query GitHub at the same instant and get different rate-limit headers, what's the consensus rule? I assume Rialo has already solved this (otherwise the "one-line HTTPS" promise breaks); I'd love to read the spec.

3. **Code examples for OAuth flows specifically.** Rialo's marketing emphasizes "social logins" but the typical OAuth flow involves redirecting the user's browser to a third party and back. Showing how that flow is reconstructed when the contract itself is the OAuth client would unblock a lot of dev migrations. (I'd happily contribute the Rialo Quest port as a public example.)

4. **A migration analyzer.** A tool that ingests a Solidity contract + adjacent JS (the kind of "frontend + relay + contract" combo I have) and outputs a Rialo skeleton with `// TODO` markers where my off-chain logic should move onchain. This isn't unique to me — every project I've seen with an oracle, indexer, or relayer would benefit.

---

## 6 · Why I'm submitting this

Rialo Quest works on Base Sepolia. It ships, all 5 quests verify, the host dashboard generates real codes, the admin console approves real submissions. **It works because I built three weeks of duct tape — exactly the kind Rialo is designed to make obsolete.**

I want to be among the first to throw that duct tape away. The migration above is not theoretical for me; it's the exact diff I'd write the day Rialo's testnet opens to public builders.

If Rialo is interested, I'd commit to:
- Porting Rialo Quest to Rialo testnet within 30 days of access
- Publishing the migration as a public reference repo (`rialo-quest-port`) with side-by-side diffs
- Writing a builder-focused blog post: *"What I deleted when I moved to Rialo"*
- Maintaining it as a live IRL quest hub for the Rialo community itself — quests for "join the Discord," "deploy your first Rialo contract," "attend a Rialo IRL meetup," etc.

The whole point of Rialo Quest, before any of this, was: **community members shouldn't need a wallet, a faucet, a Discord, a GitHub, AND a willingness to read smart contract bytecode just to prove they showed up.** That mission gets dramatically easier on a chain that talks to the real world by default.

---

## Appendix A · Current contract surface

For reference, the Base Sepolia QuestManager exposes:

```solidity
function completeOnchainQuest(string calldata questId) external;
function completeQuestAsRelayer(address player, string calldata questId) external;
function hasCompleted(string calldata questId, address player) external view returns (bool);
function setQuestActive(string calldata questId, bool active) external; // owner only
function quests(string calldata questId) external view returns (Quest memory);
```

Five quest IDs, all string-typed: `first-deploy`, `discord-og`, `github-first-pr`, `first-irl-event`, `thread-writer`.

## Appendix B · Live links

- **Frontend:** https://rialo-quest.vercel.app
- **Host Dashboard:** https://rialo-quest.vercel.app/host.html
- **Admin Console:** https://rialo-quest.vercel.app/admin.html (requires `ADMIN_SECRET`)
- **Contract:** [`0xC8E3c576c6aBC7536f7B158220e146aEE44C0725`](https://sepolia.basescan.org/address/0xC8E3c576c6aBC7536f7B158220e146aEE44C0725)
- **Repo:** https://github.com/Afghanistan8/Rialo-Quest

## Appendix C · Honest disclosures

- The Rialo-side code in §3 is **illustrative**. Rialo's actual SDK is not yet public; I've sketched the shape based on their published architectural posts. The architectural argument (relay → native primitives) does not depend on the exact syntax.
- I have not yet been granted Rialo devnet access. This document was written from public materials only.
- Rialo Quest is a personal portfolio project and is not affiliated with Rialo or Subzero Labs.
