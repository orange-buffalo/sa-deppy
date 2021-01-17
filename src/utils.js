const fs = require('fs').promises;

/**
 * @param {string} path
 * @return {Promise<string>}
 */
async function readFileContent(path) {
  return (await fs.readFile(path)).toString();
}

exports.readFileContent = readFileContent;
