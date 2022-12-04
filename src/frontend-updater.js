const ncu = require('npm-check-updates');
const fs = require('fs').promises;
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const {readFileContent} = require('./utils');

function escapeRegex(string) {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

class FrontendUpdater {

  /**
   * @param {import('pino').BaseLogger} log
   */
  constructor({log}) {
    this.log = log.child({name: 'frontend-updater'});
  }

  /**
   * @param {string} localRepoDirectory
   * @param {import('./exclude-strategy').ExcludeStrategy} excludeStrategy
   */
  async executeUpdate(localRepoDirectory, excludeStrategy) {
    const workingDirectory = `${localRepoDirectory}/frontend`;
    this.log.info(`Will check for updates in ${workingDirectory}`);

    const packageFile = `${workingDirectory}/package.json`;
    const yarnLockFile = `${workingDirectory}/yarn.lock`;
    const previousPackageJson = excludeStrategy.hasExcludes() && JSON.parse(await readFileContent(packageFile));

    const updatesList = [];

    try {
      const ncuState = await ncu.run({
        cwd: workingDirectory,
        packageFile,
        upgrade: true,
      });

      let updatedPackageJson = excludeStrategy.hasExcludes() && (await readFileContent(packageFile));

      for (let packageName of Object.keys(ncuState)) {
        const packageVersion = ncuState[packageName];
        const shouldBeExcluded = excludeStrategy.isExcluded(packageName, packageVersion);
        if (shouldBeExcluded) {
          const previousPackageVersion = previousPackageJson.dependencies[packageName]
            || previousPackageJson.devDependencies[packageName];
          this.log.info(`Update to ${packageName}:${packageVersion} is excluded, keeping ${previousPackageVersion}`);
          updatedPackageJson = updatedPackageJson.replace(
            new RegExp(`("${escapeRegex(packageName)}"\\s*:\\s*)"${escapeRegex(packageVersion)}"`, 'g'),
            `\$1"${previousPackageVersion}"`);
        } else {
          updatesList.push(`\`${packageName}\` updated to \`${ncuState[packageName]}\``);
        }
      }
      this.log.info(`Found updates: ${JSON.stringify(updatesList)}`);

      if (excludeStrategy.hasExcludes()) {
        this.log.info(`package.json should be updated due to exclusions`);
        await fs.writeFile(packageFile, updatedPackageJson);
      }

      const previousYarnLock = !updatesList.length && (await readFileContent(yarnLockFile));

      this.log.info(`Installing updates`);
      const {stdout: yarnInstallStdout, stderr: yarnInstallStderr} = await exec('yarn install --mode=update-lockfile', {
        cwd: workingDirectory
      });
      this.log.info(`Updates installed with result:\n ${yarnInstallStdout.toString()}\n${yarnInstallStderr.toString()}`);

      if (!updatesList.length) {
        const newPackageLock = await readFileContent(yarnLockFile);
        if (newPackageLock !== previousYarnLock) {
          this.log.info('New peer dependencies installed');
          updatesList.push('Updated peer dependencies');
        }
      }

      this.log.info('Update check finished');

      return updatesList.length ? {
        title: 'Frontends dependencies',
        updated: updatesList,
      } : null;

    } catch (e) {
      this.log.error('Update of frontend dependencies failed');
      this.log.error(e);
      return null;
    }
  }
}

exports.FrontendUpdater = FrontendUpdater;
