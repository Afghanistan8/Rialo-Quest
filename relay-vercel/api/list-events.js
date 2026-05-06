// /api/list-events.js
// Returns all events owned by a host wallet, or detail of a single event.

const { createClient } = require('redis');

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isReady) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

// Scan all keys matching a pattern.
// Handles both legacy (yields strings) and v4+ (yields { cursor, keys } objects)
// shapes of scanIterator across redis client versions.
async function scanAllKeys(redis, pattern) {
  const keys = [];
  for await (const item of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
    if (typeof item === 'string') {
      keys.push(item);
    } else if (item && Array.isArray(item.keys)) {
      keys.push(...item.keys);
    } else if (item && typeof item === 'object' && 'keys' in item) {
      // defensive: in case keys is iterable but not array
      for (const k of item.keys) keys.push(k);
    }
  }
  return keys;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { hostAddress, eventId } = req.query;

  try {
    const redis = await getRedis();

    // ── Single event detail (with codes) ──
    if (eventId) {
      const eventJson = await redis.get(`event:${eventId}`);
      if (!eventJson) return res.status(404).json({ error: 'Event not found' });
      const event = JSON.parse(eventJson);

      let codes = null;
      // Only return code details if requesting host owns the event
      if (hostAddress && hostAddress.toLowerCase() === event.hostAddress) {
        const codeKeys = await scanAllKeys(redis, 'event-code:*');

        // Fetch all code entries in parallel
        const codePairs = await Promise.all(
          codeKeys.map(async (key) => {
            // Defensive: ensure key is actually a string
            const keyStr = typeof key === 'string' ? key : String(key);
            try {
              const value = await redis.get(keyStr);
              if (!value) return null;
              const data = JSON.parse(value);
              return { code: keyStr.replace('event-code:', ''), data };
            } catch (e) {
              return null;
            }
          })
        );

        codes = codePairs
          .filter(c => c && c.data && c.data.eventId === eventId)
          .map(c => ({
            code: c.code,
            used: c.data.used,
            usedBy: c.data.usedBy,
            usedAt: c.data.usedAt
          }))
          .sort((a, b) => a.code.localeCompare(b.code));
      }

      return res.status(200).json({ success: true, event, codes });
    }

    // ── List events for a host ──
    if (!hostAddress || !/^0x[a-fA-F0-9]{40}$/.test(hostAddress)) {
      return res.status(400).json({ error: 'Valid hostAddress required' });
    }

    const eventIds = await redis.sMembers(`host-events:${hostAddress.toLowerCase()}`);
    const events = [];

    for (const id of eventIds) {
      const json = await redis.get(`event:${id}`);
      if (json) events.push(JSON.parse(json));
    }

    events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ success: true, events });

  } catch (err) {
    console.error('list-events error:', err);
    return res.status(500).json({ error: err.message });
  }
};
