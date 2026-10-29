# VisualTesting
The visual testing infrastructure is split into two components that are both described in this document. The goal for this infrastructure is to be able to consistently run regression tests against OpenSpace to ensure that the visual quality of the `master` branch does not change over time, thus preventing bugs. It is also useful as a repository of in-game images from OpenSpace that can be used to show what features OpenSpace has.

Important terms to understand the testing results:

| Term | Description |
| ---- | ----------- |
| Application | The application that generated the test images. All images from different applications are stored and displayed separately so that they do not mix. The currently supported applications are "openspace" (the OpenSpace application, fixed 1920x1080 images) and "sgct" (the SGCT library, images of varying resolutions). The list of applications is configured in the `applications` array of the `config.json`. |
| Group | A group combines several tests into a logical unit where it makes sense that individual tests are collected. Groups, for example, can be individual profiles or usage scenarios, or describe the intended usecase for the generated images. The group names in general are extracted from the folder structure of the visual test files in the OpenSpace folder. |
| Name | The name of an individual test inside a group. The combination of "Group" + "Name" should be considered the full name of the test, so if the group mentioned "Apollo 11", there is no need to separately mention "Apollo 11" in the name of the test again. The name of a test has to be unique within a group but can be reused between groups. For example, there can only be one "landing" test inside the "Apollo 11" group, but there might be a "landing" test inside both the "Apollo 12" and the "Apollo 11" groups. |
| Hardware | The description of a hardware setup that was used to run a specific test. For regular test runners, this name should be of the form "operating system"-"graphics card vendor", for example "windows-nvidia", "linux-nvidia", "windows-amd", etc. |
| Reference image | A known, good image that has been vetted as a reference for future images. Any future deviation from this reference image will be considered an error. It is possible to update the reference image to the latest candidate image on the webpage using an administrative password. There is always at least one reference image for each application+group+name+hardware combination, but multiple reference are kept over time, if legitimate changes to the reference image had to be made. |
| Candidate image | A newly created image that is tested against the current reference image. This test generates a difference image and an error score. |
| Difference image | An image that shows the pixel differences between the reference image and a candidate image. |


## Backend
The _backend_ is a Typescript-based server that is receiving individual tests, creating comparison images, and making past tests available via a website. By default this server is located at [https://regression.openspaceproject.com](https://regression.openspaceproject.com), but it is also possible to run a local copy of it.

To run the regression server locally:

  1. Run `npm install` in the root folder of this repository to install all required packages
  1. Run `npm run build` to build the frontend (into `dist`) and to compile the backend (into `out`)
  1. Duplicate the `config.sample.json` into `config.json` and the `.env.example` into `.env`. The port of the server is set with the `PORT` variable in the `.env` file
  1. Set the `ADMIN_TOKEN` in the `.env` file to a long, random value. The server refuses to start without an admin token
  1. Add at least one runner id to the `runners` array in the `config.json`. Without one, the server starts, but no tests can be submitted
  1. Run `npm run server` to start the hosting of the regression server
  1. Visit `localhost:8000` (or whichever `PORT` was configured in the `.env`) and an empty webpage should be visible

The runner ids have to be provided by the _Runners_ when they submit tests, so they should be treated like passwords. The test results are always stored in the `data` folder next to the `config.json`.

For development, `npm run dev` starts the backend (restarting it whenever a file in `src` changes) together with the Vite development server of the frontend, which forwards all API calls to the backend. `npm test` runs the automated tests and `npm run lint` checks the formatting and the code style.

The server expects to run behind exactly one reverse proxy (for example nginx), from which it takes the client's IP address for the rate limiting and the audit log. If the server is reachable without a proxy, clients could fake their address and work around the rate limiting.

The webpage provides access to the previous test results. The main panel is the table view in the center that shows all tests that have been run sorted by their error score. For each test, the latest score, application, group, name, hardware, how long it took to run the test, which commit of OpenSpace was used to generated the test, the timestamp at which the test was run, and the reference, candidate, and difference images for the latest test are shown. The tests can be filtered by application and by hardware using the checkboxes (or the dropdowns) in the control bar at the top. By clicking on an entry, the entire test history is available. In this detail view the most recent image (on the left) also has an "Upgrade Candidate to Reference" image button, which will set the latest Candidate Image to be the new Reference image. **Note**: This should only be done when it is clear that a change in OpenSpace _improved_ the rendering. It should not be done just to silence an error message. Also note that this action can only be done after entering the "Admin" password in the header at the top of the site. If Jenkins is configured (see [Rerunning tests](#rerunning-tests)), the "Rerun Test" button starts a Jenkins job that builds OpenSpace, either at the commit of the latest test run or at the latest commit, and runs only that test again on the same hardware. The result shows up in the history once the job has finished.

The "Hardware Compare" link in the top right gives the ability to compare either the latest reference or candidate images between hardware setups. On that page, the "Application", the "Group" and the "Name" of a test is entered, and the server will then generate pairwise comparison images for each hardware setup that has run that specific test. This can be useful to ensure not only a temporal stability for individual hardware setups, but also that, for example, the Windows version of OpenSpace generates the same result as the Linux version.


### API
The backend has a number of API calls available that can be used to query the previous tests, submit new tests, or just run tests manually. A full list and explanations of all API calls is available at the `/api` endpoint (see [API](https://regression.openspaceproject.com/api)). Some general rules apply to all of them:

  - The API calls that change the reference images or the difference threshold, or that rerun a test, require the admin token in an `Authorization: Bearer <token>` header.
  - Submitting a test (`/api/submit-test`) and running a test without storing it (`/api/run-test`) require a valid `runnerID` in the request body. It should be sent before the files, so that requests from unknown runners are rejected before their files are uploaded.
  - Application, group, test, and hardware names must start with a letter or a digit and may only contain letters, digits, `.`, `_`, and `-` (at most 128 characters).
  - Submitted images can be at most 16384x16384 pixels. Logs can be at most 64 MiB.
  - Timestamps are ISO 8601 dates and times, for example `2026-01-31T12:00:00Z`. Timestamps without a timezone are interpreted as UTC. A test run cannot be submitted twice for the same timestamp.
  - Failed authentication attempts and the comparison API calls are rate limited per client. The limits can be changed in the `.env` file.
  - Changing the difference threshold returns immediately and regenerates all difference images in the background. `/api/diff-threshold` reports whether the regeneration is still running.


### Folder structure
The server stores all of the test results inside the `data` folder next to the `config.json`. The server will create two folders, one text file, and one database inside the `data` folder.

  - `audit.txt`: This file contains a list of all of the high-level functions that the server has been asked to perform. These entries are time-stamped and are stored to reason about the changes that have been made to the server, for example by submitting a new test, upgrading a candidate image to a reference image, etc. Administrative actions and rejected authentication attempts are logged together with the IP address of the client. When the server starts and the file is larger than 10 MB, it is renamed to `audit-<timestamp>.txt` and a new file is started.
  - `testresults.db`: This SQLite database contains the information about every test run (the pixel error, the timestamp, how long the test took to run, the commit hash, the number of errors in the log, which candidate, difference, and reference image the test run uses, a hash of the pixels of the candidate and difference images, and the full log of the test run) as well as the pointers to the currently active reference image of every test. All images are stored as files in the `reference` and `tests` folders described below. The server keeps the database in WAL mode, so the database file must not be copied while the server is running; see [Backups](#backups).
  - `reference`: This folder contains all of the reference images for the different tests. Each test is stored in subfolders according to their application, hardware, group and their name, with the reference images stored in the leaf folder with the timestamp as a filename. For example for the "openspace" application, the "windows-nvidia" hardware, the "apollo-8" group and the "earthrise" name, a potential reference image would be `data/reference/openspace/windows-nvidia/apollo-8/earthrise/20240101T120000000Z.png` and a later reference image would be `data/reference/openspace/windows-nvidia/apollo-8/earthrise/20240102T120000000Z.png` (the timestamp includes the milliseconds). The name of the reference file that is currently used as the "active" reference image used to compare candidate images to is stored in the `testresults.db`. Lastly, each reference image also has a `-thumbnail` version that is a reduced-size version of the reference image that the server utilizes in overview pages, where a full resolution is not required. The scale factor used for the thumbnail images is configured in the `config.json`.
  - `tests`: This folder contains all of the candidate images and derived data products. Subfolders here are of the form `application/hardware/group/name/timestamp`, which is a folder that contains the images of that specific test run. The information about the test run itself, including its log, is stored in the `testresults.db`. The `candidate.png` is the submitted candidate picture, a `candidate-thumbnail.png` is a reduced-size version of the submitted image. The `difference.png` is an image that shows the pixel difference between the candidate image and the reference image. The image is grayscale where two pixels are the same, and red where the pixels disagree. Similarly, the `difference-thumbnail.png` is a reduced-size version of the `difference.png`. In case the candidate image is a duplicate of a previous image (for example if a test run results in exactly the same result multiple times), the `candidate.png` is not stored multiple times, but a newer test instead will refer to the first instance the candidate image was submitted. Similarly, the difference image is not stored if it is pixel-identical to an already existing difference image. Identical images are found through the hash of their pixels that is stored in the `testresults.db`. A test run that reuses both images does not have a folder at all.

Older versions of the server also created a `temporary` folder for comparison images. These images are now generated in memory, so the folder is no longer used and can be deleted.

### Image sizes
Each application in the `applications` array of the `config.json` can define a fixed `imageSize` (width and height). For such applications, every submitted candidate image must have exactly that size, otherwise the submission is rejected. The "openspace" application uses a fixed 1920x1080 size. Applications without a fixed size (`"imageSize": null`, like "sgct") accept images of any resolution; the candidate image must then have the same resolution as the active reference image, otherwise the comparison is rejected with a resolution mismatch error.

### Rerunning tests
Tests can be rerun from the website by starting a parameterized Jenkins job (`Jenkinsfile.imagetesting` in the OpenSpace repository). To enable this, add a `jenkins` section to the `config.json` and set `JENKINS_USER` and `JENKINS_TOKEN` (an API token of that Jenkins user, which needs the permission to build the job) in the `.env` file. The "Rerun Test" button is only shown for the application and hardware combinations that are listed in the `targets`, each of which names the label of the Jenkins node that produces the results for that hardware:

```json
"jenkins": {
  "url": "https://jenkins.example.com",
  "job": "image-testing",
  "targets": [
    { "application": "openspace", "hardware": "windows-nvidia", "node": "windows-image-testing-nvidia" }
  ]
}
```

The server calls the `buildWithParameters` endpoint of the job with the parameters `NODE` (the label of the node), `TEST_ID` (the `group/name` of the test), and `COMMIT` (empty to build the latest commit), so the Jenkins server has to be reachable from the regression server.

### Migrating an existing data folder
The server only understands the application-based folder layout described above. If you are upgrading a server that stores data in the old layout (`data/tests/<hardware>/...` without the application level), stop the server and run the migration script before starting the new version:

  ```
  python scripts/0-migrate_to_applications.py --data-dir data
  ```

The script moves all existing hardware folders under `data/tests/openspace/` and `data/reference/openspace/`. It only renames folders and does not touch file contents, so it is fast and safe. Use `--dry-run` to preview the moves, and `--application <name>` to migrate under a different application name. The script is idempotent and will refuse to run on an ambiguous (partially migrated) layout. After the migration, make sure the `applications` array in the `config.json` lists all applications that should be able to submit tests.

The server stores the information about the test runs in the `testresults.db` database. If you are upgrading a server that still stores this information in `data.json`, `log.txt`, and `ref.txt` files, the server refuses to start. Make a backup of the `data` folder, stop the server, and run the second migration script after the first one:

  ```
  python scripts/1-migrate_to_sqlite.py --data-dir data
  ```

The script reads and validates all `data.json`, `log.txt`, and `ref.txt` files and aborts without changing anything if any of them is invalid. It then writes all of their contents into `data/testresults.db`, deletes the migrated files, and removes the test run folders that are left empty. The `audit.txt` and all images are not touched. Use `--dry-run` to only validate the files and see what would happen, and `--keep-files` to keep the original files. If the script is interrupted while deleting the files, running it again compares the remaining files with the database and finishes the cleanup. Afterwards, start the server. The first time the server starts after the migration, it computes the hashes of the pixels of all candidate and difference images, which takes a few minutes for a large data folder.

The `config.json` of older versions contains settings that are no longer supported, and the server refuses to start while one of them is present: remove `data` (the test results are always stored in the `data` folder next to the `config.json`), and move `port` and `adminToken` into the `.env` file as `PORT` and `ADMIN_TOKEN`.

### Removing a hardware
All test runs of a hardware (for example a test machine that is no longer used) can be removed with:

  ```
  python scripts/remove_hardware.py windows-amd --data-dir data
  ```

Stop the server first. The script removes the test runs from the `testresults.db` and deletes the `data/tests/<application>/<hardware>` folders of all applications. The reference images of the hardware are kept. Use `--dry-run` to see what would be deleted.

### Backups
All information besides the images is stored in `data/testresults.db`. As the server uses SQLite's WAL mode, either stop the server before copying the database file, or create a consistent copy while the server is running with `sqlite3 data/testresults.db ".backup backup.db"`. The `reference` and `tests` folders only contain images that are never modified after they were written (except when the difference threshold is changed), so they can be copied at any time.
