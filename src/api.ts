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

import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { PNG } from 'pngjs';

import { isRunner, requireAdmin, requireRunner } from './middleware/auth';
import { createLimiters } from './middleware/rateLimiter';
import { assert } from './assert';
import { printAudit } from './audit';
import { Config, saveComparisonThreshold } from './configuration';
import {
  databaseIsHealthy,
  findImageByHash,
  HashedImage,
  insertTestRun,
  inTransaction,
  latestTestRecords,
  latestTestRun,
  setReferencePointer,
  testHistory,
  testRunExists,
  testRunLog,
  updateTestRun
} from './database';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnauthorizedError,
  ValidationError
} from './errors';
import {
  candidateImage,
  differenceImage,
  hasReferenceImage,
  newReferenceImagePath,
  referenceImage,
  removeFolderIfEmpty,
  testPath,
  testReferenceImage,
  thumbnailForImage
} from './globals';
import {
  compareImages,
  createThumbnail,
  decodeUploadedPng,
  pixelHash,
  readPng,
  resolutionMismatch
} from './image';
import { testLockKey, TestLocks } from './lock';
import { ProjectRoot } from './paths';
import { isRegenerating, startRegeneration, TestData } from './testrecords';
import {
  CompareParamsSchema,
  DefaultApplication,
  HistoryParamsSchema,
  MaxFutureOffset,
  MaxImageDimension,
  parse,
  ResultParamsSchema,
  RunTestSchema,
  SubmitTestSchema,
  ThresholdSchema,
  UpdateReferenceSchema
} from './validation';

/**
 * The number of most recent test runs per test that are returned by the
 * `/api/test-records` API call. The frontend uses these to show the trend of the latest
 * test runs; the full history of a test is available through `/api/test-history`
 */
const SummaryRunCount = 5;

/**
 * The largest file that can be uploaded (in bytes). An uncompressed 16384x16384 RGBA
 * image is 1 GiB, so this leaves a margin of 25% for the PNG overhead.
 */
const MaxUploadBytes = 1280 * 1024 * 1024;

/**
 * The largest log file that can be submitted with a test run (in bytes)
 */
const MaxLogBytes = 64 * 1024 * 1024;

/**
 * The multipart parser for the API calls that receive images. Files are kept in memory, as
 * they have to be decoded anyway. If the `runnerID` is sent before the files, which is the
 * case for the usual HTTP clients, requests with an invalid runner ID are rejected before
 * the files are received.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MaxUploadBytes, files: 2, fields: 20, fieldSize: 64 * 1024 },
  fileFilter: (req, _file, callback) => {
    const { body }: { body: unknown } = req;
    const runnerID =
      typeof body === 'object' && body != null && 'runnerID' in body
        ? body.runnerID
        : undefined;
    if (runnerID !== undefined && !isRunner(runnerID)) {
      printAudit(`Rejected runner request ${req.method} ${req.path} from ${req.ip}`);
      callback(new UnauthorizedError('Invalid or missing runner ID'));
      return;
    }
    callback(null, true);
  }
});

/**
 * Throws a ValidationError if the `application` is not one of the configured
 * applications.
 *
 * @param application The application that was provided in the request
 */
function requireApplication(application: string) {
  if (!Config.hasApplication(application)) {
    throw new ValidationError(`Unknown application ${application} provided`);
  }
}

/**
 * Checks that the `image` has the size that is required for the `application`. Images
 * of applications without a fixed size are not checked.
 *
 * @param application The application that generated the image
 * @param image The image that should be checked
 */
function requireApplicationSize(application: string, image: PNG) {
  const size = Config.applicationSize(application);
  if (size != null && (image.width != size.width || image.height != size.height)) {
    throw new ValidationError(
      `Image has the wrong size. Expected (${size.width}, ${size.height}), got ` +
        `(${image.width}, ${image.height})`
    );
  }
}

/**
 * Sends the provided difference image to the client. The ratio of changed pixels is sent
 * in the `Result` and the `X-Pixel-Error` headers.
 */
function sendDifference(res: express.Response, image: PNG, error: number) {
  res
    .status(200)
    .type('png')
    .set({
      Result: String(error),
      'X-Pixel-Error': String(error),
      'Cache-Control': 'no-store',
      'Access-Control-Expose-Headers': 'Result, X-Pixel-Error'
    })
    .send(PNG.sync.write(image));
}

/**
 * Registers the routes for the available API calls.
 *
 * @param app The express application to which the routes should be registered
 */
export function registerRoutes(app: express.Application) {
  const limiters = createLimiters();
  const json = express.json({ limit: '16kb' });

  app.get('/api', handleApi);
  // The canonical result routes include the application as part of the URL
  app.get(
    '/api/result/:type/:application/:group/:name/:hardware{/:timestamp}',
    handleResult
  );
  // The legacy result routes (without the application segment) are kept permanently and
  // resolve to the "openspace" application so that existing external URLs keep working
  app.get('/api/result/:type/:group/:name/:hardware{/:timestamp}', handleResultLegacy);
  app.get(
    '/api/compare/:type/:application/:group/:name/:hardware1/:hardware2',
    limiters.compare,
    handleCompare
  );
  app.get(
    '/api/compare/:type/:group/:name/:hardware1/:hardware2',
    limiters.compare,
    handleCompareLegacy
  );
  app.get('/api/test-records', handleTestRecords);
  app.get('/api/test-history/:application/:group/:name/:hardware', handleTestHistory);
  app.get('/api/config', handleConfig);
  app.get('/api/health', handleHealth);
  app.get('/api/diff-threshold', handleThreshold);
  app.post(
    '/api/update-diff-threshold',
    limiters.admin,
    requireAdmin,
    json,
    handleChangeThreshold
  );
  app.post(
    '/api/submit-test',
    limiters.runner,
    upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'log', maxCount: 1 }
    ]),
    requireRunner,
    handleSubmitTest
  );
  app.post(
    '/api/run-test',
    limiters.runner,
    upload.single('file'),
    requireRunner,
    handleRunTest
  );
  app.post(
    '/api/update-reference',
    limiters.admin,
    requireAdmin,
    json,
    handleUpdateReference
  );
}

/**
 * Returns a list of all available API endpoints.
 */
function handleApi(_req: express.Request, res: express.Response) {
  const mib = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;
  res.status(200).json([
    { path: '/api', description: 'This page describing all available API calls' },
    {
      path: '/api/result/:type/:application/:group/:name/:hardware/:timestamp?',
      description: `Returns the result for a specific 'type', 'application', 'group',
        'name', and 'hardware'. The 'timestamp' parameter is optional and if it is
        omitted, the latest image is used. The 'timestamp' does not have to match a test
        exactly; if no test ran at that exact time, the latest test that ran before it is
        returned instead. The timestamp has to be an ISO 8601 date and time, and a
        timestamp that does not name a timezone is interpreted as UTC. The timestamp of
        the test that was actually used is returned in the 'Timestamp' response header.
        The type must be either 'reference', 'candidate', 'difference',
        "reference-thumbnail", "candidate-thumbnail", "difference-thumbnail", or "log".
        For all but the last option, the result will be an image file, for the "log"
        option, the result will be a text file.`
    },
    {
      path: '/api/result/:type/:group/:name/:hardware/:timestamp?',
      description: `Legacy version of the result API that does not include the
        'application' in the URL. This route is kept permanently for compatibility and
        resolves to the "openspace" application.`
    },
    {
      path: '/api/compare/:type/:application/:group/:name/:hardware1/:hardware2',
      description: `Generates a new comparison image that takes either the reference
        images or the candidate images for two hardware setups for the same test and runs
        a comparison image on those. These images are not cached and thus this API call
        will take some time to finish. The 'type' must be either "reference" or
        "candidate". The ratio of changed pixels is returned in the 'Result' and
        'X-Pixel-Error' response headers. This call is rate limited.`
    },
    {
      path: '/api/compare/:type/:group/:name/:hardware1/:hardware2',
      description: `Legacy version of the compare API that does not include the
        'application' in the URL. This route is kept permanently for compatibility and
        resolves to the "openspace" application.`
    },
    {
      path: '/api/test-records',
      description: `Returns all of the tests as a JSON object. For each test, only the
        ${SummaryRunCount} most recent test results are included`
    },
    {
      path: '/api/test-history/:application/:group/:name/:hardware',
      description: `Returns all of the test results for a specific 'application',
        'group', 'name', and 'hardware' as a JSON object, sorted by their timestamp`
    },
    {
      path: '/api/config',
      description: `Returns the configuration values that are relevant for the frontend:
        the preferred hardware and the applications with their source repositories`
    },
    {
      path: '/api/health',
      description: `Returns whether the server and its database are working (status 200)
        or not (status 503), together with the version of the server`
    },
    {
      path: '/api/diff-threshold',
      description: `Returns the current difference threshold used for image comparisons
        and whether the test results are currently being regenerated`
    },
    {
      path: '/api/update-diff-threshold',
      description: `(Requires admin) Changes the threshold and recalculates all of the
        difference images with it in the background. The admin token has to be sent in an
        'Authorization: Bearer <token>' header. The JSON object in the body must contain
        the 'threshold' value as a number between 0 and 1 that is the new error
        threshold. Returns status 202 once the recalculation has started and status 409
        if a recalculation is already running.`
    },
    {
      path: '/api/submit-test',
      description: `(Requires runner) This will submit a new test to the image testing
        server. The multipart-encoded body of the message must contain a 'runnerID',
        'hardware', 'group', 'name', 'timestamp', 'timing', and 'commitHash'. The
        'runnerID' must be one of the allowed runners setup for this server and should be
        sent before the files. Optionally, the body can contain an 'application' field
        that names the application that generated the test. If this field is omitted, the
        test is attributed to the "openspace" application. The 'hardware', 'group',
        'name', and 'application' must start with a letter or digit and may only contain
        letters, digits, '.', '_', and '-'. Furthermore, there needs to be the candidate
        image as a PNG file in the 'file' field (at most ${MaxImageDimension}x${MaxImageDimension}
        pixels and ${mib(MaxUploadBytes)}) and the log of the test run in the 'log'
        field (at most ${mib(MaxLogBytes)}). A test run with the same timestamp must
        not exist yet, otherwise status 409 is returned.`
    },
    {
      path: '/api/run-test',
      description: `(Requires runner) This will run a comparison against the current
        reference image on the server without storing the results. The multipart-encoded
        body of the message must contain a 'runnerID', 'hardware', 'group', and 'name'.
        Optionally, the body can contain an 'application' field that names the
        application that generated the test. If this field is omitted, the test is
        attributed to the "openspace" application. Furthermore, there needs to be the
        candidate image as a PNG file in the 'file' field. The API returns the
        difference image and the ratio of changed pixels in the 'Result' and
        'X-Pixel-Error' response headers.`
    },
    {
      path: '/api/update-reference',
      description: `(Requires admin) Makes the candidate image of the latest test run of a
        specific test the new reference image. The admin token has to be sent in an
        'Authorization: Bearer <token>' header. The JSON object in the body must provide
        the 'hardware', 'group', and 'name' of the test whose reference should be
        updated. Optionally, the body can contain an 'application' field that names the
        application that generated the test. If this field is omitted, the test is
        attributed to the "openspace" application.`
    }
  ]);
}

/**
 * Returns a single requested result for the application that is provided in the URL. If
 * the application is not known, the URL might be a legacy URL that contains a timestamp,
 * so the request is passed on to the legacy route.
 */
function handleResult(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const { application } = req.params;
  if (typeof application !== 'string' || !Config.hasApplication(application)) {
    next('route');
    return;
  }
  serveResult(res, req.params);
}

/**
 * Returns a single requested result for the "openspace" application. This is the legacy
 * version of the result API that is kept permanently for compatibility with existing
 * external URLs.
 */
function handleResultLegacy(req: express.Request, res: express.Response) {
  serveResult(res, { ...req.params, application: DefaultApplication });
}

/**
 * Returns a single requested result. The URL parameters used for this function are:
 *  - `type`: One of "reference", "candidate", "difference", "reference-thumbnail",
 *            "candidate-thumbnail", "difference-thumbnail", or "log"
 *  - `application`: The name of the application that generated the test
 *  - `group`: The name of the test's group for which to return the image
 *  - `name`: The name of the test for which to return the image
 *  - `hardware`: The test's hardware for which to return the image
 *  - `timestamp`: The timestamp of the test for which to return the image. This is an
 *                 optional parameter. If it is left out, the latest result for the
 *                 specified type will be returned. If no test exists for the exact
 *                 timestamp, the latest test that ran at or before it is used instead
 */
function serveResult(res: express.Response, params: unknown) {
  const { type, application, group, name, hardware, timestamp } = parse(
    ResultParamsSchema,
    params
  );
  requireApplication(application);

  // If the request did not have any timestamp we are interested in the latest test.
  // Otherwise we are looking for the test at the requested time or, if no test ran at
  // that exact time, the latest test that ran before it
  const data = latestTestRun(application, group, name, hardware, timestamp);
  if (data == null) {
    throw new NotFoundError(
      `No test run found for ${application}/${group}/${name}/${hardware}`
    );
  }

  // Let the caller know which test this result actually belongs to, which might be an
  // earlier one than the timestamp that was requested
  const headers = { Timestamp: data.timeStamp.toISOString() };

  if (type == 'log') {
    const log = testRunLog(application, group, name, hardware, data.timeStamp);
    res
      .status(200)
      .type('text/plain')
      .set(headers)
      .send(log ?? '');
    return;
  }

  let file = '';
  let isThumbnail = false;
  switch (type) {
    case 'reference-thumbnail':
      isThumbnail = true;
    // falls through
    case 'reference':
      file = testReferenceImage(application, group, name, hardware, data);
      break;
    case 'candidate-thumbnail':
      isThumbnail = true;
    // falls through
    case 'candidate':
      file = candidateImage(application, group, name, hardware, data);
      break;
    case 'difference-thumbnail':
      isThumbnail = true;
    // falls through
    case 'difference':
      file = differenceImage(application, group, name, hardware, data);
      break;
    default:
      break;
  }

  if (isThumbnail) {
    file = thumbnailForImage(file);
  }
  if (!fs.existsSync(file)) {
    throw new NotFoundError('The requested image does not exist');
  }
  // The paths only contain validated names, so dot files can only appear in the path of
  // the data folder itself, which has to be allowed
  res.sendFile(path.resolve(file), { headers: headers, dotfiles: 'allow' });
}

/**
 * Generates a new comparison image for the application that is provided in the URL.
 */
function handleCompare(req: express.Request, res: express.Response) {
  serveCompare(res, req.params);
}

/**
 * Generates a new comparison image for the "openspace" application. This is the legacy
 * version of the compare API that is kept permanently for compatibility with existing
 * external URLs.
 */
function handleCompareLegacy(req: express.Request, res: express.Response) {
  serveCompare(res, { ...req.params, application: DefaultApplication });
}

/**
 * Generates a new comparison image that takes either the reference images or the
 * candidate images for two hardware setups for the same test and runs a comparison image
 * on those. The image is generated in memory and is not cached. The URL parameters used
 * for this function are:
 *  - `type`: Must be either "reference" or "candidate"
 *  - `application`: The name of the application that generated the test
 *  - `group`: The name of the test's group for which to return the comparison
 *  - `name`: The name of the test for which to return the comparison
 *  - `hardware1`: The first hardware for which to return the comparison.
 *  - `hardware2`: The second hardware for which to return the comparison
 */
function serveCompare(res: express.Response, params: unknown) {
  const { type, application, group, name, hardware1, hardware2 } = parse(
    CompareParamsSchema,
    params
  );
  requireApplication(application);

  let file1;
  let file2;
  if (type == 'reference') {
    if (
      !hasReferenceImage(application, group, name, hardware1) ||
      !hasReferenceImage(application, group, name, hardware2)
    ) {
      throw new NotFoundError(`No reference image for ${hardware1} or ${hardware2}`);
    }
    file1 = referenceImage(application, group, name, hardware1);
    file2 = referenceImage(application, group, name, hardware2);
  } else {
    const data1 = latestTestRun(application, group, name, hardware1);
    const data2 = latestTestRun(application, group, name, hardware2);
    if (data1 == null || data2 == null) {
      throw new NotFoundError(`No test found for ${hardware1} or ${hardware2}`);
    }
    file1 = candidateImage(application, group, name, hardware1, data1);
    file2 = candidateImage(application, group, name, hardware2, data2);
  }

  if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
    throw new NotFoundError('The images of these tests do not exist');
  }

  const image1 = readPng(file1);
  const image2 = readPng(file2);
  const comparison = compareImages(image1, image2);
  if (comparison == null) {
    throw new ValidationError(
      `Resolution mismatch: ${image1.width}x${image1.height} vs ` +
        `${image2.width}x${image2.height}`
    );
  }
  sendDifference(res, comparison.image, comparison.error);
}

/**
 * Returns a full list of the tests to the API caller. Each test only contains its most
 * recent test runs. This API call has no further parameters.
 */
function handleTestRecords(_req: express.Request, res: express.Response) {
  res.status(200).json(latestTestRecords(SummaryRunCount));
}

/**
 * Returns all of the test runs of a single test, sorted by their timestamp. The URL
 * parameters used for this function are:
 *  - `application`: The name of the application that generated the test
 *  - `group`: The name of the test's group for which to return the test runs
 *  - `name`: The name of the test for which to return the test runs
 *  - `hardware`: The test's hardware for which to return the test runs
 */
function handleTestHistory(req: express.Request, res: express.Response) {
  const { application, group, name, hardware } = parse(HistoryParamsSchema, req.params);
  requireApplication(application);

  const history = testHistory(application, group, name, hardware);
  if (history.length == 0) {
    throw new NotFoundError(
      `No test found for ${application}/${group}/${name}/${hardware}`
    );
  }

  res.status(200).json(history);
}

/**
 * Returns the frontend-relevant configuration values
 */
function handleConfig(_req: express.Request, res: express.Response) {
  res.status(200).json({
    preferredHardware: Config.preferredHardware,
    applications: Config.applications.map((app) => ({
      name: app.name,
      repository: app.repository
    }))
  });
}

/**
 * The version of the server, which is taken from the package.json
 */
let Version: string | null = null;

/**
 * Health check endpoint for monitoring
 */
function handleHealth(_req: express.Request, res: express.Response) {
  if (Version == null) {
    const packageFile = path.join(ProjectRoot, 'package.json');
    Version = JSON.parse(fs.readFileSync(packageFile, 'utf-8')).version as string;
  }

  const healthy = databaseIsHealthy();
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    version: Version,
    regenerating: isRegenerating()
  });
}

/**
 * Returns the current threshold value used for image comparisons
 */
function handleThreshold(_req: express.Request, res: express.Response) {
  res
    .status(200)
    .json({ value: Config.comparisonThreshold, regenerating: isRegenerating() });
}

/**
 * This API call updates the threshold value used to determine which pixels of a candidate
 * image have changed. Setting this value will cause all difference images and test
 * results to be recalculated in the background. The changed threshold value is then also
 * used for all upcoming tests. This API call requires the admin token. The payload of this
 * call must be a JSON object with the following values:
 *   - `threshold`: The new threshold as a number between 0 and 1
 */
function handleChangeThreshold(req: express.Request, res: express.Response) {
  const { threshold } = parse(ThresholdSchema, req.body);
  if (isRegenerating()) {
    throw new ConflictError('The test results are already being regenerated');
  }

  printAudit(
    `Changing image comparison threshold to ${threshold} (requested by ${req.ip})`
  );
  saveComparisonThreshold(threshold);
  startRegeneration();
  res.status(202).json({ regenerating: true });
}

/**
 * The values that identify a single test run
 */
type RunKey = {
  application: string;
  group: string;
  name: string;
  hardware: string;
  timestamp: Date;
};

/**
 * Stores a candidate or difference image of the test run identified by `run`. If an image
 * with identical pixels is already used by an earlier test run of the same test, that
 * image is reused instead of storing another copy.
 *
 * @param kind Whether the image is a candidate or a difference image
 * @param run The test run to which the image belongs
 * @param buffer The contents of the PNG file
 * @param created The list of files created by the current operation, to which the newly
 *        written files are added so that they can be removed if the operation fails
 * @returns The timestamp of the test run in whose folder the image is stored and the
 *          `pixelHash` of the image
 */
async function storeImage(
  kind: HashedImage,
  run: RunKey,
  buffer: Buffer,
  created: string[]
): Promise<{ owner: Date; hash: string }> {
  const { application, group, name, hardware, timestamp } = run;

  const hash = await pixelHash(buffer);
  const owner = findImageByHash(kind, application, group, name, hardware, hash);
  if (
    owner != null &&
    fs.existsSync(`${testPath(application, group, name, hardware, owner)}/${kind}.png`)
  ) {
    return { owner: owner, hash: hash };
  }

  const folder = testPath(application, group, name, hardware, timestamp);
  fs.mkdirSync(folder, { recursive: true });
  const file = `${folder}/${kind}.png`;
  for (const f of [file, thumbnailForImage(file)]) {
    if (!fs.existsSync(f)) {
      created.push(f);
    }
  }
  fs.writeFileSync(file, buffer);
  await createThumbnail(file);
  return { owner: timestamp, hash: hash };
}

/**
 * Removes the files that were created by an operation that failed.
 *
 * @param created The files that were created by the operation
 */
function removeCreatedFiles(created: string[]) {
  for (const file of [...created].reverse()) {
    fs.rmSync(file, { force: true });
    removeFolderIfEmpty(path.dirname(file));
  }
}

/**
 * This API call is made when a new test result is submitted. The necessary test
 * information is passed along as a multipart-encoded body together with the files.
 *
 * For the body, the required fields are:
 *   - `runnerID`: One of the allowed runners that are provided in the configuration file
 *   - `hardware`: The hardware on which the test was run
 *   - `group`: The name for the test's group for which a candidate is submitted
 *   - `name`: The name of the test for which a candidate is submitted
 *   - `timestamp`: The time stamp of the test run for which a candidate is submitted
 *   - `timing`: The number of seconds that it took to run this test
 *   - `commitHash`: The commit hash of the code that was used to generated the candidate
 *
 * For the body, the following field is optional:
 *   - `application`: The name of the application that generated the test. If this field
 *     is omitted, the test is attributed to the "openspace" application
 *
 * For the files, the following are needed:
 *   - `file`: The generated candidate file
 *   - `log`: The log file of the test run
 */
async function handleSubmitTest(req: express.Request, res: express.Response) {
  const body = parse(SubmitTestSchema, req.body);
  const { application, timestamp } = body;
  requireApplication(application);
  if (timestamp.getTime() > Date.now() + MaxFutureOffset) {
    throw new ValidationError(
      `The timestamp ${timestamp.toISOString()} lies in the future`
    );
  }

  const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
  const file = files['file']?.[0];
  if (file == null) {
    throw new ValidationError("Missing file 'file'");
  }
  const log = files['log']?.[0];
  if (log == null) {
    throw new ValidationError("Missing file 'log'");
  }
  if (log.size > MaxLogBytes) {
    throw new PayloadTooLargeError(
      `The log file is too large, it can be at most ${MaxLogBytes} bytes`
    );
  }

  const candidate = decodeUploadedPng(file.buffer);
  requireApplicationSize(application, candidate);

  const logContent = log.buffer
    .toString()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n');
  const nLogLines = logContent === '' ? 0 : logContent.split('\n').length;

  const { group, name, hardware } = body;
  await TestLocks.run(testLockKey(application, group, name, hardware), () =>
    storeTestRun({
      ...body,
      file: file.buffer,
      candidate: candidate,
      log: logContent,
      nErrors: nLogLines
    })
  );
  res.status(200).end();
}

/**
 * Stores a submitted test run. This has to be called while holding the lock of the test.
 */
async function storeTestRun(run: {
  application: string;
  group: string;
  name: string;
  hardware: string;
  timestamp: Date;
  timing: number;
  commitHash: string;
  file: Buffer;
  candidate: PNG;
  log: string;
  nErrors: number;
}) {
  const { application, group, name, hardware, timestamp } = run;
  const test = `${application}/${group}/${name}/${hardware}`;

  if (testRunExists(application, group, name, hardware, timestamp)) {
    throw new ConflictError(
      `A test run for ${test} at ${timestamp.toISOString()} already exists`
    );
  }

  // The comparison is done before any file is written so that a rejected candidate does
  // not leave any files behind. If there is no reference yet, the candidate becomes the
  // reference image
  const hasReference = hasReferenceImage(application, group, name, hardware);
  let reference = hasReference
    ? referenceImage(application, group, name, hardware)
    : null;
  const referencePng = reference ? readPng(reference) : run.candidate;
  const comparison = compareImages(referencePng, run.candidate);
  if (comparison == null) {
    throw new ValidationError(resolutionMismatch(referencePng, run.candidate));
  }

  printAudit(`Submitting result for (${test}/${timestamp.toISOString()})`);

  const created: string[] = [];
  try {
    if (reference == null) {
      printAudit('  No reference image found');
      // We are either the first, or someone has marked the previous reference as not valid
      reference = newReferenceImagePath(application, group, name, hardware, timestamp);
      created.push(reference, thumbnailForImage(reference));
      fs.writeFileSync(reference, run.file);
      await createThumbnail(reference);
    }

    // Images that already exist in previous test runs are reused instead of being stored
    // a second time. If both images already existed, this test run does not have a folder
    const candidate = await storeImage('candidate', run, run.file, created);
    const difference = await storeImage(
      'difference',
      run,
      PNG.sync.write(comparison.image),
      created
    );

    const data: TestData = {
      pixelError: comparison.error,
      timeStamp: timestamp,
      timing: run.timing,
      nErrors: run.nErrors,
      commitHash: run.commitHash,
      referenceImage: path.basename(reference),
      candidateImage: candidate.owner,
      differenceImage: difference.owner
    };

    const referenceFile = path.basename(reference);
    inTransaction(() => {
      if (!hasReference) {
        setReferencePointer(application, group, name, hardware, referenceFile);
      }
      insertTestRun(application, group, name, hardware, data, run.log, {
        candidate: candidate.hash,
        difference: difference.hash
      });
    });
  } catch (e: unknown) {
    removeCreatedFiles(created);
    throw e;
  }

  printAudit(`  Added test run for (${test})`);
}

/**
 * This API call runs a single test against the current reference image and returns the
 * difference image back to the caller. The results of this comparison are _not_ stored on
 * the server. The necessary test information is passed along as a multipart-encoded body
 * together with the file.
 *
 * For the body, the required fields are:
 *   - `runnerID`: One of the allowed runners that are provided in the configuration file
 *   - `hardware`: The hardware on which the test was run
 *   - `group`: The name for the test's group for which a candidate is submitted
 *   - `name`: The name of the test for which a candidate is submitted
 *
 * For the body, the following field is optional:
 *   - `application`: The name of the application that generated the test. If this field
 *     is omitted, the test is attributed to the "openspace" application
 *
 * For the files, the following are needed:
 *   - `file`: The generated candidate file
 */
function handleRunTest(req: express.Request, res: express.Response) {
  const { application, group, name, hardware } = parse(RunTestSchema, req.body);
  requireApplication(application);

  if (req.file == null) {
    throw new ValidationError("Missing file 'file'");
  }
  const candidate = decodeUploadedPng(req.file.buffer);
  requireApplicationSize(application, candidate);

  if (!hasReferenceImage(application, group, name, hardware)) {
    throw new NotFoundError('Error comparing, no reference image found');
  }

  const reference = readPng(referenceImage(application, group, name, hardware));
  const comparison = compareImages(reference, candidate);
  if (comparison == null) {
    throw new ValidationError(resolutionMismatch(reference, candidate));
  }
  sendDifference(res, comparison.image, comparison.error);
}

/**
 * Updates the current reference for a specific test. The latest candidate image will be
 * upgraded to a reference image and the latest test will be updated to reflect this. This
 * API call requires the admin token. The payload of this call must be a JSON object with
 * the following values:
 *   - `hardware`: The hardware for which to update the reference image
 *   - `group`: The name of the test's group for which to update the reference image
 *   - `name`: The name of the test for which to update the reference image
 *   - `application`: (optional) The name of the application that generated the test. If
 *     this field is omitted, the test is attributed to the "openspace" application
 */
async function handleUpdateReference(req: express.Request, res: express.Response) {
  const { application, group, name, hardware } = parse(UpdateReferenceSchema, req.body);
  requireApplication(application);

  await TestLocks.run(testLockKey(application, group, name, hardware), () =>
    promoteLatestCandidate(application, group, name, hardware, req.ip ?? 'unknown')
  );
  res.status(200).end();
}

/**
 * Makes the candidate image of the latest test run the new reference image of the test.
 * This has to be called while holding the lock of the test.
 */
async function promoteLatestCandidate(
  application: string,
  group: string,
  name: string,
  hardware: string,
  requester: string
) {
  const data = latestTestRun(application, group, name, hardware);
  if (data == null) {
    // We tried to update the reference image for a test that did not exist
    throw new NotFoundError(
      `No test found for (${application}, ${group}, ${name}, ${hardware})`
    );
  }

  const candidateFile = candidateImage(application, group, name, hardware, data);
  assert(fs.existsSync(candidateFile), `Candidate image ${candidateFile} does not exist`);

  printAudit(
    `Updating reference for (${application}, ${group}, ${name}, ${hardware}) ` +
      `requested by ${requester}`
  );

  // The new reference image is named after the timestamp of the latest test
  const newReference = newReferenceImagePath(
    application,
    group,
    name,
    hardware,
    data.timeStamp
  );

  const created: string[] = [];
  try {
    // Make the last candidate image the new reference image by copying it over. If the
    // file already exists, the same test run was promoted before and the file is identical
    if (!fs.existsSync(newReference)) {
      created.push(newReference);
      fs.copyFileSync(candidateFile, newReference);
    }
    if (!fs.existsSync(thumbnailForImage(newReference))) {
      created.push(thumbnailForImage(newReference));
      await createThumbnail(newReference);
    }

    // The difference image of the candidate is now out of date. Since the candidate is the
    // reference, the comparison cannot fail because of mismatching sizes
    const candidate = readPng(candidateFile);
    const comparison = compareImages(candidate, candidate);
    assert(comparison != null, 'Comparing the candidate with itself failed');
    const difference = await storeImage(
      'difference',
      { application, group, name, hardware, timestamp: data.timeStamp },
      PNG.sync.write(comparison.image),
      created
    );

    inTransaction(() => {
      setReferencePointer(
        application,
        group,
        name,
        hardware,
        path.basename(newReference)
      );
      updateTestRun(
        application,
        group,
        name,
        hardware,
        {
          ...data,
          pixelError: comparison.error,
          referenceImage: path.basename(newReference),
          differenceImage: difference.owner
        },
        difference.hash
      );
    });
  } catch (e: unknown) {
    removeCreatedFiles(created);
    throw e;
  }
}
