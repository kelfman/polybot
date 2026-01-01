/**
 * Express server for the backtester dashboard
 */

import 'dotenv/config';
import express from 'express';
import { resolve } from 'path';
import { getConfig } from '../config/index.js';
import { getDb, closeDb } from '../db/client.js';
import routes from './routes.js';
import liveRoutes from './live-routes.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function main() {
  console.log('=== Polymarket Backtester Server ===\n');

  // Load config to validate it's correct
  try {
    const config = getConfig();
    console.log('Config loaded successfully');
    console.log(`Strategy: ${config.strategy.name}`);
  } catch (error) {
    console.error('Failed to load config:', error);
    process.exit(1);
  }

  // Initialize database
  try {
    getDb();
    console.log('Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }

  // Create Express app
  const app = express();

  // Middleware
  app.use(express.json());
  
  // CORS for development
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Serve static files from public directory
  const publicPath = resolve(process.cwd(), 'src/public');
  app.use(express.static(publicPath));

  // API routes
  app.use('/api', routes);
  app.use('/api/live', liveRoutes);

  // Serve pages
  app.get('/', (_req, res) => {
    res.sendFile(resolve(publicPath, 'index.html'));
  });
  
  app.get('/live', (_req, res) => {
    res.sendFile(resolve(publicPath, 'live.html'));
  });

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`\nServer running at http://localhost:${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
    console.log(`Dashboard at http://localhost:${PORT}\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => {
      closeDb();
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

