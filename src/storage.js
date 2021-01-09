const admin = require('firebase-admin');

class Storage {

  /**
   * @param {import('./config').config} config
   * @param {import('pino').BaseLogger} log
   */
  constructor({config, log}) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(config.firebase.serviceKey)),
      databaseURL: config.firebase.databaseURL,
    });
    this.log = log.child({name: "storage"});
    this.database = admin.database();

    this.log.info('Initialized Storage');
  }

  async includeDependencies(dependencies) {
    await this.ensureSettings();
    for (let dependencyToInclude of dependencies) {
      this.settings.excludedDependencies = this.settings.excludedDependencies.filter(existingDependency =>
        !this.isSameDependency(existingDependency, dependencyToInclude))
    }
    await this.saveSettings();
  }

  async getUpdatesBranchHead() {
    await this.ensureSettings();
    return this.settings.updatesBranchHead;
  }

  /**
   * @param {Array<{name: string, version:String}>} dependencies
   */
  async excludeDependencies(dependencies) {
    await this.ensureSettings();
    for (let dependencyToExclude of dependencies) {
      const alreadyExcluded = this.settings.excludedDependencies.some(existingDependency =>
        this.isSameDependency(existingDependency, dependencyToExclude));
      if (!alreadyExcluded) {
        this.settings.excludedDependencies.push(dependencyToExclude);
      }
    }
    await this.saveSettings();
  }

  /**
   * @private
   */
  isSameDependency(source, target) {
    return source.name === target.name && source.version === target.version;
  }

  /**
   * @private
   */
  async ensureSettings() {
    if (!this.settings) {
      const snapshot = await this.database.ref('settings').once('value');
      this.settings = snapshot.val();

      this.log.info(`Loaded settings: ${JSON.stringify(this.settings)}`);

      if (!this.settings) {
        this.settings = {};
      }
      if (!this.settings.excludedDependencies) {
        this.settings.excludedDependencies = [];
      }
    }
  }

  /**
   * @private
   */
  async saveSettings() {
    await this.database.ref('settings').set(this.settings);
    this.log.info(`Saved settings: ${JSON.stringify(this.settings)}`);
  }

  /**
   * @param {string} commitSha
   */
  async setUpdatesBranchHead(commitSha) {
    await this.ensureSettings();
    this.settings.updatesBranchHead = commitSha;
    await this.saveSettings();
  }

  /**
   * @return {Promise<Array<{name:string, version: string}>>}
   */
  async getExcludedDependencies() {
    await this.ensureSettings();
    return this.settings.excludedDependencies;
  }
}

exports.Storage = Storage;
