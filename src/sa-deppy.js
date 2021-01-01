const {GitOperations} = require('./git-operations');
const {Storage} = require('./storage');
const parseRawDependenciesList = require('../src/raw-dependencies-parser');

class SaDeppy {

  /**
   * @param {import('pino').BaseLogger} log
   */
  constructor({log}) {
    this.log = log.child({name: 'sa-deppy'});

    // to avoid issues with concurrent update, using simple semaphore
    this.updateInProgress = false;
    this.updateRequired = false;

    this.config = require('./config');

    this.gitOperations = new GitOperations({
      log: this.log,
      config: this.config,
    });

    this.storage = new Storage({
      log,
      config: this.config
    });

    this.log.info('Initialized SaDeppy');
  }

  /**
   * @param {import('probot').Context} context
   * @returns {Promise<boolean|{excludedDependencies: [{name: string, version: string}]}>}
   */
  async getStatus(context) {
    if (this.isValidRepo(context)) {
      return {
        excludedDependencies: [{
          name: 'org.springframework',
          version: '1.0'
        }]
      }
    }
    return false;
  }

  /**
   * @param {string} rawDependenciesList
   * @param {import('probot').Context} context
   */
  async includeDependencies(rawDependenciesList, context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Request to include dependencies: ${rawDependenciesList}`);
    }
  }

  /**
   * @param {string} rawDependenciesList
   * @param {import('probot').Context} context
   */
  async excludeDependencies(rawDependenciesList, context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Request to exclude dependencies: ${rawDependenciesList}`);
      const dependencies = parseRawDependenciesList(rawDependenciesList);
      await this.storage.excludeDependencies(dependencies);
    }
  }

  /**
   * @param {import('probot').Context<import('@octokit/webhooks').WebhookPayloadPush>} context
   */
  async onPush(context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Received push event on ${context.payload.ref}`);
      if (`refs/heads/${this.config.mainBranch}` === context.payload.ref) {
        await this.executeUpdate();
      }
    }
  }

  async executeUpdate() {
    this.log.info('Starting update');
    if (this.updateInProgress) {
      this.updateRequired = true;
      this.log.info('Update is already in progress, scheduled another iteration')
      return;
    }
    this.updateInProgress = true;

    this.updateInProgress = false;
    if (this.updateRequired) {
      this.log.info('Another update scheduled while we were updating, starting new update cycle')
      this.updateRequired = false;
      await this.executeUpdate();
    }
    this.log.info('Update finished');
  }

  /**
   * @param {import('probot').Context} context
   * @private
   */
  isValidRepo(context) {
    const repo = context.repo({});
    if (this.config.repo !== `${repo.owner}/${repo.repo}`) {
      log.warn(`Received event from unsupported repo ${JSON.stringify(repo)}`);
      return false;
    }
    return true;
  }
}

module.exports.SaDeppy = SaDeppy;
