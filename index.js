const express = require('express');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());


// ========== TIKTOK VIEW FETCHER (with cache bypass) ==========
const tiktokCache = new Map();          // video_id -> { data, timestamp }
const lastRequestTime = new Map();      // video_id -> timestamp
const CACHE_DURATION = 100 * 1000;      // 100 seconds (in ms)
const MIN_REQUEST_INTERVAL = 1 * 1000;  // 3 seconds between requests to same video
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function resolveUrl(url) {
  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 10000
    });
    return response.request.res.responseUrl || url;
  } catch {
    return url;
  }
}

function extractVideoId(url) {
  const match = url.match(/\/video\/(\d{18,19})/);
  return match ? match[1] : null;
}

function getCachedTiktok(videoId) {
  const cached = tiktokCache.get(videoId);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    return cached.data;
  }
  return null;
}

function setCachedTiktok(videoId, data) {
  tiktokCache.set(videoId, { data, timestamp: Date.now() });
  if (tiktokCache.size > 100) {
    const oldestKey = tiktokCache.keys().next().value;
    tiktokCache.delete(oldestKey);
  }
}

async function rateLimitedRequest(videoId) {
  const now = Date.now();
  const last = lastRequestTime.get(videoId);
  if (last) {
    const diff = now - last;
    if (diff < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - diff));
    }
  }
  lastRequestTime.set(videoId, Date.now());
}

/**
 * Fetch TikTok stats.
 * @param {string} videoId - The video ID.
 * @param {boolean} ignoreCache - If true, bypass cache and force a fresh fetch.
 * @returns {Promise<object|null>} Stats object with views, likes, etc., or null on failure.
 */
async function getTikTokStats(videoId, ignoreCache = false) {
  if (!ignoreCache) {
    const cached = getCachedTiktok(videoId);
    if (cached) return cached;
  }

  await rateLimitedRequest(videoId);

  const url = `https://www.tiktok.com/@any/video/${videoId}`;
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 15000
    });
    const html = response.data;

    const regex = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s;
    const match = html.match(regex);
    if (!match) return null;

    const jsonData = JSON.parse(match[1]);
    const itemStruct = jsonData?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!itemStruct) return null;

    const stats = itemStruct.stats || {};
    const result = {
      views: stats.playCount || 0,
      likes: stats.diggCount || 0,
      comments: stats.commentCount || 0,
      shares: stats.shareCount || 0,
      description: itemStruct.desc?.trim() || `Video ${videoId}`
    };

    setCachedTiktok(videoId, result);
    return result;
  } catch (err) {
    console.error(`Error fetching TikTok stats for ${videoId}:`, err.message);
    return null;
  }
}

async function getVideoViews(videoId, ignoreCache = false) {
  const stats = await getTikTokStats(videoId, ignoreCache);
  return stats ? stats.views : null;
}

// ========== BOT GLOBALS ==========
let botStatus = {
  running: false,
  success: 0,
  fails: 0,
  reqs: 0,
  targetViews: 0,        // absolute target (startViews + increment)
  aweme_id: '',
  startViews: 0,
  increment: 0,
  currentViews: 0,
  startTime: null,
  rps: 0,
  rpm: 0,
  successRate: '0%'
};

let isRunning = false;

// ========== ROUTES ==========
app.get('/', (req, res) => {
  res.json({
    status: '🚀 TIKTOK BOT - INCREMENTAL WITH REAL VIEW CHECK',
    message: 'Stops automatically when real views reach start + increment',
    endpoints: ['GET /status', 'POST /start', 'POST /stop']
  });
});

app.get('/status', (req, res) => {
  const total = botStatus.reqs;
  const success = botStatus.success;
  botStatus.successRate = total > 0 ? ((success / total) * 100).toFixed(1) + '%' : '0%';
  res.json(botStatus);
});

app.post('/start', async (req, res) => {
  const { targetViews, increment, videoLink } = req.body;

  if (!videoLink) {
    return res.json({ success: false, message: 'Video link required' });
  }

  // Resolve and extract video ID
  let resolvedUrl;
  try {
    resolvedUrl = await resolveUrl(videoLink);
  } catch {
    resolvedUrl = videoLink;
  }
  const aweme_id = extractVideoId(resolvedUrl);
  if (!aweme_id) {
    return res.json({ success: false, message: 'Invalid TikTok video link' });
  }

  // Fetch current view count (use cache if available – fine for startup)
  const startViews = await getVideoViews(aweme_id, false);
  if (startViews === null) {
    return res.json({ success: false, message: 'Failed to fetch current video views. Try again.' });
  }

  // Determine target
  let target;
  let inc;
  if (increment) {
    inc = parseInt(increment);
    target = startViews + inc;
  } else if (targetViews) {
    inc = targetViews - startViews;
    target = parseInt(targetViews);
  } else {
    return res.json({ success: false, message: 'Provide either increment or targetViews' });
  }

  // Stop previous run
  isRunning = false;

  // Reset stats
  botStatus = {
    running: true,
    success: 0,
    fails: 0,
    reqs: 0,
    targetViews: target,
    aweme_id: aweme_id,
    startViews: startViews,
    increment: inc,
    currentViews: startViews,
    startTime: new Date(),
    rps: 0,
    rpm: 0,
    successRate: '0%'
  };

  console.log('🚀 BOT STARTING WITH REAL VIEW CHECKING');
  console.log(`📊 Start: ${startViews} | Inc: ${inc} | Target: ${target}`);

  isRunning = true;
  startUltraFastBot();

  res.json({
    success: true,
    message: '🚀 Bot started with incremental targeting',
    startViews,
    increment: inc,
    target,
    videoId: aweme_id
  });
});

app.post('/stop', (req, res) => {
  isRunning = false;
  botStatus.running = false;
  res.json({ success: true, message: 'Bot stopped' });
});

// ========== REQUEST GENERATION ==========
const agent = new https.Agent({ keepAlive: true });

function generateUltraDevice() {
  const device_id = Array.from({ length: 19 }, () => Math.floor(Math.random() * 10)).join('');
  const iid = Array.from({ length: 19 }, () => Math.floor(Math.random() * 10)).join('');
  const cdid = crypto.randomUUID();
  const openudid = Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  return { device_id, iid, cdid, openudid };
}

function sendUltraRequest(aweme_id) {
  return new Promise((resolve) => {
    if (!isRunning) {
      resolve();
      return;
    }

    const device = generateUltraDevice();

    const params = `device_id=${device.device_id}&iid=${device.iid}&device_type=SM-G973N&app_name=musically_go&host_abi=armeabi-v7a&channel=googleplay&device_platform=android&version_code=160904&device_brand=samsung&os_version=9&aid=1340`;
    const payload = `item_id=${aweme_id}&play_delta=1`;

    const unix = Math.floor(Date.now() / 1000);
    const sig = {
      'X-Gorgon': '0404b0d30000' + Array.from({ length: 24 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
      'X-Khronos': unix.toString()
    };

    const options = {
      hostname: 'api16-va.tiktokv.com',
      port: 443,
      path: `/aweme/v1/aweme/stats/?${params}`,
      method: 'POST',
      headers: {
        'cookie': 'sessionid=90c38a59d8076ea0fbc01c8643efbe47',
        'x-gorgon': sig['X-Gorgon'],
        'x-khronos': sig['X-Khronos'],
        'user-agent': 'okhttp/3.10.0.1',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 3000,
      agent
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        botStatus.reqs++;
        try {
          const jsonData = JSON.parse(data);
          if (jsonData && jsonData.log_pb && jsonData.log_pb.impr_id) {
            botStatus.success++;
          } else {
            botStatus.fails++;
          }
        } catch {
          botStatus.fails++;
        }
        resolve();
      });
    });

    req.on('error', () => {
      botStatus.fails++;
      botStatus.reqs++;
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      botStatus.fails++;
      botStatus.reqs++;
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

// ========== MAIN BOT LOOP ==========
async function startUltraFastBot() {
  console.log('🚀 BOT LOOP STARTED – views updated every 30s (background)');

  let lastReqs = 0;
  let consecutiveSuccess = 0;

  // Refresh real view count every 30 seconds – always ignore cache (background)
  const viewRefreshInterval = setInterval(async () => {
    if (!isRunning) {
      clearInterval(viewRefreshInterval);
      return;
    }
    try {
      const stats = await getTikTokStats(botStatus.aweme_id, true);
      if (stats && stats.views !== undefined) {
        botStatus.currentViews = stats.views;
        console.log(`📈 Real views: ${botStatus.currentViews} / ${botStatus.targetViews}`);
      } else {
        console.log(`⚠️ Could not refresh views, keeping last known (${botStatus.currentViews})`);
      }
    } catch (err) {
      console.log(`❌ View refresh error: ${err.message}`);
    }
  }, 30000);

  const statsInterval = setInterval(() => {
    botStatus.rps = ((botStatus.reqs - lastReqs) / 1).toFixed(1);
    botStatus.rpm = (botStatus.rps * 60).toFixed(1);
    lastReqs = botStatus.reqs;

    const total = botStatus.reqs;
    const success = botStatus.success;
    botStatus.successRate = total > 0 ? ((success / total) * 100).toFixed(1) + '%' : '0%';

    console.log(`📊 Sent: ${botStatus.success} | Real: ${botStatus.currentViews}/${botStatus.targetViews} | RPS: ${botStatus.rps} | RPM: ${botStatus.rpm}`);

    if (!isRunning) clearInterval(statsInterval);
  }, 1000);

  while (isRunning && botStatus.currentViews < botStatus.targetViews) {
    const successRate = parseFloat(botStatus.successRate);

    // 🚀 ADAPTIVE BATCH SIZE – success rate ke hisab se
    let batchSize = 300;
    let delay = 20;

    if (successRate > 40) {
      batchSize = 400;
      delay = 10;
      consecutiveSuccess++;
    } else if (successRate < 10) {
      batchSize = 400;
      delay = 20;
      consecutiveSuccess = 0;
    }

    if (consecutiveSuccess > 5) {
      batchSize = 400;
      delay = 20;
    }

    const promises = [];
    for (let i = 0; i < batchSize; i++) {
      promises.push(sendUltraRequest(botStatus.aweme_id));
    }
    await Promise.all(promises);

    // 🚀 MINIMAL DELAY ONLY – no view checking here
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  isRunning = false;
  botStatus.running = false;
  clearInterval(statsInterval);
  clearInterval(viewRefreshInterval);

  const timeTaken = ((Date.now() - botStatus.startTime) / 1000 / 60).toFixed(1);
  console.log('🛑 Bot stopped – target reached or manual stop');
  console.log(`📈 Final real views: ${botStatus.currentViews} / ${botStatus.targetViews}`);
  console.log(`⚡ Average request rate: ${(botStatus.reqs / (timeTaken * 60)).toFixed(1)} req/sec`);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TIKTOK BOT WITH FRESH VIEW CHECKING RUNNING ON PORT ${PORT}`);
  console.log(`🎯 Target: start + increment, auto‑stop when real views hit target`);
  console.log(`⏱️  Views refreshed every 30 seconds (cache bypass)`);
});
