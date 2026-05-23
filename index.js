const express = require('express');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ========== CONFIG ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ===== 512MB RAM OPTIMIZED =====
const THREADS = 8;
const BATCH_PER_THREAD = 35;
const DELAY_MS = 8;
const TOTAL_PER_BATCH = THREADS * BATCH_PER_THREAD;

// ========== GLOBAL ==========
let isRunning = false;
let workers = [];

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
  threads: THREADS,
  totalPerBatch: TOTAL_PER_BATCH,
  startTime: null,
  rps: 0,
  rpm: 0,
  successRate: '0%'
};

// ========== USER AGENTS ==========
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ========== URL ==========
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
const tiktokCache = new Map();

async function getTikTokStats(videoId, ignoreCache = false) {

  if (!ignoreCache) {

    const cached = tiktokCache.get(videoId);

    if (cached && (Date.now() - cached.timestamp < 100000)) {
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

async function getVideoViews(videoId, ignoreCache = false) {

  const stats = await getTikTokStats(videoId, ignoreCache);

  return stats ? stats.views : null;
}

// ========== WORKER ==========
if (!isMainThread) {

  const { aweme_id } = workerData;

  let active = true;

  parentPort.on('message', (msg) => {
    if (msg === 'stop') active = false;
  });

  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 80,
    maxFreeSockets: 20,
    keepAliveMsecs: 1000
  });

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

  function sendRequest() {

    return new Promise((resolve) => {

      const device_id = Array(19)
        .fill(0)
        .map(() => Math.floor(Math.random() * 10))
        .join('');

      const iid = Array(19)
        .fill(0)
        .map(() => Math.floor(Math.random() * 10))
        .join('');

      const cdid = crypto.randomUUID();

      const payload =
        `item_id=${aweme_id}&play_delta=1`;

      const params =
        `device_id=${device_id}` +
        `&iid=${iid}` +
        `&cdid=${cdid}` +
        `&device_type=SM-G998B` +
        `&app_name=musically_go` +
        `&device_platform=android` +
        `&version_code=160904` +
        `&aid=1340`;

      const req = https.request({

        hostname: 'api16-va.tiktokv.com',
        port: 443,
        path: `/aweme/v1/aweme/stats/?${params}`,
        method: 'POST',

        headers: {
          'cookie': `sessionid=${getRandomSession()}`,
          'user-agent': 'okhttp/3.10.0.1',
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(payload)
        },

        timeout: 3000,
        agent

      }, (res) => {

        res.resume();

        res.on('end', () => {

          parentPort.postMessage(
            res.statusCode === 200
              ? 'success'
              : 'fail'
          );

          resolve();
        });
      });

      req.on('error', () => {
        parentPort.postMessage('fail');
        resolve();
      });

      req.on('timeout', () => {
        req.destroy();
        parentPort.postMessage('fail');
        resolve();
      });

      req.write(payload);
      req.end();
    });
  }

  async function workerLoop() {

    while (active) {

      let batch = [];

      for (let i = 0; i < BATCH_PER_THREAD; i++) {
        batch.push(sendRequest());
      }

      await Promise.all(batch);

      batch = null;

      if (global.gc) {
        global.gc();
      }

      await new Promise(r =>
        setTimeout(r, DELAY_MS)
      );
    }

    process.exit(0);
  }

  workerLoop();

  return;
}

// ========== ROUTES ==========
app.get('/', (req, res) => {

  res.json({
    status: '🔥 20X POWER BOT API',
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
      ? ((botStatus.success / total) * 100).toFixed(1) + '%'
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
        message: 'Provide increment or targetViews'
      });
    }

    // stop old
    isRunning = false;

    workers.forEach(w => {
      try {
        w.postMessage('stop');
        w.terminate();
      } catch {}
    });

    workers = [];

    // reset status
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

      threads: THREADS,
      totalPerBatch: TOTAL_PER_BATCH,

      startTime: Date.now(),

      rps: 0,
      rpm: 0,

      successRate: '0%'
    };

    isRunning = true;

    // workers
    for (let i = 0; i < THREADS; i++) {

      const worker = new Worker(__filename, {
        workerData: {
          aweme_id
        }
      });

      worker.on('message', (msg) => {

        botStatus.reqs++;

        if (msg === 'success') {
          botStatus.success++;
        } else {
          botStatus.fails++;
        }
      });

      worker.on('error', (err) => {
        console.log('Worker Error:', err.message);
      });

      worker.on('exit', (code) => {
        console.log('Worker Exit:', code);
      });

      workers.push(worker);
    }

    // stats update
    let lastReqs = 0;

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

    }, 1000);

    // view checker
    const viewInterval = setInterval(async () => {

      if (!isRunning) {

        clearInterval(viewInterval);

        return;
      }

      const stats =
        await getTikTokStats(aweme_id, true);

      if (stats) {

        botStatus.currentViews =
          stats.views;

        if (
          botStatus.currentViews >=
          botStatus.targetViews
        ) {

          isRunning = false;

          botStatus.running = false;

          workers.forEach(w => {
            try {
              w.postMessage('stop');
              w.terminate();
            } catch {}
          });

          workers = [];

          clearInterval(viewInterval);
          clearInterval(statsInterval);
        }
      }

    }, 15000);

    res.json({

      success: true,
      message: '🔥 BOT STARTED',

      videoId: aweme_id,

      startViews: currentViews,
      increment: inc,
      targetViews: target,

      threads: THREADS,
      batch: TOTAL_PER_BATCH
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

  workers.forEach(w => {

    try {

      w.postMessage('stop');

      w.terminate();

    } catch {}
  });

  workers = [];

  res.json({
    success: true,
    message: '🛑 BOT STOPPED'
  });
});

// ========== SERVER ==========
app.listen(PORT, '0.0.0.0', () => {

  console.log(
    `🔥 20X POWER BOT API RUNNING ON ${PORT}`
  );

});
