// /api/list-events.js
// Returns all events owned by a host wallet.

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

    // Single event detail (with codes)
    if (eventId) {
      const eventJson = await redis.get(`event:${eventId}`);
      if (!eventJson) return res.status(404).json({ error: 'Event not found' });
      const event = JSON.parse(eventJson);

      // Optionally include codes if requesting host owns event
      let codes = null;
      if (hostAddress && hostAddress.toLowerCase() === event.hostAddress) {
        // Find all codes belonging to this event by scanning
        const codeKeys = [];
        for await (const key of redis.scanIterator({ MATCH: 'event-code:*', COUNT: 100 })) {
          codeKeys.push(key);
        }
        const codeData = await Promise.all(
          codeKeys.map(async (k) => {
            const v = await redis.get(k);
            return { code: k.replace('event-code:', ''), data: JSON.parse(v) };
          })
        );
        codes = codeData
          .filter(c => c.data.eventId === eventId)
          .map(c => ({ code: c.code, used: c.data.used, usedBy: c.data.usedBy, usedAt: c.data.usedAt }));
      }

      return res.status(200).json({ success: true, event, codes });
    }

    // List of events for a host
    if (!hostAddress || !/^0x[a-fA-F0-9]{40}$/.test(hostAddress)) {
      return res.status(400).json({ error: 'Valid hostAddress required' });
    }

    const eventIds = await redis.sMembers(`host-events:${hostAddress.toLowerCase()}`);
    const events = [];

    for (const id of eventIds) {
      const json = await redis.get(`event:${id}`);
      if (json) events.push(JSON.parse(json));
    }

    // Sort by createdAt descending
    events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ success: true, events });

  } catch (err) {
    console.error('list-events error:', err);
    return res.status(500).json({ error: err.message });
  }
};
