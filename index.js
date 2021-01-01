const {SaDeppy} = require('./src/sa-deppy');
const commands = require('probot-commands');

/**
 * @param {import('probot').Probot} bot
 */
module.exports = (bot) => {
  bot.log.info('Bot is loaded, starting initialization')

  const saDeppy = new SaDeppy({log: bot.log});

  saDeppy.executeUpdate();

  commands(bot, 'include', async (context, command) => {
    await saDeppy.includeDependencies(command.arguments, context);
  });

  commands(bot, 'exclude', async (context, command) => {
    await saDeppy.excludeDependencies(command.arguments, context);
  });

  commands(bot, 'status', async (context) => {
    const status = await saDeppy.getStatus(context);
    if (!status) {
      await context.octokit.issues.createComment(context.issue({
        body: 'Sorry, unsupported repo.'
      }));
      return;
    }
    let body = status.excludedDependencies.length ? 'Currently excluded dependencies:\n' : 'No excluded dependencies.';
    for (let dependency of status.excludedDependencies) {
      body += `* ${dependency.name}:${dependency.version}\n`;
    }
    await context.octokit.issues.createComment(context.issue({body}));
  });

  bot.on("push", async (context) => {
    await saDeppy.onPush(context);
  });
}
