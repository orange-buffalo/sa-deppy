/**
 * @param {string} rawList
 */
function parseRawDependenciesList(rawList) {
  const split = rawList.split(/[\s,]/)
  const dependencies = [];
  for (let rawDependency of split) {
    const trimmed = rawDependency.trim();
    if (trimmed.length) {
      const match = trimmed.match(/(.*):(.*)/);
      if (match) {
        dependencies.push({
          name: match[1],
          version: match[2],
        })
      }
    }
  }
  return dependencies;
}

module.exports = parseRawDependenciesList;
