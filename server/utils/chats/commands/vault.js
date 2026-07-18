const path = require("path");
const filesystem = require("../../agents/aibitat/plugins/filesystem/lib.js");
const { getLLMProvider } = require("../../helpers");

/**
 * Slugify a title into a safe filename fragment.
 * @param {string} text
 * @returns {string}
 */
function slugifyTitle(text) {
  return (
    String(text)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "inzicht"
  );
}

/**
 * Formats a Date as DD/MM/YYYY HH:MM for the note metadata.
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Builds a completion result chunk for the stream writer.
 * @param {string} msgUUID
 * @param {string} text
 * @param {boolean} error
 * @returns {object}
 */
function response(msgUUID, text, error = false) {
  return {
    uuid: msgUUID,
    type: "textResponse",
    textResponse: text,
    sources: [],
    close: true,
    error: error ? text : false,
    action: null,
  };
}

/**
 * Handles the built-in `/vault` command.
 *
 * Unlike a preset that expands to an `@agent` prompt (which relies on the model
 * choosing to call a tool), this command deterministically writes the note to
 * the allowed vault directory itself. The LLM is only used to summarize the
 * insight — never to perform the save — so the bot can never claim a save
 * happened without a file actually being written.
 *
 * @param {object} workspace
 * @param {string} message - the raw user message, e.g. "/vault my insight ..."
 * @param {string} msgUUID
 * @param {object|null} user
 * @param {object|null} thread
 */
async function saveToVault(workspace, message, msgUUID, user = null, thread = null) {
  // Everything the user typed after the command itself.
  const explicitText = String(message).replace(/^\/vault\s*/i, "").trim();

  // Resolve the vault directory (first allowed filesystem directory).
  await filesystem.ensureInitialized();
  const allowedDirs = filesystem.getAllowedDirectories();
  if (!allowedDirs.length) {
    return response(
      msgUUID,
      "Kan de vault niet vinden: er zijn geen toegestane filesystem-mappen geconfigureerd (AGENT_FILESYSTEM_ALLOWED_DIRS).",
      true
    );
  }

  // Gather recent chat context so the summary can reference the conversation.
  // Lazy require to avoid a circular dependency with chats/index.js.
  const { recentChatHistory } = require("../index.js");
  const { chatHistory } = await recentChatHistory({
    user,
    workspace,
    thread,
    messageLimit: 5,
  });

  const transcript = chatHistory
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join("\n");
  const source = explicitText || transcript;
  if (!source.trim()) {
    return response(
      msgUUID,
      "Er is niets om op te slaan. Typ het inzicht achter /vault of voer eerst een gesprek.",
      true
    );
  }

  // Ask the workspace LLM to produce a title + a clean markdown summary.
  let title = "Inzicht";
  let body = source;
  try {
    const LLMConnector = getLLMProvider({
      provider: workspace?.chatProvider,
      model: workspace?.chatModel,
    });
    const summaryPrompt = [
      {
        role: "system",
        content:
          "Je bent een assistent die inzichten samenvat voor opslag in een Obsidian-vault. " +
          "Antwoord UITSLUITEND met geldige JSON in de vorm {\"title\": \"...\", \"body\": \"...\"}. " +
          "De title is kort (max 8 woorden). De body is een heldere markdown-samenvatting van het inzicht. " +
          "Voeg geen extra tekst of codeblokken toe.",
      },
      {
        role: "user",
        content: explicitText
          ? `Inzicht om samen te vatten:\n\n${explicitText}\n\nRecente gesprekscontext:\n${transcript}`
          : `Vat het belangrijkste inzicht uit dit gesprek samen:\n\n${transcript}`,
      },
    ];

    const { textResponse } = await LLMConnector.getChatCompletion(
      summaryPrompt,
      { temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp }
    );

    const match = textResponse?.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.title) title = String(parsed.title).trim();
      if (parsed.body) body = String(parsed.body).trim();
    } else if (textResponse?.trim()) {
      body = textResponse.trim();
    }
  } catch (e) {
    // If summarization fails, fall back to saving the raw source text.
    console.error(`[/vault] Summarization failed, saving raw text: ${e.message}`);
  }

  // Deterministically write the note ourselves — no agent, no tool-calling.
  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10);
  const filename = `${datePrefix}-${slugifyTitle(title)}.md`;
  const noteContent = `# ${title}\n\n_Opgeslagen op ${formatTimestamp(now)}_\n\n${body}\n`;

  try {
    const validPath = await filesystem.validatePath(filename);
    await filesystem.writeFileContent(validPath, noteContent);
    return response(
      msgUUID,
      `Opgeslagen in de vault: \`${path.basename(validPath)}\`\n\n**${title}**\n\n${body}`
    );
  } catch (e) {
    console.error(`[/vault] Write failed: ${e.message}`);
    return response(
      msgUUID,
      `Kon het inzicht niet opslaan in de vault: ${e.message}`,
      true
    );
  }
}

module.exports = {
  saveToVault,
};
