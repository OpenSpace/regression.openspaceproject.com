/*****************************************************************************************
 *                                                                                       *
 * OpenSpace Visual Testing                                                              *
 *                                                                                       *
 * Copyright (c) 2024-2026                                                               *
 *                                                                                       *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this  *
 * software and associated documentation files (the "Software"), to deal in the Software *
 * without restriction, including without limitation the rights to use, copy, modify,    *
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to    *
 * permit persons to whom the Software is furnished to do so, subject to the following   *
 * conditions:                                                                           *
 *                                                                                       *
 * The above copyright notice and this permission notice shall be included in all copies *
 * or substantial portions of the Software.                                              *
 *                                                                                       *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,   *
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A         *
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT    *
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF  *
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE  *
 * OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                                         *
 ****************************************************************************************/

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'path';

import { registerRoutes } from './api';
import { Config } from './configuration';
import { errorHandler } from './errorHandling';
import { NotFoundError } from './errors';
import { ProjectRoot } from './paths';

/**
 * Creates the Express application with all routes and middleware. The configuration has
 * to be loaded and the database has to be opened before this function is called.
 *
 * @returns The Express application
 */
export function createApp(): express.Express {
  const app = express();

  // The server runs behind a single reverse proxy, which provides the client's address
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // Mantine uses inline styles and the frontend loads its font from Google Fonts
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
          // The comparison images on the compare page are shown as blob URLs
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'self'"],
          'upgrade-insecure-requests': null
        }
      },
      // Allow other sites (for example GitHub issues) to embed the result images
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );
  if (Config.corsOrigins != null) {
    app.use(cors({ origin: Config.corsOrigins }));
  }

  registerRoutes(app);
  app.use('/api', () => {
    throw new NotFoundError('Unknown API endpoint');
  });

  app.use(
    '/common',
    express.static(path.join(ProjectRoot, 'public', 'common'), { fallthrough: false })
  );
  const frontend = path.join(ProjectRoot, 'dist');
  app.use(express.static(frontend));
  // All other pages are handled by the frontend's router
  app.get('/{*path}', (req, res, next) => {
    if (!req.accepts('html')) {
      next();
      return;
    }
    res.sendFile(path.join(frontend, 'index.html'));
  });
  app.use(() => {
    throw new NotFoundError('Not found');
  });

  // The error handler has to be registered after the routes, as Express only forwards
  // errors to handlers that come later in the middleware chain
  app.use(errorHandler);
  return app;
}
