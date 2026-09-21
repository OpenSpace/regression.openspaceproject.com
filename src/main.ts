import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';

import { registerRoutes } from './api';
import { initializeAudit } from './audit';
import { Config, loadConfiguration } from './configuration';
import { loadTestResults, verifyDataFolder } from './testrecords';
import { initializeErrorReporting, errorHandler, asyncHandler } from './errorHandling';
import { validateConfig, validatePaths } from './configValidation';

export function main() {
  try {
    // Validate and load configuration
    const configData = validateConfig('config.json');
    loadConfiguration('config.json');

    // Validate paths
    validatePaths(Config.data);

    // Create the data folder infrastructure
    fs.mkdirSync(Config.data, { recursive: true });
    fs.mkdirSync(`${Config.data}/tests`, { recursive: true });
    fs.mkdirSync(`${Config.data}/reference`, { recursive: true });
    fs.mkdirSync(`${Config.data}/temporary`, { recursive: true });
    fs.mkdirSync(`${Config.data}/temporary/compare`, { recursive: true });

    // Initialize error reporting
    initializeErrorReporting();

    initializeAudit();
    verifyDataFolder();
    loadTestResults();

    const app = express();
    app.use(cors({ origin: Config.corsOrigins }));

    registerRoutes(app);
    app.use('/common', express.static('public/common'));
    app.use(express.static('dist'));
    app.use((_req, res) => {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    });

    // The error handler has to be registered after the routes, as Express only forwards
    // errors to handlers that come later in the middleware chain
    app.use(errorHandler);

    console.log(`Listening on port: ${Config.port}`);
    app.listen(Config.port);
  } catch (err: any) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}
