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

    // todo: replace with real implementations
    this.updaters = [
      {
        async executeUpdate() {
          return {
            title: 'Readme',
            updated: ['something'],
          }
        }
      }
    ];

    this.log.info('Initialized SaDeppy');
  }

  /**
   * @param {import('probot').Context} context
   * @returns {Promise<boolean|{excludedDependencies: [{name: string, version: string}]}>}
   */
  async getStatus(context) {
    if (this.isValidRepo(context)) {
      return {
        excludedDependencies: await this.storage.getExcludedDependencies(),
      };
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
      const dependencies = parseRawDependenciesList(rawDependenciesList);
      await this.storage.includeDependencies(dependencies);
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

    if (this.shouldDeferUpdate()) return;

    try {
      this.updateInProgress = true;

      if (await this.hasUnmanagedUpdatesBranch()) return;

      // todo: revert to cloning
      const localRepoDirectory = '/tmp/sa-deppy-clone-directory';
      // const localRepoDirectory = await this.gitOperations.cloneRemoteRepo(this.config.repoCloneUrl);

      const updateResults = await this.runUpdaters(localRepoDirectory);

      const changesDescription = this.getChangesDescription(updateResults);

      this.log.info(`Executed update with results: ${JSON.stringify(updateResults)}`);

      if (updateResults.length) {
        this.log.info('Updaters found some updated, will continue with a new commit');

        const mainBranch = await this.gitOperations.findRemoteBranch(this.config.mainBranch);
        const updatesCommit = await this.gitOperations.commitDirtyFilesToRemoteRepo({
          localRepo: localRepoDirectory,
          parentCommit: mainBranch.head,
          message: changesDescription,
        });
        this.log.info('Create remote commit for the changes');

        await this.gitOperations.createOrUpdateRemoteBranch({
          branchName: this.config.updatesBranch,
          commitSha: updatesCommit,
        })
        this.log.info(`Updated ${this.config.updatesBranch} to contains the latest changes`);

        await this.storage.setUpdatesBranchHead(updatesCommit);
        this.log.info(`Updated settings to point to ${updatesCommit}`);
      }

      this.log.info('Update finished successfully');
    } catch (e) {
      this.log.error(`Failed to execute update`);
      this.log.error(e);
    } finally {
      this.updateInProgress = false;
    }

    await this.executeDeferredUpdate();
  }

  /**
   * @private
   */
  async runUpdaters(localRepoDirectory) {
    const updateResults = [];
    for (let updater of this.updaters) {
      const updateResult = await updater.executeUpdate(localRepoDirectory);
      if (updateResult) {
        updateResults.push(updateResult);
      }
    }
    return updateResults;
  }

  /**
   * @private
   */
  getChangesDescription(updateResults) {
    let description = 'The following dependencies have been updated:\n\n';
    for (let updateResult of updateResults) {
      description += `### ${updateResult.title}\n`;
      for (let updateItem of updateResult.updated) {
        description += `* ${updateItem}\n`;
      }
      description += '\n';
    }
    return description;
  }

  /**
   * @private
   */
  async hasUnmanagedUpdatesBranch() {
    const updatesBranch = await this.gitOperations.findRemoteBranch(this.config.updatesBranch);
    const updatesBranchHead = await this.storage.getUpdatesBranchHead();
    if (updatesBranch && updatesBranch.head !== updatesBranchHead) {
      this.log.warn(`Updates branch already exists at ${updatesBranch.head} ` +
        `but expected head is ${updatesBranchHead}. Stopping update - proceed with the branch on your own!`);
      return true;
    }
    return false;
  }

  /**
   * @private
   */
  shouldDeferUpdate() {
    if (this.updateInProgress) {
      this.updateRequired = true;
      this.log.info('Update is already in progress, scheduled another iteration')
      return true;
    }
    return false;
  }

  /**
   * @private
   */
  async executeDeferredUpdate() {
    if (this.updateRequired) {
      this.log.info('Another update scheduled while we were updating, starting new update cycle')
      this.updateRequired = false;
      await this.executeUpdate();
    }
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
