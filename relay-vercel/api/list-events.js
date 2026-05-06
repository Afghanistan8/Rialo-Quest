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
        // Use KEYS — simple, works across all redis client versions.
        // Fine for our scale (≤500 codes per event).
        let allCodeKeys = [];
        try {
          allCodeKeys = await redis.keys('event-code:*');
        } catch (e) {
          console.error('KEYS command failed:', e);
          allCodeKeys = [];
        }

        // Ensure all keys are strings (defensive)
        const keysAsStrings = allCodeKeys
          .map(k => (typeof k === 'string' ? k : String(k)))
          .filter(k => k && k.startsWith('event-code:'));

        // Fetch all code values in parallel
        const codePairs = await Promise.all(
          keysAsStrings.map(async (key) => {
            try {
              const value = await redis.get(key);
              if (!value) return null;
              const data = JSON.parse(value);
              return { code: key.replace('event-code:', ''), data };
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
