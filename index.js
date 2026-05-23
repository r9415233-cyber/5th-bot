const express = require('express');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ========== PERFORMANCE CONFIG ==========
const MAX_SOCKETS = 200;
const BASE_BATCH_SIZE = 800;
const MIN_DELAY = 5;

// ========== HTTPS AGENT ==========
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: 50,
  keepAliveMsecs: 1000
});

// ========== GLOBAL ==========
let isRunning = false;

let botStatus = {
  running: false,
  success: 0,
  fails: 0,
  reqs: 0,
  targetViews: 0,
  aweme_id: '',
  startViews: 0,
  increment: 0,
  currentViews: 0,
  startTime: null,
  rps: 0,
  rpm: 0,
  successRate: '0%'
};

// ========== CACHE ==========
const tiktokCache = new Map();

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
];

function getRandomUA() {
  return USER_AGENTS[
    Math.floor(Math.random() * USER_AGENTS.length)
  ];
}

// ========== UTILS ==========
async function resolveUrl(url) {

  try {

    const res = await axios.get(url, {
      maxRedirects: 5,
      headers: {
        'User-Agent': getRandomUA()
      },
      timeout: 10000
    });

    return res.request.res.responseUrl || url;

  } catch {
    return url;
  }
}

function extractVideoId(url) {

  const match = url.match(/\/video\/(\d{15,20})/);

  return match ? match[1] : null;
}

// ========== TIKTOK STATS ==========
async function getTikTokStats(videoId, ignoreCache = false) {

  if (!ignoreCache) {

    const cached = tiktokCache.get(videoId);

    if (
      cached &&
      (Date.now() - cached.timestamp < 100000)
    ) {
      return cached.data;
    }
  }

  try {

    const res = await axios.get(
      `https://www.tiktok.com/@any/video/${videoId}`,
      {
        headers: {
          'User-Agent': getRandomUA()
        },
        timeout: 15000
      }
    );

    const match = res.data.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s
    );

    if (!match) return null;

    const json = JSON.parse(match[1]);

    const item =
      json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;

    if (!item) return null;

    const stats = item.stats || {};

    const data = {
      views: stats.playCount || 0,
      likes: stats.diggCount || 0,
      comments: stats.commentCount || 0,
      shares: stats.shareCount || 0
    };

    tiktokCache.set(videoId, {
      data,
      timestamp: Date.now()
    });

    return data;

  } catch {
    return null;
  }
}

async function getVideoViews(videoId) {

  const stats = await getTikTokStats(videoId);

  return stats ? stats.views : null;
}

// ========== DEVICES ==========
function generateDevice() {

  const device_id = Array.from(
    { length: 19 },
    () => Math.floor(Math.random() * 10)
  ).join('');

  const iid = Array.from(
    { length: 19 },
    () => Math.floor(Math.random() * 10)
  ).join('');

  const cdid = crypto.randomUUID();

  return {
    device_id,
    iid,
    cdid
  };
}

const sessions = [
  '90c38a59d8076ea0fbc01c8643efbe47',
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'
];

function getRandomSession() {

  return sessions[
    Math.floor(Math.random() * sessions.length)
  ];
}

// ========== REQUEST ==========
function sendRequest(aweme_id) {

  return new Promise((resolve) => {

    if (!isRunning) {
      resolve();
      return;
    }

    const device = generateDevice();

    const payload =
      `item_id=${aweme_id}&play_delta=1`;

    const params =
      `device_id=${device.device_id}` +
      `&iid=${device.iid}` +
      `&cdid=${device.cdid}` +
      `&device_type=SM-G998B` +
      `&app_name=musically_go` +
      `&device_platform=android` +
      `&version_code=160904` +
      `&aid=1340`;

    const req = https.request({

      hostname: 'api16-va.tiktokv.com',
      port: 443,

      path:
        `/aweme/v1/aweme/stats/?${params}`,

      method: 'POST',

      headers: {
        'cookie':
          `sessionid=${getRandomSession()}`,

        'user-agent':
          'okhttp/3.10.0.1',

        'content-type':
          'application/x-www-form-urlencoded',

        'content-length':
          Buffer.byteLength(payload)
      },

      timeout: 3000,
      agent

    }, (res) => {

      res.resume();

      res.on('end', () => {

        botStatus.reqs++;

        if (res.statusCode === 200) {
          botStatus.success++;
        } else {
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

// ========== BOT LOOP ==========
async function startBotLoop() {

  console.log('🔥 HIGH PERFORMANCE LOOP STARTED');

  let lastReqs = 0;

  // ===== STATUS =====
  const statsInterval = setInterval(() => {

    if (!isRunning) {
      clearInterval(statsInterval);
      return;
    }

    botStatus.rps =
      Math.round(botStatus.reqs - lastReqs);

    botStatus.rpm =
      botStatus.rps * 60;

    lastReqs = botStatus.reqs;

    const total = botStatus.reqs;

    botStatus.successRate =
      total > 0
        ? (
            (botStatus.success / total) * 100
          ).toFixed(1) + '%'
        : '0%';

    console.log(
      `⚡ ${botStatus.rps} req/s | ` +
      `✅ ${botStatus.success} | ` +
      `❌ ${botStatus.fails}`
    );

  }, 1000);

  // ===== VIEW CHECK =====
  const viewInterval = setInterval(async () => {

    if (!isRunning) {

      clearInterval(viewInterval);

      return;
    }

    const stats =
      await getTikTokStats(
        botStatus.aweme_id,
        true
      );

    if (stats) {

      botStatus.currentViews =
        stats.views;

      console.log(
        `👁️ ${botStatus.currentViews}/${botStatus.targetViews}`
      );

      if (
        botStatus.currentViews >=
        botStatus.targetViews
      ) {

        console.log('🎯 TARGET REACHED');

        isRunning = false;
        botStatus.running = false;

        clearInterval(viewInterval);
        clearInterval(statsInterval);
      }
    }

  }, 15000);

  // ===== MAIN LOOP =====
  while (
    isRunning &&
    botStatus.currentViews <
      botStatus.targetViews
  ) {

    const successRate =
      parseFloat(botStatus.successRate);

    let batchSize = BASE_BATCH_SIZE;
    let delay = MIN_DELAY;

    // adaptive
    if (successRate < 5) {
      batchSize = 500;
      delay = 15;
    }

    if (successRate > 30) {
      batchSize = 1000;
      delay = 1;
    }

    let batch = [];

    for (let i = 0; i < batchSize; i++) {
      batch.push(
        sendRequest(botStatus.aweme_id)
      );
    }

    await Promise.all(batch);

    batch = null;

    if (delay > 0) {

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }
  }

  isRunning = false;

  botStatus.running = false;

  clearInterval(statsInterval);
  clearInterval(viewInterval);

  console.log('🛑 BOT STOPPED');
}

// ========== ROUTES ==========
app.get('/', (req, res) => {

  res.json({
    status:
      '🔥 HIGH PERFORMANCE TIKTOK BOT',

    endpoints: [
      'GET /status',
      'POST /start',
      'POST /stop'
    ]
  });
});

app.get('/status', (req, res) => {

  const total = botStatus.reqs;

  botStatus.successRate =
    total > 0
      ? (
          (botStatus.success / total) * 100
        ).toFixed(1) + '%'
      : '0%';

  res.json(botStatus);
});

// ========== START ==========
app.post('/start', async (req, res) => {

  try {

    const {
      videoLink,
      increment,
      targetViews
    } = req.body;

    if (!videoLink) {

      return res.json({
        success: false,
        message: 'videoLink required'
      });
    }

    const resolvedUrl =
      await resolveUrl(videoLink);

    const aweme_id =
      extractVideoId(resolvedUrl);

    if (!aweme_id) {

      return res.json({
        success: false,
        message: 'Invalid TikTok link'
      });
    }

    const currentViews =
      await getVideoViews(aweme_id);

    if (currentViews === null) {

      return res.json({
        success: false,
        message: 'Failed to fetch views'
      });
    }

    let target;
    let inc;

    if (increment) {

      inc = parseInt(increment);

      target = currentViews + inc;

    } else if (targetViews) {

      target = parseInt(targetViews);

      inc = target - currentViews;

    } else {

      return res.json({
        success: false,
        message:
          'Provide increment or targetViews'
      });
    }

    // stop old
    isRunning = false;

    // reset
    botStatus = {

      running: true,

      success: 0,
      fails: 0,
      reqs: 0,

      targetViews: target,

      aweme_id,

      startViews: currentViews,

      increment: inc,

      currentViews,

      startTime: Date.now(),

      rps: 0,
      rpm: 0,

      successRate: '0%'
    };

    isRunning = true;

    startBotLoop();

    res.json({

      success: true,

      message:
        '🔥 HIGH PERFORMANCE BOT STARTED',

      videoId: aweme_id,

      startViews: currentViews,

      increment: inc,

      targetViews: target,

      config: {
        sockets: MAX_SOCKETS,
        batch: BASE_BATCH_SIZE,
        delay: MIN_DELAY
      }
    });

  } catch (err) {

    res.json({
      success: false,
      message: err.message
    });
  }
});

// ========== STOP ==========
app.post('/stop', (req, res) => {

  isRunning = false;

  botStatus.running = false;

  res.json({
    success: true,
    message: '🛑 BOT STOPPED'
  });
});

// ========== SERVER ==========
app.listen(PORT, '0.0.0.0', () => {

  console.log(
    `🔥 HIGH PERFORMANCE BOT RUNNING ON ${PORT}`
  );

});
