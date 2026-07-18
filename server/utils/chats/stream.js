const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
const { getVectorDbClass, resolveProviderConnector } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { grepAgents } = require("./agents");
const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  recentChatHistory,
  sourceIdentifier,
} = require("./index");

const VALID_CHAT_MODE = ["automatic", "chat", "query"];

async function streamChatWithWorkspace(
  response,
  workspace,
  message,
  chatMode = "automatic",
  user = null,
  thread = null,
  attachments = []
) {
  const uuid = uuidv4();
  const updatedMessage = await grepCommand(message, user);

  if (Object.keys(VALID_COMMANDS).includes(updatedMessage)) {
    const data = await VALID_COMMANDS[updatedMessage](
      workspace,
      message,
      uuid,
      user,
      thread
    );
    writeResponseChunk(response, data);
    return;
  }

  // If is agent enabled chat we will exit this flow early.
  const isAgentChat = await grepAgents({
    uuid,
    response,
    message: updatedMessage,
    user,
    workspace,
    thread,
    attachments,
  });
  if (isAgentChat) return;

  const {
    connector: LLMConnector,
    routingMetadata,
    prefetchedContext,
    error: routerError,
  } = await resolveLLMConnector({
    workspace,
    message: updatedMessage,
    user,
    thread,
    attachments,
  });

  if (routerError) {
    return writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: routerError,
    });
  }

  if (routingMetadata?.routedTo?.shouldNotify) {
    writeResponseChunk(response, {
      uuid: `${uuid}:route`,
      type: "modelRouteNotification",
      routedTo: routingMetadata.routedTo,
    });
  }

  const VectorDb = getVectorDbClass();

  const messageLimit = workspace?.openAiHistory || 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no vector namespace at all.
  // With the synthesis pipeline we only exit early when the namespace does not exist.
  if (!hasVectorizedSpace && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      attachments,
      close: true,
      error: null,
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText;
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];

  // If the router pre-fetched context we can reuse it; otherwise fetch fresh.
  const {
    rawHistory,
    chatHistory,
    pinnedDocs: prefetchedPinnedDocs,
    parsedFiles: prefetchedParsedFiles,
  } = prefetchedContext ??
  (await recentChatHistory({ user, workspace, thread, messageLimit }));

  // Pinned docs — reuse pre-fetched if available, otherwise fetch with token cap.
  const pinnedDocs =
    prefetchedPinnedDocs ??
    (await new DocumentManager({
      workspace,
      maxTokens: LLMConnector.promptWindowLimit(),
    }).pinnedDocs());
  pinnedDocs.forEach((doc) => {
    const { pageContent, ...metadata } = doc;
    pinnedDocIdentifiers.push(sourceIdentifier(doc));
    contextTexts.push(doc.pageContent);
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  });

  // Parsed files — reuse pre-fetched if available, otherwise fetch fresh.
  const parsedFiles =
    prefetchedParsedFiles ??
    (await WorkspaceParsedFiles.getContextFiles(
      workspace,
      thread || null,
      user || null
    ));
  parsedFiles.forEach((doc) => {
    const { pageContent, ...metadata } = doc;
    contextTexts.push(doc.pageContent);
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  });

  // ── STAP 1: Directe LanceDB query ──────────────────────────────────────────
  // Altijd uitvoeren wanneer de namespace bestaat, ongeacht chatMode.
  // Soft-fail zodat de pipeline doorgaat bij een lege/kapotte namespace.
  let vectorSearchResults = { contextTexts: [], sources: [], message: null };
  if (hasVectorizedSpace) {
    try {
      const result = await VectorDb.performSimilaritySearch({
        namespace: workspace.slug,
        input: updatedMessage,
        LLMConnector,
        similarityThreshold: workspace?.similarityThreshold,
        topN: workspace?.topN,
        filterIdentifiers: pinnedDocIdentifiers,
        rerank: workspace?.vectorSearchMode === "rerank",
      });
      if (result.message) {
        console.warn(`[SYNTHESIS:VAULT] Vector search warning: ${result.message}`);
      } else {
        vectorSearchResults = result;
      }
    } catch (e) {
      console.warn(`[SYNTHESIS:VAULT] Vector search error: ${e.message}`);
    }
  }

  console.log(`[SYNTHESIS:VAULT] Query: "${updatedMessage.slice(0, 100)}"`);
  console.log(`[SYNTHESIS:VAULT] Gevonden chunks: ${vectorSearchResults.contextTexts.length}`);
  vectorSearchResults.contextTexts.forEach((t, i) =>
    console.log(`[SYNTHESIS:VAULT] Chunk ${i + 1}: "${t.slice(0, 200)}..."`)
  );

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });
  sources = [...sources, ...vectorSearchResults.sources];

  // Base system prompt (hergebruik van pre-fetch wanneer beschikbaar).
  const baseSystemPrompt =
    prefetchedContext?.systemPrompt ??
    (await chatPrompt(workspace, user, {
      prompt: updatedMessage,
      rawHistory,
    }));

  // ── STAP 2: Ruwe LLM-call zonder vault-context ──────────────────────────────
  // Pinned docs en parsed files gaan wel mee (contextTexts), vault-chunks niet.
  // Dit geeft de "eigen redenering" van de LLM als baseline voor de synthese.
  const rawMessages = await LLMConnector.compressMessages(
    {
      systemPrompt: baseSystemPrompt,
      userPrompt: updatedMessage,
      contextTexts,   // pinned docs + parsed files, géén vault search results
      chatHistory,
      attachments,
    },
    rawHistory
  );

  const { textResponse: llmDraft } = await LLMConnector.getChatCompletion(
    rawMessages,
    {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user,
    }
  );

  console.log(
    `[SYNTHESIS:LLM] Ruw LLM-antwoord (geen vault-context): "${(llmDraft ?? "").slice(0, 500)}..."`
  );

  // ── STAP 3: Synthese-call — vault + LLM-draft → finaal antwoord ─────────────
  const vaultTexts = filledSources.contextTexts;
  const vaultSection =
    vaultTexts.length > 0
      ? vaultTexts.map((t, i) => `[${i + 1}] ${t.trim()}`).join("\n\n")
      : "Geen relevante vault-context gevonden voor deze query.";

  const synthesisSystemPrompt =
    `${baseSystemPrompt}\n\n` +
    `Je bent een synthese-engine. Je ontvangt twee bronnen:\n\n` +
    `[Kennis uit Vault]\n${vaultSection}\n[/Kennis uit Vault]\n\n` +
    `[Initieel LLM Antwoord]\n${llmDraft ?? ""}\n[/Initieel LLM Antwoord]\n\n` +
    `Formuleer een finaal antwoord waarbij de Vault als primaire bron dient. ` +
    `Gebruik het initieel LLM-antwoord als context en contrast. ` +
    `Als Vault en LLM-antwoord tegenstrijdig zijn, benoem dit expliciet en geef prioriteit aan de Vault.`;

  // Enkelvoudige 2-bericht array voor de synthesestap (geen history-compressie nodig).
  const synthesisMessages = [
    { role: "system", content: synthesisSystemPrompt },
    { role: "user",   content: updatedMessage },
  ];

  console.log(`[SYNTHESIS:FINAL] Synthese-prompt verstuurd naar LLM...`);

  // Streaming of non-streaming afhankelijk van de connector.
  if (LLMConnector.streamingEnabled() !== true) {
    console.log(
      `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
    );
    const { textResponse, metrics: performanceMetrics } =
      await LLMConnector.getChatCompletion(synthesisMessages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user,
      });

    completeText = textResponse;
    metrics = performanceMetrics;
    writeResponseChunk(response, {
      uuid,
      sources,
      type: "textResponseChunk",
      textResponse: completeText,
      close: true,
      error: false,
      metrics,
    });
  } else {
    const stream = await LLMConnector.streamGetChatCompletion(synthesisMessages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user,
    });
    completeText = await LLMConnector.handleStream(response, stream, {
      uuid,
      sources,
    });
    metrics = stream.metrics;
  }

  if (completeText?.length > 0) {
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: completeText,
        sources,
        type: chatMode,
        attachments,
        metrics,
      },
      threadId: thread?.id || null,
      user,
    });

    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      chatId: chat.id,
      metrics,
    });
    return;
  }

  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
    metrics,
  });
  return;
}

async function resolveLLMConnector({
  workspace,
  message,
  user,
  thread,
  attachments,
}) {
  try {
    const result = await resolveProviderConnector({
      workspace,
      prompt: message,
      user,
      thread,
      attachments,
    });
    return { ...result, error: null };
  } catch (routerError) {
    return {
      connector: null,
      routingMetadata: null,
      prefetchedContext: null,
      error: `Model router error: ${routerError.message}`,
    };
  }
}

module.exports = {
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
