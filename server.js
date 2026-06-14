import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoConnector from './config/mongoConnector.js';
import leadRoutes from './routes/leadRoutes.js';
import ssoRoutes from './routes/ssoRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import aiAnalyticsRoutes from './routes/aiAnalyticsRoutes.js';
import accountRoutes from './routes/accountRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import ssoAuthMiddleware from './middleware/ssoAuthMiddleware.js';
import { apiKeyAuthMiddleware } from './middleware/apiKeyAuthMiddleware.js';
import leadRateLimiter from './middleware/leadRateLimiter.js';
import { loadSecretsFromAWS } from './config/secretsManager.js';
import { initializeRedis, closeRedisConnection, isRedisHealthy, createNewRedisConnection } from './config/redisConnector.js';
import { shutdownAll as shutdownAllQueues, getRegisteredQueues } from './config/queueManager.js';
import { initializeWorker as initLeadWorker, getHealth as getLeadQueueHealth } from './queue/leadQueue.js';
import { initializeWorker as initReminderWorker, getHealth as getReminderQueueHealth } from './queue/reminderQueue.js';
import { startReminderRecovery } from './queue/reminderRecovery.js';
import { deliverToSSEClients } from './services/channels/inApp.js';
import noteRoutes     from './routes/noteRoutes.js';
import reminderRoutes from './routes/reminderRoutes.js';
import pushRoutes     from './routes/pushRoutes.js';
import activityRoutes from './routes/activityRoutes.js';

// AWS Secrets Manager - loads secrets into process.env
const hasAWSCredentials = process.env.AWS_SECRET_MANAGER_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_MANAGER_SECRET_ACCESS_KEY;

if (hasAWSCredentials) {
  console.log('[Startup] Loading secrets from AWS Secrets Manager...');
  try {
    await loadSecretsFromAWS();
    console.log('[Startup] ✓ Successfully loaded secrets from AWS Secrets Manager');
  } catch (error) {
    console.error('[Startup] ⚠ Failed to load secrets from AWS:', error.message);
    console.error('[Startup] Continuing with environment variables only');
    // Don't exit - allow app to continue with .env variables
  }
} else {
  console.log('[Startup] AWS Secrets Manager not configured, using environment variables');
}

const app = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || 8081;

// Parse allowed origins from environment variable
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000'];

// Enable CORS with credentials for SSO cookie support
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Check if origin is in allowed list
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // In development/local, allow any localhost origin
      if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local')
        && origin.startsWith('http://localhost')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true, // REQUIRED for SSO cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Set-Cookie']
}));

// Cookie parser - REQUIRED for SSO authentication
app.use(cookieParser());

// JSON and URL-encoded body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
mongoConnector.connect()
  .then(() => {
    console.log('MongoDB connected successfully');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// ── Redis + Queue initialization ───────────────────────────────────────────
// Run sequentially: Redis must be ready before the worker can connect.
// Non-fatal in local/dev — server continues without queue features if Redis is unavailable.
(async () => {
  try {
    await initializeRedis();
    console.log('[Startup] Redis initialized successfully');

    initLeadWorker();
    initReminderWorker();
    console.log('[Startup] Queue workers started | active queues:', getRegisteredQueues().join(', '));

    // ── Redis pub/sub subscriber for SSE in-app notification delivery ──
    // Separate connection required — a subscribed ioredis client cannot
    // issue regular commands on the same connection.
    const redisSubscriber = createNewRedisConnection('reminder-sse-subscriber');
    await redisSubscriber.connect();
    await redisSubscriber.psubscribe('reminder:notify:*');
    redisSubscriber.on('pmessage', (_pattern, channel, message) => {
      try {
        // channel = "reminder:notify:{adminId}"
        const adminId = channel.split(':')[2];
        const payload = JSON.parse(message);
        deliverToSSEClients(adminId, payload);
      } catch (err) {
        console.error('[SSE] Failed to deliver pub/sub message:', err.message);
      }
    });
    console.log('[Startup] Redis SSE subscriber started');

    // ── Reminder recovery cron ──────────────────────────────────────────
    // MongoDB is connecting in parallel — the recovery cron is resilient
    // (errors are caught per-reminder). Subsequent runs will succeed once
    // MongoDB is ready.
    startReminderRecovery();

  } catch (error) {
    console.warn('[Startup] WARNING: Redis / queue worker unavailable — queue features disabled.', error.message);
  }
})();

// SSO Routes
app.use('/api/sso', ssoRoutes);

// Auth Routes (alias for SSO routes to support /api/auth endpoints)
app.use('/api/auth', ssoRoutes);

// UI SSO Routes (alias for frontend UI)
app.use('/api/ui/sso', ssoRoutes);

// Login redirect route
app.get('/login', (req, res) => {
  const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8081';
  const redirectUrl = req.query.redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
  const encodedRedirect = encodeURIComponent(redirectUrl);

  // Redirect to SSO auth service login page
  res.redirect(`${authServiceUrl}/login?redirect=${encodedRedirect}`);
});

app.use('/api/ui/accounts', ssoAuthMiddleware, accountRoutes);

// Admin Routes — SSO required
app.use('/api/ui/admins', ssoAuthMiddleware, adminRoutes);

// API key path: auth → rate limit (100 req/60s per acctId) → routes
// Rate limiter runs after auth so req.acctId is already set.
app.use('/api/leads', apiKeyAuthMiddleware, leadRateLimiter, leadRoutes);
app.use('/api/ui/leads', ssoAuthMiddleware, leadRoutes);

app.use('/api/ui/analytics', ssoAuthMiddleware, analyticsRoutes);
app.use('/api/ui/analytics/ai', ssoAuthMiddleware, aiAnalyticsRoutes);

// Notes & Reminders — SSO required
app.use('/api/ui/leads/:leadId/notes',     ssoAuthMiddleware, noteRoutes);
app.use('/api/ui/leads/:leadId/reminders', ssoAuthMiddleware, reminderRoutes);

// Batch activity counts (notes + reminders per lead, for grid highlights)
app.use('/api/ui/activity', ssoAuthMiddleware, activityRoutes);

// Push subscriptions, SSE stream, and bell inbox
app.use('/api/ui/push', ssoAuthMiddleware, pushRoutes);
// Bell inbox (fired reminders + mark-read) — also mounted under /api/ui/reminders
app.use('/api/ui/reminders', ssoAuthMiddleware, pushRoutes);

// Health check route
app.get('/health', async (req, res) => {
  const redisHealthy = await isRedisHealthy();
  const activeQueues = getRegisteredQueues();
  const leadQueueHealth = await getLeadQueueHealth();

  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    redis: redisHealthy ? 'connected' : 'disconnected',
    queues: activeQueues,
    leadQueue: leadQueueHealth,
    reminderQueue: await getReminderQueueHealth()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: err.message
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  console.log(`[Shutdown] ${signal} received — starting graceful shutdown...`);
  try {
    await shutdownAllQueues();
    console.log('[Shutdown] All queue workers closed');

    await closeRedisConnection();
    console.log('[Shutdown] Redis connection closed');

    server.close(() => {
      console.log('[Shutdown] HTTP server closed');
      process.exit(0);
    });

    // Force-exit after 10 s if graceful shutdown stalls
    setTimeout(() => {
      console.warn('[Shutdown] Forcing exit after timeout');
      process.exit(1);
    }, 10000);
  } catch (error) {
    console.error('[Shutdown] Error during graceful shutdown:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;
