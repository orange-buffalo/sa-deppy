const got = require("got");
const {readFileContent} = require('./utils');
const fs = require('fs').promises;
const merge = require('lodash.merge');
const xpath = require('xpath');
const {DOMParser} = require('xmldom');

/**
 * @typedef VersionDefinition
 * @property {string} definitionString
 * @property {string} definitionKey
 * @property {string} currentVersion
 */

/**
 * @typedef DependencyDefinition
 * @property {string} groupId
 * @property {string} artifactId
 */

/**
 * @typedef PluginDefinition
 * @property {string} pluginId
 */

/**
 * @typedef UpdateContext
 * @property {import('./exclude-strategy').ExcludeStrategy} excludeStrategy
 * @property {Array<string>} updatesList
 * @property {string} versionsDefinitionsFileContent
 */

const VERSION_DEFINITION_REGEX = /(val\s+(.*)\s*=\s*"(.*)")/g;
const DEPENDENCY_DEFINITION_REGEX = /"(.*):(.*):\${Versions\.(.*)}"/g;
const PLUGIN_DEFINITION_REGEX = /id.*"(.*)".*Versions\.(.*)/g;

class GradleUpdater {

  /**
   * @param {import('pino').BaseLogger} log
   */
  constructor({log}) {
    this.log = log.child({name: 'gradle-updater'});
  }

  /**
   * @param {string} localRepoDirectory
   * @param {import('./exclude-strategy').ExcludeStrategy} excludeStrategy
   */
  async executeUpdate(localRepoDirectory, excludeStrategy) {
    this.log.info(`Checking for gradle dependencies updates..`);

    const updatesList = [];

    try {
      await this.checkForBuildSrcUpdates(localRepoDirectory, excludeStrategy, updatesList);
      await this.checkForDependenciesUpdates(localRepoDirectory, excludeStrategy, updatesList);

      this.log.info(`Found updates: ${JSON.stringify(updatesList)}`);
      if (updatesList.length) {
        return {
          title: 'Gradle dependencies',
          updated: updatesList,
        }
      }
    } catch (e) {
      this.log.error('Update of gradle dependencies failed');
      this.log.error(e);
    }
    return null;
  }

  /**
   * @param {string} localRepoDirectory
   * @param {import('./exclude-strategy').ExcludeStrategy} excludeStrategy
   * @param {Array<string>} updatesList
   * @private
   */
  async checkForBuildSrcUpdates(localRepoDirectory, excludeStrategy, updatesList) {
    const buildKtsPath = `${localRepoDirectory}/buildSrc/build.gradle.kts`;
    this.log.info(`Will check updates for build src script ${buildKtsPath}`);
    const buildKtsContent = await readFileContent(buildKtsPath);
    const dependenciesDefinitions = this.extractDependenciesDefinitions(buildKtsContent);
    await this.updateDependenciesAndPlugins(buildKtsPath, excludeStrategy, updatesList, dependenciesDefinitions, []);
    this.log.info(`Build src script dependencies updated`);
  }

  /**
   * @param {string} localRepoDirectory
   * @param {import('./exclude-strategy').ExcludeStrategy} excludeStrategy
   * @param {Array<string>} updatesList
   * @private
   */
  async checkForDependenciesUpdates(localRepoDirectory, excludeStrategy, updatesList) {
    const gradleBuildPaths = [
      `${localRepoDirectory}/build.gradle.kts`,
      `${localRepoDirectory}/frontend/build.gradle.kts`,
      `${localRepoDirectory}/backend/build.gradle.kts`,
    ];

    const dependenciesDefinitions = {};
    const pluginsDefinitions = {};
    for (let gradleBuildPath of gradleBuildPaths) {
      const gradleBuildContent = await readFileContent(gradleBuildPath);

      const localDependencies = await this.extractDependenciesDefinitions(gradleBuildContent);
      merge(dependenciesDefinitions, localDependencies);

      const localPlugins = await this.extractPluginsDefinitions(gradleBuildContent);
      merge(pluginsDefinitions, localPlugins);
    }

    const dependenciesVersionsPath = `${localRepoDirectory}/buildSrc/src/main/kotlin/Dependencies.kt`;
    await this.updateDependenciesAndPlugins(
      dependenciesVersionsPath,
      excludeStrategy,
      updatesList,
      dependenciesDefinitions,
      pluginsDefinitions);
    this.log.info(`Dependencies updated`);
  }

  /**
   * @param {string} versionsFilePath
   * @param {import('./exclude-strategy').ExcludeStrategy} excludeStrategy
   * @param {Array<string>} updatesList
   * @param {Array<Array<DependencyDefinition>>} dependenciesDefinitions
   * @param {Array<Array<PluginDefinition>>} pluginsDefinitions
   * @private
   */
  async updateDependenciesAndPlugins(
    versionsFilePath,
    excludeStrategy,
    updatesList,
    dependenciesDefinitions,
    pluginsDefinitions
  ) {
    this.log.info(`Processing versions definitions in ${versionsFilePath}`);

    const versionsDefinitionsFileContent = await readFileContent(versionsFilePath);
    const versionsDefinitions = this.extractVersionsDefinitions(versionsDefinitionsFileContent);

    /**
     * @type {UpdateContext}
     */
    const updateContext = {
      excludeStrategy,
      updatesList,
      versionsDefinitionsFileContent,
    }

    for (let versionDefinition of versionsDefinitions) {
      this.log.info(`Found definition for ${versionDefinition.definitionKey} of version ${versionDefinition.currentVersion}`);

      this.log.info('Checking for dependencies updates');
      await this.processArtifactsUpdates(
        dependenciesDefinitions,
        versionDefinition,
        updateContext,
        async (dependencyDefinition) => await this
          .getLatestMavenVersions(dependencyDefinition.groupId, dependencyDefinition.artifactId));

      this.log.info('Checking for plugins updates');
      await this.processArtifactsUpdates(
        pluginsDefinitions,
        versionDefinition,
        updateContext,
        async (pluginDefinition) => await this.getLatestPluginVersion(pluginDefinition.pluginId));
    }

    if (versionsDefinitionsFileContent !== updateContext.versionsDefinitionsFileContent) {
      this.log.info(`New updates found, writing new content to ${versionsFilePath}`);
      await fs.writeFile(versionsFilePath, updateContext.versionsDefinitionsFileContent);
    }
  }

  /**
   *
   * @param {Array<Array<T>>} artifactsDefinitions
   * @param {VersionDefinition} versionDefinition
   * @param {UpdateContext} updateContext
   * @param {?function(definition: T): Array<string>} latestVersionResolver
   * @template T
   * @private
   */
  async processArtifactsUpdates(
    artifactsDefinitions,
    versionDefinition,
    updateContext,
    latestVersionResolver
  ) {
    const relatedArtifacts = artifactsDefinitions[versionDefinition.definitionKey];
    if (relatedArtifacts) {
      for (let artifactDefinition of relatedArtifacts) {
        this.log.info(`${versionDefinition.definitionKey} used for ${JSON.stringify(artifactDefinition)}`);
        const latestVersionFound = await this.processArtifactUpdate(
          artifactDefinition,
          versionDefinition,
          updateContext,
          latestVersionResolver
        );
        if (latestVersionFound) {
          this.log.info('Skipping other related dependencies as latest version already found');
          break;
        }
      }
    } else {
      this.log.info('No related artifacts found');
    }
  }

  /**
   * @param {string} fileContent
   * @return Array<VersionDefinition>
   * @private
   */
  extractVersionsDefinitions(fileContent) {
    const matches = fileContent.matchAll(VERSION_DEFINITION_REGEX);
    /**
     * @type Array<VersionDefinition>
     */
    const definitions = [];
    for (let match of matches) {
      definitions.push({
        definitionString: match[1],
        definitionKey: match[2].trim(),
        currentVersion: match[3].trim(),
      });
    }
    return definitions;
  }

  /**
   * @param {string} fileContent
   * @return Array<Array<DependencyDefinition>>
   * @private
   */
  extractDependenciesDefinitions(fileContent) {
    /**
     * @type {Array<Array<DependencyDefinition>>}
     */
    const definitions = [];
    const matches = fileContent.matchAll(DEPENDENCY_DEFINITION_REGEX);
    for (let match of matches) {
      const definitionKey = match[3].trim();
      let definitionsForKey = definitions[definitionKey];
      if (!definitionsForKey) {
        definitionsForKey = [];
        definitions[definitionKey] = definitionsForKey;
      }
      definitionsForKey.push({
        groupId: match[1].trim(),
        artifactId: match[2].trim(),
      });
    }
    return definitions;
  }

  /**
   * @param {string} fileContent
   * @return Array<Array<PluginDefinition>>
   * @private
   */
  extractPluginsDefinitions(fileContent) {
    /**
     * @type {Array<Array<PluginDefinition>>}
     */
    const definitions = [];
    const matches = fileContent.matchAll(PLUGIN_DEFINITION_REGEX);
    for (let match of matches) {
      const definitionKey = match[2].trim();
      let definitionsForKey = definitions[definitionKey];
      if (!definitionsForKey) {
        definitionsForKey = [];
        definitions[definitionKey] = definitionsForKey;
      }
      definitionsForKey.push({
        pluginId: match[1].trim(),
      });
    }
    return definitions;
  }

  /**
   * @param {T} artifactDefinition
   * @param {VersionDefinition} versionDefinition
   * @param {UpdateContext} updateContext
   * @param {?function(definition: T): Array<string>} latestVersionResolver
   * @template T
   * @private
   */
  async processArtifactUpdate(artifactDefinition, versionDefinition, updateContext, latestVersionResolver) {
    this.log.info(`Checking updates for ${JSON.stringify(artifactDefinition)}`);

    const latestVersions = await latestVersionResolver(artifactDefinition);
    for (let newerVersionCandidate of latestVersions) {
      this.log.info(`Newer version candidate for this artifact is ${newerVersionCandidate}`);

      if (newerVersionCandidate !== versionDefinition.currentVersion) {
        if (updateContext.excludeStrategy.isExcluded(versionDefinition.definitionKey, newerVersionCandidate)) {
          this.log.info(`Skipping this version as it is excluded`);
        } else {
          const updatedVersionDefinitionString = versionDefinition.definitionString
            .replace(versionDefinition.currentVersion, newerVersionCandidate);
          updateContext.versionsDefinitionsFileContent = updateContext.versionsDefinitionsFileContent
            .replace(versionDefinition.definitionString, updatedVersionDefinitionString);

          const updateMessage = `Updated \`${versionDefinition.definitionKey}\` from \`${versionDefinition.currentVersion}\` to \`${newerVersionCandidate}\``;
          // some definitions might be repeated in buildSrc and project build files
          if (updateContext.updatesList.indexOf(updateMessage) < 0) {
            updateContext.updatesList.push(updateMessage);
          }

          this.log.info(`Updated ${versionDefinition.definitionKey} to ${newerVersionCandidate}`);
          return true;
        }
      } else {
        this.log.info('Already on the this version, skipping older versions checks');
        return true;
      }
    }
    return latestVersions.length !== 0;
  }

  /**
   * @param {string} groupId
   * @param {string} artifactId
   * @return {Promise<Array<string>>} latest versions, newer versions first
   * @private
   */
  async getLatestMavenVersions(groupId, artifactId) {
    try {
      const {body: mavenSearchResponse} = await got
        .get(`https://search.maven.org/solrsearch/select?q=g:"${groupId}"+AND+a:"${artifactId}"&wt=json&core=gav`, {
          responseType: 'json'
        });
      if (mavenSearchResponse.response
        && mavenSearchResponse.response.docs
        && mavenSearchResponse.response.docs.length) {
        return mavenSearchResponse.response.docs.map(it => it.v);
      }
    } catch (e) {
      this.log.error(`Failed to retrieve metadata for ${groupId}:${artifactId}`);
      this.log.error(e);
    }
    this.log.warn(`Was not able to get the latest versions for ${groupId}:${artifactId}`);
    return [];
  }

  /**
   * @param {string} pluginId
   * @return {Promise<Array<string>>} latest versions, newer versions first
   * @private
   */
  async getLatestPluginVersion(pluginId) {
    try {
      const pluginPath = pluginId.replace('.', '/');
      const {body: mavenMetadataXml} = await got
        .get(`https://plugins.gradle.org/m2/${pluginPath}/${pluginId}.gradle.plugin/maven-metadata.xml`);
      const mavenMetadataDoc = new DOMParser().parseFromString(mavenMetadataXml);
      return xpath.select("//metadata/versioning/versions/version/text()", mavenMetadataDoc)
        .map(it => it.data)
        .reverse();
    } catch (e) {
      this.log.error(`Failed to retrieve metadata for ${pluginId}`);
      this.log.error(e);
    }

    this.log.warn(`Was not able to get the latest versions for plugin ${pluginId}`);
    return [];
  }
}

exports.GradleUpdater = GradleUpdater;
