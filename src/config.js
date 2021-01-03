const config = {
  repo: process.env.REPO || 'orange-buffalo/simple-accounting',
  repoCloneUrl: process.env.REPO_CLONE_URL || 'https://github.com/orange-buffalo/simple-accounting.git',
  appId: process.env.APP_ID,
  appPrivateKey: process.env.PRIVATE_KEY,
  mainBranch: 'master',
  updatesBranch: 'dependencies-update',
  appInstallationId: process.env.APP_INSTALLATION_ID,

  firebase: {
    serviceKey: Buffer.from(process.env.FIREBASE_KEY, 'base64').toString('utf-8'),
    databaseURL: process.env.FIREBASE_DB_URL,
  }
}

module.exports = config;
