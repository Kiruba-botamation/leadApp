import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import mongoConnector from './config/mongoConnector.js';
import leadRoutes from './routes/leadRoutes.js';
import ssoRoutes from './routes/ssoRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8083;

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

// Lead Routes
app.use('/api/leads', leadRoutes);

// Analytics Routes
app.use('/api/analytics', analyticsRoutes);

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
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

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;
