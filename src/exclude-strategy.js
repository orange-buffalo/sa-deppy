class ExcludeStrategy {

  /**
   * @param {import('./storage').Storage} storage
   */
  async init(storage) {
    this.excludedDependencies = await storage.getExcludedDependencies();
    this.excludedDependenciesRegexes = await storage.getExcludedDependenciesRegexes();
  }

  hasExcludes() {
    return this.excludedDependencies.length || this.excludedDependenciesRegexes.length;
  }

  /**
   * @param {string} name
   * @param {string} version
   */
  isExcluded(name, version) {
    const explicitlyExcluded = this.excludedDependencies.some(excludedDependency =>
      excludedDependency.name === name && excludedDependency.version === version);
    if (explicitlyExcluded) {
      return true;
    }
    return this.excludedDependenciesRegexes.some(excludedDependency =>
      name.match(excludedDependency.name) && version.match(excludedDependency.version)
    );
  }
}

module.exports.ExcludeStrategy = ExcludeStrategy;
