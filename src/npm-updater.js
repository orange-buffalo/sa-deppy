const ncu = require('npm-check-updates');
const fs = require('fs').promises;
const {execSync} = require('child_process');

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
   * @param {Array<{name:string, version:string}>}excludedDependencies
   */
  async executeUpdate(localRepoDirectory, excludedDependencies) {
    const workingDirectory = `${localRepoDirectory}/frontend`;
    this.log.info(`Will check for updates in ${workingDirectory}`);

    const packageFile = `${workingDirectory}/package.json`;
    const packageLockFile = `${workingDirectory}/package-lock.json`;
    const previousPackageJson = excludedDependencies.length && JSON.parse((await fs.readFile(packageFile)).toString());

    const updatesList = [];

    const ncuState = await ncu.run({
      cwd: workingDirectory,
      packageFile,
      upgrade: true,
    });

    let updatedPackageJson = excludedDependencies.length && (await fs.readFile(packageFile)).toString();

    for (let packageName of Object.keys(ncuState)) {
      const packageVersion = ncuState[packageName];
      const shouldBeExcluded = excludedDependencies.some(it => it.name === packageName && it.version === packageVersion);
      if (shouldBeExcluded) {
        this.log.info(`Update to ${packageName}:${packageVersion} is excluded`);
        updatedPackageJson = updatedPackageJson.replace(
          new RegExp(`("${escapeRegex(packageName)}"\\s*:\\s*)"${escapeRegex(packageVersion)}"`, 'g'),
          `\$1"${previousPackageJson.dependencies[packageName]}"`);
      } else {
        updatesList.push(`\`${packageName}\` updated to \`${ncuState[packageName]}\``);
      }
    }
    this.log.info(`Found updates: ${JSON.stringify(updatesList)}`);

    if (excludedDependencies.length) {
      this.log.info(`package.json should be updated due to exclusions`);
      await fs.writeFile(packageFile, updatedPackageJson);
    }

    const previousPackageLock = !updatesList.length && (await fs.readFile(packageLockFile)).toString();

    this.log.info(`Installing updates`);
    const npmInstall = execSync('npm install --package-lock-only', {
      cwd: workingDirectory
    });
    this.log.info(`Updates installed with result:\n ${npmInstall.toString()}`);

    this.log.info('Running audit fix');
    const npmAudit = execSync('npm audit fix --package-lock-only', {
      cwd: workingDirectory
    });
    this.log.info(`Audit finished with result:\n ${npmAudit.toString()}`);

    if (!updatesList.length) {
      const newPackageLock = (await fs.readFile(packageLockFile)).toString();
      if (newPackageLock !== previousPackageLock) {
        this.log.info('New peer dependencies installed');
        updatesList.push('Updated peer dependencies');
      }
    }

    this.log.info('Update check finished');

    return {
      title: 'Frontends dependencies',
      updated: updatesList,
    }
  }
}

exports.NpmUpdater = NpmUpdater;
