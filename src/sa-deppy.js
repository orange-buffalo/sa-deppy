const {GitOperations} = require('./git-operations');
const {Storage} = require('./storage');
const parseRawDependenciesList = require('../src/raw-dependencies-parser');
const {ExcludeStrategy} = require("./exclude-strategy");
const {GradleUpdater} = require("./gradle-updater");
const {GradleWrapperUpdater} = require("./gradle-wrapper-updater");
const {FrontendUpdater} = require("./frontend-updater");

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

    this.updaters = [
      new FrontendUpdater({log}),
      new GradleWrapperUpdater({log}),
      new GradleUpdater({log}),
    ];

    this.log.info('Initialized SaDeppy');
  }

  /**
   * @param {import('probot').Context} context
   * @returns {Promise<boolean|{excludedDependencies: [{name: string, version: string}],excludedDependenciesRegexes: [{name: string, version: string}]}>}
   */
  async getStatus(context) {
    if (this.isValidRepo(context)) {
      return {
        excludedDependencies: await this.storage.getExcludedDependencies(),
        excludedDependenciesRegexes: await this.storage.getExcludedDependenciesRegexes(),
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
      // noinspection ES6MissingAwait
      this.executeUpdate();
    }
  }

  /**
   * @param {string} rawDependenciesRegexesList
   * @param {import('probot').Context} context
   */
  async includeDependenciesByRegexes(rawDependenciesRegexesList, context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Request to include dependencies by regex: ${rawDependenciesRegexesList}`);
      const dependencies = parseRawDependenciesList(rawDependenciesRegexesList);
      await this.storage.includeDependenciesByRegexes(dependencies);
      // noinspection ES6MissingAwait
      this.executeUpdate();
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
      // noinspection ES6MissingAwait
      this.executeUpdate();
    }
  }

  /**
   * @param {string} rawDependenciesRegexes
   * @param {import('probot').Context} context
   */
  async excludeDependenciesByRegex(rawDependenciesRegexes, context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Request to exclude dependencies by regex: ${rawDependenciesRegexes}`);
      const dependencies = parseRawDependenciesList(rawDependenciesRegexes);
      await this.storage.excludeDependenciesByRegex(dependencies);
      // noinspection ES6MissingAwait
      this.executeUpdate();
    }
  }

  async clearExcludedDependencies(context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Request to clear excluded dependencies`);
      await this.storage.clearExcludedDependencies();
      // noinspection ES6MissingAwait
      this.executeUpdate();
    }
  }

  async clearExcludedDependenciesRegexes(context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Request to clear excluded dependencies regexes`);
      await this.storage.clearExcludedDependenciesRegexes();
      // noinspection ES6MissingAwait
      this.executeUpdate();
    }
  }

  /**
   * @param {import('probot').Context<import('@octokit/webhooks').WebhookPayloadPush>} context
   */
  async onPush(context) {
    if (this.isValidRepo(context)) {
      this.log.info(`Received push event on ${context.payload.ref}`);
      if (`refs/heads/${this.config.mainBranch}` === context.payload.ref) {
        setTimeout(() => this.executeUpdate(), 5 * 60 * 1000);
      }
    }
  }

  async executeUpdate() {
    this.log.info('Starting update');

    if (this.shouldDeferUpdate()) return;

    try {
      this.updateInProgress = true;

      if (await this.hasUnmanagedUpdatesBranch()) return;

      const localRepoDirectory = await this.gitOperations.cloneRemoteRepo(this.config.repoCloneUrl);

      const updateResults = await this.runUpdaters(localRepoDirectory);

      const changesDescription = await this.getChangesDescription(updateResults);

      this.log.info(`Executed update with results: ${JSON.stringify(updateResults)}`);

      if (updateResults.length) {
        this.log.info('Updaters found some updates, will continue with a new commit');

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

        const existingPullRequest = await this.gitOperations.findOpenPullRequest({
          sourceBranch: this.config.updatesBranch,
          targetBranch: this.config.mainBranch,
        });
        if (existingPullRequest) {
          this.log.info(`Found existing pull request ${existingPullRequest.html_url}`);
          await this.gitOperations.updatePullRequestDescription(existingPullRequest.number, changesDescription);
          this.log.info('Pull request updated with new description');
        } else {
          this.log.info('No open pull requests found, creating new one');
          const newPullRequest = await this.gitOperations.createPullRequest({
            sourceBranch: this.config.updatesBranch,
            targetBranch: this.config.mainBranch,
            title: 'Updating dependencies',
            body: changesDescription,
          });
          this.log.info(`Created pull request ${newPullRequest.html_url}`);
        }
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
    const excludeStrategy = new ExcludeStrategy();
    await excludeStrategy.init(this.storage);
    for (let updater of this.updaters) {
      const updateResult = await updater.executeUpdate(localRepoDirectory, excludeStrategy);
      if (updateResult) {
        updateResults.push(updateResult);
      }
    }
    return updateResults;
  }

  /**
   * @private
   */
  async getChangesDescription(updateResults) {
    let description = 'The following dependencies have been updated:\n\n';
    for (let updateResult of updateResults) {
      description += `### ${updateResult.title}\n`;
      for (let updateItem of updateResult.updated) {
        description += `* ${updateItem}\n`;
      }
      description += '\n';
    }

    description += '\n### Exclusions\n';
    const excludedDependencies = await this.storage.getExcludedDependencies();
    if (excludedDependencies.length) {
      description += 'The following dependencies excluded from update:\n'
      for (let excludedDependency of excludedDependencies) {
        description += `* \`${excludedDependency.name}:${excludedDependency.version}\`\n`;
      }
    } else {
      description += 'Currently no dependencies are excluded from update.';
    }

    description += '\n### Exclusions by regex\n';
    const excludedDependenciesRegexes = await this.storage.getExcludedDependenciesRegexes();
    if (excludedDependenciesRegexes.length) {
      description += 'The following dependencies excluded from update (regex):\n'
      for (let excludedDependency of excludedDependenciesRegexes) {
        description += `* \`${excludedDependency.name}:${excludedDependency.version}\`\n`;
      }
    } else {
      description += 'Currently no dependencies are excluded from update.';
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
