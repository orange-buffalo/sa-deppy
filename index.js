const {SaDeppy} = require('./src/sa-deppy');
const commands = require('probot-commands');
const CronJob = require('cron').CronJob;

/**
 * @param {import('probot').Probot} bot
 */
module.exports = (bot) => {
  bot.log.info('Bot is loaded, starting initialization')

  const saDeppy = new SaDeppy({log: bot.log});

  new CronJob(
    '0 6 * * FRI',
    function () {
      // noinspection JSIgnoredPromiseFromCall
      saDeppy.executeUpdate();
    },
    null,
    true,
    'Australia/Melbourne'
  );
  // noinspection JSIgnoredPromiseFromCall
  saDeppy.executeUpdate();

  async function sendStatus(context) {
    const status = await saDeppy.getStatus(context);
    if (!status) {
      await context.octokit.issues.createComment(context.issue({
        body: 'Sorry, unsupported repo.'
      }));
      return;
    }
    let body = status.excludedDependencies.length ? 'Currently excluded dependencies:\n' : 'No excluded dependencies.';
    for (let dependency of status.excludedDependencies) {
      body += `* \`${dependency.name}:${dependency.version}\`\n`;
    }
    body += status.excludedDependenciesRegexes.length
      ? '\n\nCurrently excluded dependencies by regex:\n' : '\n\nNo excluded dependencies by regex.';
    for (let dependency of status.excludedDependenciesRegexes) {
      body += `* \`${dependency.name}:${dependency.version}\`\n`;
    }
    await context.octokit.issues.createComment(context.issue({body}));
  }

  commands(bot, 'include', async (context, command) => {
    await saDeppy.includeDependencies(command.arguments, context);
    await sendStatus(context);
  });

  commands(bot, 'includeregex', async (context, command) => {
    await saDeppy.includeDependenciesByRegexes(command.arguments, context);
    await sendStatus(context);
  });

  commands(bot, 'exclude', async (context, command) => {
    await saDeppy.excludeDependencies(command.arguments, context);
    await sendStatus(context);
  });

  commands(bot, 'excluderegex', async (context, command) => {
    await saDeppy.excludeDependenciesByRegex(command.arguments, context);
    await sendStatus(context);
  });

  commands(bot, 'clearexcluded', async (context) => {
    await saDeppy.clearExcludedDependencies(context);
    await sendStatus(context);
  });

  commands(bot, 'clearregex', async (context) => {
    await saDeppy.clearExcludedDependenciesRegexes(context);
    await sendStatus(context);
  });

  commands(bot, 'status', async (context) => {
    await sendStatus(context);
  });

  bot.on("push", async (context) => {
    await saDeppy.onPush(context);
  });
}
