const ncu = require('npm-check-updates');
const fs = require('fs').promises;
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const {readFileContent} = require('./utils');

function escapeRegex(string) {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

class NpmUpdater {

  /**
   * @param {import('pino').BaseLogger} log
   */
  constructor({log}) {
    this.log = log.child({name: 'npm-updater'});
  }

  /**
   * @param {string} localRepoDirectory
   * @param {Array<{name:string, version:string}>} excludedDependencies
   */
  async executeUpdate(localRepoDirectory, excludedDependencies) {
    const workingDirectory = `${localRepoDirectory}/frontend`;
    this.log.info(`Will check for updates in ${workingDirectory}`);

    const packageFile = `${workingDirectory}/package.json`;
    const packageLockFile = `${workingDirectory}/package-lock.json`;
    const previousPackageJson = excludedDependencies.length && JSON.parse(await readFileContent(packageFile));

    const updatesList = [];

    try {
      const ncuState = await ncu.run({
        cwd: workingDirectory,
        packageFile,
        upgrade: true,
      });

      let updatedPackageJson = excludedDependencies.length && (await readFileContent(packageFile));

      for (let packageName of Object.keys(ncuState)) {
        const packageVersion = ncuState[packageName];
        const shouldBeExcluded = excludedDependencies.some(it => it.name === packageName && it.version === packageVersion);
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

      if (excludedDependencies.length) {
        this.log.info(`package.json should be updated due to exclusions`);
        await fs.writeFile(packageFile, updatedPackageJson);
      }

      const previousPackageLock = !updatesList.length && (await readFileContent(packageLockFile));

      this.log.info(`Installing updates`);
      const {stdout: npmInstallStdout, stderr: npmInstallStderr} = await exec('npm install --package-lock-only', {
        cwd: workingDirectory
      });
      this.log.info(`Updates installed with result:\n ${npmInstallStdout.toString()}\n${npmInstallStderr.toString()}`);

      this.log.info('Running audit fix');
      const {stdout: npmAuditStdout, stderr: npmAuditStderr} = await exec('npm audit fix --package-lock-only', {
        cwd: workingDirectory
      });
      this.log.info(`Audit finished with result:\n ${npmAuditStdout.toString()}\n${npmAuditStderr.toString()}`);

      if (!updatesList.length) {
        const newPackageLock = await readFileContent(packageLockFile);
        if (newPackageLock !== previousPackageLock) {
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

exports.NpmUpdater = NpmUpdater;
