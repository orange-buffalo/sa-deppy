const {ProbotOctokit} = require("probot");
const {createAppAuth} = require("@octokit/auth-app");

class GitOperations {

  /**
   * @param {import('pino').BaseLogger} log
   * @param {import('./config').config} config
   */
  constructor({log, config}) {
    this.log = log.child({name: 'git'});
    this.octokit = new ProbotOctokit({
      auth: createAppAuth({
        appId: config.appId,
        privateKey: Buffer.from(config.appPrivateKey, 'base64').toString('ascii'),
      }),
    });
    this.owner = config.repo.split('/')[0]
    this.repo = config.repo.split('/')[1];
    this.repoCloneUrl = config.repoCloneUrl;

    this.log.info(`Initialized GitOperations for ${this.repo} of ${this.owner} (${config.repoCloneUrl})`);
  }

}

module.exports.GitOperations = GitOperations;
