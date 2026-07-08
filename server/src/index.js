const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
require('dotenv').config();

const { connectDB } = require('./utils/database');
const db = require('./utils/database');
const authRoutes = require('./routes/auth');
const cameraRoutes = require('./routes/cameras');
const alertRoutes = require('./routes/alerts');
const settingsRoutes = require('./routes/settings');
const debugRoutes = require('./routes/debug');
const aiRoutes = require('./routes/ai');
const photoRoutes = require('./routes/photos');
const { initializeAIDetection } = require('./services/aiDetection');
const { initializeNotificationService } = require('./services/notifications');
const { CameraManager } = require('./services/cameraManager');
const unifiedAI = require('./services/unifiedAI');
const { logger } = require('./utils/logger');

const vault = require('./utils/vault');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  },
  maxHttpBufferSize: 10 * 1024 * 1024  // 10MB — needed for base64 JPEG frames from Colab
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false
}));
app.use(cors({
  origin: true,
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session config for Passport
app.use(session({
  secret: process.env.SESSION_SECRET || 'sentinelai-session',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Static files
app.use('/models', express.static(path.join(__dirname, '../models')));
// HLS segments (m3u8 + ts) for RTSP/RTMP→HLS proxy
app.use('/hls', express.static(path.join(__dirname, '../public/hls'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// User-captured photos
app.use('/uploads/photos', express.static(path.join(__dirname, '../uploads/photos'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// AI Video Clips
app.use('/clips', express.static(path.join(__dirname, '../../ai/sentinel_data/clips'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/cameras', cameraRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/photos', photoRoutes);

// Serve saved clips statically
const clipsDir = path.join(__dirname, '../clips');
app.use('/clips', express.static(clipsDir));

// ============ COLAB WEBSOCKET PUSH (Zero-Lag Architecture) ============
// Colab pushes annotated frames via HTTP POST → Server broadcasts via Socket.IO
// Eliminates: second Pinggy tunnel, HTTP polling, ntfy.sh polling, MJPEG parsing
const https = require('https');
const httpNative = require('http');

let colabConnected = false;
let colabLastFrameAt = 0;
let colabFrameCount = 0;
let colabFps = 0;
let colabFpsCounter = 0;
let colabFpsTimer = Date.now();

// FPS counter reset every second
setInterval(() => {
  colabFps = colabFpsCounter;
  colabFpsCounter = 0;
}, 1000);

// Endpoint: Colab pushes annotated frames here via HTTP POST
// Colab sends base64 JPEG + detection data, server broadcasts to all browser clients via Socket.IO
// This is the KEY optimization: push-based, not poll-based
app.post('/api/colab/push-frame', express.json({ limit: '10mb' }), (req, res) => {
  const { frame, detections, timestamp, fps } = req.body;
  
  if (!frame) {
    return res.status(400).json({ error: 'No frame data' });
  }

  colabConnected = true;
  colabLastFrameAt = Date.now();
  colabFrameCount++;
  colabFpsCounter++;

  // Broadcast annotated frame via Socket.IO (push-based, zero-polling)
  if (io) {
    // Send frame to Colab viewers (annotated view)
    io.to('colab-viewers').emit('colab-annotated-frame', {
      frame,           // base64 JPEG
      detections: detections || [],
      timestamp: timestamp || Date.now(),
      fps: fps || colabFps
    });
    
    // Also broadcast detections to all camera subscribers for overlay rendering
    if (detections && detections.length > 0) {
      io.emit('detections', {
        cameraId: req.body.camera_id || 'colab',
        detections,
        timestamp: timestamp || Date.now(),
        source: 'colab-ai'
      });
    }

    // Broadcast colab status
    io.emit('colab-status', {
      connected: true,
      fps: fps || colabFps,
      frameCount: colabFrameCount
    });
  }

  res.json({ ok: true, received: colabFrameCount });
});

// Endpoint: Colab sends heartbeats to maintain connection status
app.post('/api/colab/heartbeat', express.json(), (req, res) => {
  colabConnected = true;
  colabLastFrameAt = Date.now();
  const { fps: remoteFps, detections_count } = req.body || {};
  res.json({ ok: true, serverTime: Date.now() });
});

// Endpoint: Colab signals disconnection
app.post('/api/colab/disconnect', (req, res) => {
  colabConnected = false;
  io && io.emit('colab-status', { connected: false });
  res.json({ ok: true });
});

// Endpoint: Frontend checks Colab connection status (replaces ntfy.sh polling)
app.get('/api/colab-status', (req, res) => {
  // Auto-detect disconnection if no frame received in 5 seconds
  if (colabConnected && Date.now() - colabLastFrameAt > 5000) {
    colabConnected = false;
  }
  res.json({
    connected: colabConnected,
    lastFrameAt: colabLastFrameAt,
    frameCount: colabFrameCount,
    fps: colabFps,
    url: null  // No longer needed — push-based
  });
});

// Endpoint: Legacy colab-stream for backward compatibility (redirects to push-based)
app.get('/api/colab-stream', (req, res) => {
  res.status(410).json({
    error: 'Legacy polling endpoint deprecated',
    message: 'Use WebSocket push mode. Colab should POST to /api/colab/push-frame',
    migrate: 'Replace Flask+Pinggy with HTTP POST to this server'
  });
});

app.get('/api/colab-frame', (req, res) => {
  res.status(410).json({
    error: 'Legacy polling endpoint deprecated',
    message: 'Use Socket.IO push mode. Frontend should listen to colab-annotated-frame event'
  });
});

// Camera proxy: Colab reads camera stream via this server tunnel
// Forwards requests to the local camera_streamer on port 5100
const CAMERA_STREAMER_URL = process.env.CAMERA_STREAMER_URL || 'http://localhost:5100';
const httpProxy = require('http');

app.get('/api/camera/stream', (req, res) => {
  const proxyReq = httpProxy.get(`${CAMERA_STREAMER_URL}/videofeed`, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.status(502).json({ error: 'Camera streamer unavailable', details: e.message });
  });
  proxyReq.setTimeout(30000, () => { proxyReq.destroy(); });
});

app.get('/api/camera/snapshot', async (req, res) => {
  try {
    const proxyReq = httpProxy.get(`${CAMERA_STREAMER_URL}/shot.jpg`, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'image/jpeg' });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.status(502).json({ error: 'Camera streamer unavailable' });
    });
    proxyReq.setTimeout(10000, () => { proxyReq.destroy(); });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check — Chap 14.2 : expose engine + stats
app.get('/api/health', (req, res) => {
  const statsTracker = require('./services/statsTracker');
  const aiBridge = require('./services/aiBridge');
  res.json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    engine: aiBridge.getEngineInfo ? aiBridge.getEngineInfo() : { name: 'unknown' },
    stats: statsTracker.getSnapshot(),
  });
});

// Initialize services
const cameraManager = new CameraManager(io);
const aiDetection = initializeAIDetection(io);
const notifications = initializeNotificationService(io);
const PythonStreamer = require('./services/pythonStreamer');
const pythonStreamer = new PythonStreamer(cameraManager);
const LiveJPEGStreamer = require('./services/liveStreamer');
const liveStreamer = new LiveJPEGStreamer(cameraManager);
liveStreamer.setIO(io);
app.locals.liveStreamer = liveStreamer;

// OPTIMISATION : partage de frame entre stream MJPEG et detection AI
// (evite une 2eme connexion HTTP vers IP Webcam qui sature)
cameraManager.setLiveStreamer(liveStreamer);

cameraManager.setAIDetection(aiDetection);
aiDetection.setNotifications(notifications);
app.locals.cameraManager = cameraManager;
app.locals.aiDetection = aiDetection;
app.locals.notifications = notifications;
app.locals.pythonStreamer = pythonStreamer;

// Initialize unified AI (YOLOv8 + Pose + Weapons + Faces)
unifiedAI.initialize(io).catch(e => logger.error('UnifiedAI init error:', e));
unifiedAI.setNotifications(notifications);
cameraManager.setUnifiedAI(unifiedAI);
app.locals.unifiedAI = unifiedAI;

// WebSocket connections
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    socket.userEmail = decoded.email;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id} (user: ${socket.userId || 'anonymous'})`);

  socket.on('subscribe-camera', (cameraId) => {
    socket.join(`camera-${cameraId}`);
  });

  socket.on('unsubscribe-camera', (cameraId) => {
    socket.leave(`camera-${cameraId}`);
  });

  socket.on('subscribe-live', (data) => {
    const cameraId = typeof data === 'string' ? data : data.cameraId;
    const subId = typeof data === 'string' ? socket.id : data.subId;
    
    // Create a proxy socket object so multiple React mounts on the same real socket
    // are counted as distinct subscribers in LiveStreamer's Set.
    const proxySocket = {
      id: `${socket.id}-${subId}`,
      originalId: socket.id,
      join: (...args) => socket.join(...args),
      leave: (...args) => socket.leave(...args),
      emit: (...args) => socket.emit(...args)
    };
    
    liveStreamer.subscribe(cameraId, proxySocket);
  });

  socket.on('unsubscribe-live', (data) => {
    const cameraId = typeof data === 'string' ? data : data.cameraId;
    const subId = typeof data === 'string' ? socket.id : data.subId;
    
    const proxySocket = {
      id: `${socket.id}-${subId}`,
      originalId: socket.id,
      join: (...args) => socket.join(...args),
      leave: (...args) => socket.leave(...args),
      emit: (...args) => socket.emit(...args)
    };
    
    liveStreamer.unsubscribe(cameraId, proxySocket);
  });

  // Stream URL is now fetched via REST: GET /api/cameras/:id/stream-url
  // Socket.IO is used only for detection results and alerts
  // Colab push mode: browser subscribes to receive annotated frames
  socket.on('subscribe-colab', () => {
    socket.join('colab-viewers');
    logger.info(`[Colab] Browser subscribed to annotated frames: ${socket.id}`);
    // Send current status
    socket.emit('colab-status', { connected: colabConnected, fps: colabFps });
  });

  socket.on('unsubscribe-colab', () => {
    socket.leave('colab-viewers');
  });

  socket.on('start-detection', async (cameraId) => {
    await cameraManager.startDetection(cameraId, aiDetection);
  });

  socket.on('stop-detection', (cameraId) => {
    cameraManager.stopDetection(cameraId);
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
    
    // Instead of passing the raw socket, LiveStreamer now holds proxy objects.
    // We need to unsubscribe all proxy objects that belong to this real socket.
    for (const [cameraId, stream] of liveStreamer.streams) {
      for (const sub of stream.subscribers) {
        if (sub.originalId === socket.id || sub.id === socket.id) {
          liveStreamer.unsubscribe(cameraId, sub);
        }
      }
    }
  });
});

// Serve React app in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../client/build', 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Use the configured port (default 5000)
const PORT = process.env.PORT || 5000;

async function startServer() {
  const mongoConnected = await connectDB();
  if (mongoConnected) {
    logger.info('MongoDB connected successfully');
  } else {
    logger.warn('Running without MongoDB persistence');
  }

  server.listen(PORT, () => {
    logger.info(`
  ============================================
  AI Camera Security System Server
  ============================================
  Server running on port ${PORT}
  Environment: ${process.env.NODE_ENV || 'development'}
  MongoDB: ${mongoConnected ? 'Connected' : 'Disabled'}
  Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? 'Configured' : 'Not configured'}
  WebSocket: Ready
  ============================================
    `);

    cameraManager.initialize();

    // Load existing cameras from database so detection works after restart
    cameraManager.loadCamerasFromDB(db, vault).catch(e => logger.error('Camera load error:', e.message));
  });
}

startServer();

module.exports = { app, server, io };
