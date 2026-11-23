// Two deployments must never run at the same time, as they would replace the same files
properties([disableConcurrentBuilds()]);

node("server-liu-media") {
  deleteDir();
  stage("SCM") {
    checkout scm;
  }

  stage("Install") {
    sh(
      // 'npm ci' installs exactly the versions from package-lock.json and fails if the
      // lock file does not match package.json
      script: "npm ci",
      label: "NPM install packages"
    );
  }

  stage("Check") {
    sh(
      script: "npm run lint",
      label: "Check formatting and linting"
    );
    sh(
      script: "npm test",
      label: "Run tests"
    );
  }

  stage("Build") {
    sh(
      script: "npm run build",
      label: "Build frontend and backend"
    );
  }

  if (env.BRANCH_NAME == "master") {
    stage("Deploy") {
      def target = "/var/www/regression.openspaceproject.com";
      def staging = "${target}/.deploy-staging";
      // The name of the pm2 process that runs the server
      def process = "Regression Testing";
      // Everything the server needs at runtime. The config.json, .env, data, and
      // public folders in the target directory are never touched
      def files = "index.cjs package.json package-lock.json out dist node_modules scripts";

      sh(
        script: "npm prune --omit=dev",
        label: "Remove development packages"
      );
      sh(
        // Copying is done while the server is still running to keep the downtime short.
        // The staging folder is on the same file system, so the move below is instant
        script: """
          rm -rf ${staging}
          mkdir -p ${staging}
          cp -R ${files} ${staging}
        """,
        label: "Copy files into staging folder"
      );

      withEnv(["PM2_HOME=/opt/pm2/.pm2"]) {
        try {
          sh(
            script: "pm2 stop '${process}'",
            label: "Stop server"
          );
          sh(
            // Only the latest backup is kept. The backup goes through sqlite3 so that
            // changes that are still in the WAL file are included
            script: """
              cd ${target}/data
              if [ -f testresults.db ]; then
                rm -f testresults.backup.db.tmp
                sqlite3 testresults.db ".backup testresults.backup.db.tmp"
                mv -f testresults.backup.db.tmp testresults.backup.db
              fi
            """,
            label: "Back up database"
          );
          sh(
            script: """
              cd ${target}
              for f in ${files}; do
                rm -rf "\$f"
                mv "${staging}/\$f" "\$f"
              done
              rm -rf ${staging}
            """,
            label: "Replace files"
          );
        }
        finally {
          // Always start the server again, even if the backup or the replacement failed,
          // so that a failed deployment does not take the website down
          sh(
            script: "pm2 restart '${process}'",
            label: "Start server"
          );
        }
      }

      sh(
        // The server refuses to start, for example, if a migration script has to be run
        script: """
          cd ${target}
          port=\$(sed -n 's/^PORT=//p' .env | tr -d '"\\r ')
          port=\${port:-8000}
          for i in \$(seq 1 30); do
            if curl -fsS "http://localhost:\$port/api/health"; then
              exit 0
            fi
            sleep 2
          done
          echo "The server did not become healthy within 60 seconds"
          exit 1
        """,
        label: "Check that the server is running"
      );
    }
  }

  if (env.BRANCH_NAME != "master") {
    echo("Skipping the deployment as we are not working on the 'master' branch");
    currentBuild.result = "NOT_BUILT";
  }
}
