const {Octokit} = require("@octokit/rest");
const {createAppAuth} = require("@octokit/auth-app");
const path = require('path')
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')
const os = require("os");
const fs = require('fs').promises;
const rimraf = require('rimraf');

class GitOperations {

  /**
   * @param {import('pino').BaseLogger} log
   * @param {import('./config').config} config
   */
  constructor({log, config}) {
    this.log = log.child({name: 'git'});
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: Buffer.from(config.appPrivateKey, 'base64').toString('ascii'),
        installationId: config.appInstallationId,
      },
    });
    this.owner = config.repo.split('/')[0]
    this.repo = config.repo.split('/')[1];
    this.repoCloneUrl = config.repoCloneUrl;
    this.gitHubConfig = {
      repo: this.repo,
      owner: this.owner,
    }

    this.log.info(`Initialized GitOperations for ${this.repo} of ${this.owner} (${config.repoCloneUrl})`);
  }

  /**
   * @param {string} branchName
   */
  async findRemoteBranch(branchName) {
    const branch = await this.executeRequest(() => this.octokit.git.getRef({
      ...this.gitHubConfig,
      ref: `heads/${branchName}`,
    }));
    return branch && {
      head: branch.object.sha,
    }
  }

  /**
   * @param {string} localRepo
   * @param {string} parentCommit
   * @param {string} message
   */
  async commitDirtyFilesToRemoteRepo({localRepo, parentCommit, message}) {
    this.log.info(`Initiated commit of dirty files in ${localRepo}`);

    const changedFiles = await this.getDirtyFiles(localRepo);
    this.log.info(`Modified files are ${JSON.stringify(changedFiles)}`);

    const gitTree = await this.buildGitTreeOfChangesFiles(changedFiles, localRepo);
    this.log.info('Created a Git tree to push');

    const parentCommitTreeSha = await this.getCommitTreeHash(parentCommit);
    this.log.info(`Parent commit tree is ${parentCommitTreeSha}`);

    const treeSha = await this.pushGitTree(gitTree, parentCommitTreeSha);
    this.log.info(`Created a new Git tree at remote: ${treeSha}`);

    const commitSha = await this.createRemoteCommit(message, treeSha, parentCommit);
    this.log.info(`Created a new Git commit at remote: ${commitSha}`);

    return commitSha;
  }

  /**
   * @private
   */
  async createRemoteCommit(message, treeSha, parentCommit) {
    const {data: {sha}} = await this.octokit.git.createCommit({
      ...this.gitHubConfig,
      message,
      tree: treeSha,
      parents: [parentCommit]
    });
    return sha;
  }

  /**
   * @private
   */
  async pushGitTree(gitTree, baseTreeHash) {
    const {data: {sha}} = await this.octokit.git.createTree({
      ...this.gitHubConfig,
      tree: gitTree,
      base_tree: baseTreeHash,
    });
    return sha;
  }

  /**
   * @param {string} commit
   * @private
   */
  async getCommitTreeHash(commit) {
    const {data: {tree: {sha}}} = await this.octokit.git.getCommit({
      ...this.gitHubConfig,
      commit_sha: commit
    });
    return sha;
  }

  /**
   * @param {Array<string>} changedFiles
   * @param {string} localRepo
   * @private
   */
  async buildGitTreeOfChangesFiles(changedFiles, localRepo) {
    const gitTree = [];
    for (let changedFile of changedFiles) {
      const contentBuffer = await fs.readFile(path.join(localRepo, changedFile), {
        encoding: 'utf-8'
      });
      gitTree.push({
        content: contentBuffer.toString(),
        path: changedFile,
        type: 'blob',
        mode: changedFile.endsWith('.sh') ? '100755' : '100644'
      });
    }
    return gitTree;
  }

  /**
   * @param {string} localRepo
   * @private
   */
  async getDirtyFiles(localRepo) {
    const gitStatus = await git.statusMatrix({
      fs: require('fs'),
      dir: localRepo,
    })
    return gitStatus
      .filter(fileMatrix => fileMatrix[2] === 2)
      .map(fileMatrix => fileMatrix[0]);
  }

  /**
   * @param {string} cloneUrl
   */
  async cloneRemoteRepo(cloneUrl) {
    this.log.info(`Cloning ${cloneUrl}`);

    const cloneDirectory = path.join(os.tmpdir(), 'sa-deppy-clone-directory');
    try {
      await fs.stat(cloneDirectory);
      this.log.info(`Clone directory ${cloneDirectory} already exists, removing it`);
      rimraf.sync(cloneDirectory);
      this.log.info('Clone directory removed');
    } catch (e) {
      this.log.info(`${cloneDirectory} does not exist yet`);
    }
    await fs.mkdir(cloneDirectory);

    this.log.info('Starting cloning..');
    await git.clone({
      fs: require('fs'),
      http,
      dir: cloneDirectory,
      url: cloneUrl,
      depth: 1
    });

    this.log.info(`Cloned ${cloneUrl} to ${cloneDirectory}`);
    return cloneDirectory;
  }

  /**
   * @private
   */
  async executeRequest(requestExecutor) {
    try {
      const response = await requestExecutor();
      return response.data;
    } catch (e) {
      if (e.status === 404) {
        return null;
      }
      throw e;
    }
  }

  async createOrUpdateRemoteBranch({branchName, commitSha}) {
    this.log.info(`Request to update ${branchName} to ${commitSha}`);
    const existingBranch = await this.findRemoteBranch(branchName);
    if (existingBranch) {
      this.log.info(`Branch already exists, updating reference`);
      await this.octokit.git.updateRef({
        ...this.gitHubConfig,
        ref: `heads/${branchName}`,
        sha: commitSha,
        force: true,
      });
    } else {
      this.log.info(`Creating a new branch`);
      await this.octokit.git.createRef({
        ...this.gitHubConfig,
        ref: `refs/heads/${branchName}`,
        sha: commitSha
      })
    }
    this.log.info(`Done, ${branchName} is now at ${commitSha}`);
  }
}

module.exports.GitOperations = GitOperations;
