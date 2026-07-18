const { Workspace } = require("../../../../../models/workspace");
const { WorkspaceThread } = require("../../../../../models/workspaceThread");
const { saveToVault } = require("../../../../chats/commands/vault");

/**
 * /vault - Deterministically saves an insight to the Obsidian vault.
 *
 * Uses the workspace LLM only to summarize the insight; the file is written
 * server-side via the filesystem lib, so a save can never be hallucinated.
 * `/vault <text>` saves that text; `/vault` alone summarizes recent history.
 * @param {import("../index").BotContext} ctx
 * @param {number} chatId
 * @param {string} [messageText] - full message text, e.g. "/vault my insight"
 */
async function handleVault(ctx, chatId, messageText = "") {
  const state = ctx.getState(chatId);
  const workspace = await Workspace.get({ slug: state.workspaceSlug });
  if (!workspace) return;

  const thread = state.threadSlug
    ? await WorkspaceThread.get({ slug: state.threadSlug })
    : null;

  await ctx.bot.sendChatAction(chatId, "typing").catch(() => {});

  try {
    const data = await saveToVault(
      workspace,
      messageText || "/vault",
      chatId.toString(),
      null,
      thread
    );
    await ctx.bot.sendMessage(
      chatId,
      data?.textResponse || "Kon het inzicht niet opslaan in de vault."
    );
  } catch (error) {
    ctx.log?.("handleVault error:", error.message);
    await ctx.bot.sendMessage(
      chatId,
      `Kon het inzicht niet opslaan in de vault: ${error.message}`
    );
  }
}

module.exports = { handleVault };
