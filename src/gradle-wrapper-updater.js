const fs = require('fs').promises;
const got = require('got');
const {readFileContent} = require('./utils');

const DISTRIBUTION_URL_REGEX = /(distributionUrl\s*=\s*)\S*-((\d|\.)+)-(bin|all)\.zip/g;

const buildTimeRegex = new RegExp(
  '^(\\d\\d\\d\\d)(\\d\\d)(\\d\\d)(\\d\\d)(\\d\\d)(\\d\\d)(\\+\\d\\d\\d\\d)$'
);

function formatBuildTime(timeStr) {
  if (!timeStr) {
    return null;
  }
  if (buildTimeRegex.test(timeStr)) {
    return timeStr.replace(buildTimeRegex, '$1-$2-$3T$4:$5:$6$7');
  }
  return null;
}

class GradleWrapperUpdater {
  /**
   * @param {import('pino').BaseLogger} log
   */
  constructor({log}) {
    this.log = log.child({name: 'gradle-wrapper-updater'});
  }

  /**
   * @param {string} localRepoDirectory
   * @param {Array<{name:string, version:string}>} excludedDependencies
   */
  async executeUpdate(localRepoDirectory, excludedDependencies) {
    const wrapperPropertiesFile = `${localRepoDirectory}/gradle/wrapper/gradle-wrapper.properties`;
    this.log.info(`Checking for Gradle updates in ${wrapperPropertiesFile}`);

    try {
      let wrapperPropertiesContent = await readFileContent(wrapperPropertiesFile);
      const distributionUrlMatch = wrapperPropertiesContent.matchAll(DISTRIBUTION_URL_REGEX).next().value;
      if (distributionUrlMatch) {
        const currentVersion = distributionUrlMatch[2];
        this.log.info(`Current version is ${currentVersion}, requesting for available updates`);

        const excludedVersions = excludedDependencies
          .filter(it => it.name === 'gradle')
          .map(it => it.version);
        this.log.info(`Excluded versions are ${JSON.stringify(excludedDependencies)}`);

        const {body: allGradleVersions} = await got.get('https://services.gradle.org/versions/all', {
          responseType: 'json'
        });

        let validGradleVersions = allGradleVersions
          .filter(it => !it.snapshot)
          .filter(it => !it.nightly)
          .filter(it => !it.releaseNightly)
          .filter(it => !it.rcFor)
          .filter(it => !it.milestoneFor)
          .filter(it => excludedVersions.indexOf(it.version) < 0)
          .map(it => ({
            version: it.version,
            buildTime: formatBuildTime(it.buildTime)
          }));

        validGradleVersions.sort((a, b) => new Date(a.buildTime) > new Date(b.buildTime) ? -1 : 1);
        validGradleVersions = validGradleVersions.map(it => it.version);

        this.log.info(`Valid sorted versions are ${JSON.stringify(validGradleVersions)}`);

        let currentVersionIndex = validGradleVersions.indexOf(currentVersion);
        if (currentVersionIndex < 0) {
          this.log.warn('Current version is out of valid list, cannot make decision');
        } else if (currentVersionIndex === 0) {
          this.log.info('Already on the latest acceptable version');
        } else {
          const newVersion = validGradleVersions[0];
          this.log.info(`Updating to ${newVersion}`);

          wrapperPropertiesContent = wrapperPropertiesContent.replace(currentVersion, newVersion);
          await fs.writeFile(wrapperPropertiesFile, wrapperPropertiesContent);

          this.log.info('Gradle wrapper updated');

          return {
            title: 'Build System',
            updated: [`Gradle updated from \`${currentVersion}\` to \`${newVersion}\``],
          }
        }
      } else {
        this.log.warn('Could not parse the wrapper file');
      }
    } catch (e) {
      this.log.error('Failed to check wrapper dependencies');
      this.log.error(e);
    }
    return null;
  }

}

exports.GradleWrapperUpdater = GradleWrapperUpdater;
