/**
 * CodeSage — Inline Completions (ghost-text autocomplete).
 *
 * This module is loaded by extension/dist/extension.js AFTER the original
 * CodeSage bundle activates. It registers a VS Code InlineCompletionItemProvider
 * that calls an OpenAI-compatible LLM endpoint to produce ghost-text code
 * suggestions as the user types.
 *
 * Design principles (informed by history.txt bugs #1-#5 — key quota exhaustion):
 *   - OFF BY DEFAULT. Autocomplete fires on every keystroke; opt-in avoids
 *     re-triggering the 429 quota chain that was just fixed.
 *   - DEBOUNCED (~400ms default) + abort-on-new-keystroke. No request pile-up.
 *   - Errors (quota/network) are caught and silently drop the ghost text.
 *     Never a modal error mid-typing.
 *
 * ALL settings (enable/disable, provider, model, debounce, trigger mode,
 * context window sizes) live in CodeSage's own "API Configuration" webview
 * panel — there is NO VS Code settings.json / package.json configuration
 * surface for this feature. This mirrors the request that drove this
 * rewrite: reuse the extension's own already-configured API key system
 * (the same provider keys + rotation used for chat) rather than requiring a
 * separate dedicated API key. The only thing that's specific to inline
 * completions is which provider + model to use — everything else (the
 * actual API key, rotation across multiple keys, base URL for known
 * providers) is resolved through the SAME storage/rotation system chat uses.
 *
 * Storage:
 *   - Inline-completions config (enabled/providerId/modelId) is persisted in
 *     VS Code SecretStorage under `codesage:inlineCompletions:config`
 *     (written by the webview via the codesage_setInlineCompletionsConfig
 *     message handler in extension.original.js).
 *   - The actual API key for the chosen provider is read from the SAME
 *     VS Code SecretStorage slot the chat key-rotation system already
 *     maintains (`__CS_LEGACY_KEY_MAP[providerId]`, e.g. "geminiApiKey") —
 *     this is kept live-updated by count-based rotation, error-triggered
 *     rotation, and manual key selection (see history.txt). No separate
 *     credential entry is needed or supported.
 *
 * The LLM call uses the OpenAI /v1/chat/completions shape (non-streaming).
 * Only providers with an OpenAI-compatible chat endpoint are offered in the
 * provider dropdown (see PROVIDER_BASE_URLS below) — Anthropic/Gemini-native
 * request shapes are out of scope for this simple completion call.
 */

"use strict";

const vscode = require("vscode");

// ----------------------------------------------------------------------------
// Same provider -> legacy secret-key-name map used by the chat key-rotation
// system (extension.original.js: __CS_LEGACY_KEY_MAP). Duplicated here since
// this module runs as a separate require() outside that bundle's closure.
// Keep in sync if the rotation system's provider list changes.
// ----------------------------------------------------------------------------
const LEGACY_KEY_MAP = {
  openai: "openAiApiKey",
  "openai-native": "openAiNativeApiKey",
  openrouter: "openRouterApiKey",
  groq: "groqApiKey",
  deepseek: "deepSeekApiKey",
  together: "togetherApiKey",
  fireworks: "fireworksApiKey",
  mistral: "mistralApiKey",
  xai: "xaiApiKey",
  moonshot: "moonshotApiKey",
  cerebras: "cerebrasApiKey",
  sambanova: "sambanovaApiKey",
  qwen: "qwenApiKey",
  ollama: "ollamaApiKey",
};

// Only OpenAI-chat-compatible endpoints are supported here.
const PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  "openai-native": "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  moonshot: "https://api.moonshot.cn/v1",
  cerebras: "https://api.cerebras.ai/v1",
  sambanova: "https://api.sambanova.ai/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ollama: "http://localhost:11434/v1",
};

const CONFIG_SECRET_KEY = "codesage:inlineCompletions:config";

const DEFAULT_CONFIG = {
  enabled: false,
  providerId: "",
  modelId: "",
  debounceMs: 400,
  trigger: "auto", // "auto" | "manual"
  maxPrefixChars: 3000,
  maxSuffixChars: 1500,
};

/**
 * Read the persisted inline-completions config. This is the single source
 * of truth — written exclusively by the webview's API Configuration panel
 * via extension.original.js's codesage_setInlineCompletionsConfig handler.
 */
async function readConfig(context) {
  try {
    const raw = await context.secrets.get(CONFIG_SECRET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (e) {
    // fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Resolve the API key + base URL for the configured provider, reusing the
 * exact same VS Code SecretStorage slot the chat key-rotation system reads
 * and writes (see extension.original.js: __csMirrorLegacyKey /
 * __CS_LEGACY_KEY_MAP). If the user has multiple keys configured for this
 * provider with rotation enabled, inline completions automatically pick up
 * whichever key is currently active — no separate setup needed.
 */
async function resolveCredentials(context, cfg) {
  if (!cfg.providerId || !cfg.modelId) return null;

  const secretName = LEGACY_KEY_MAP[cfg.providerId];
  const baseUrl = PROVIDER_BASE_URLS[cfg.providerId];
  if (!secretName || !baseUrl) return null; // unsupported provider

  let apiKey = null;
  try {
    apiKey = await context.secrets.get(secretName);
  } catch (e) {
    apiKey = null;
  }
  // Ollama runs locally and doesn't require a key.
  if (!apiKey && cfg.providerId !== "ollama") return null;

  return { apiKey: apiKey || "ollama", baseUrl, model: cfg.modelId };
}

async function fetchCompletion({ apiKey, baseUrl, model, prefix, suffix, languageId, signal }) {
  const userMessage =
    `Language: ${languageId || "unknown"}\n\n` +
    `Code before cursor:\n\`\`\`\n${prefix}\n\`\`\`\n\n` +
    `Code after cursor:\n\`\`\`\n${suffix}\n\`\`\`\n\n` +
    `Output only the code to insert at the cursor position:`;

  const body = JSON.stringify({
    model: model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    max_tokens: 256,
    temperature: 0.2,
    stream: false,
  });

  const url = `${baseUrl}/chat/completions`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter likes a referer/title header; harmless for other providers.
  if (baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/chalaha728-lab/codesage";
    headers["X-Title"] = "CodeSage Inline Completions";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!resp.ok) {
    // Silently fail — don't surface modal errors mid-typing.
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content =
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    "";
  return content;
}

/**
 * Clean up the raw LLM output: strip markdown fences, trim, fix indentation.
 */
function cleanCompletion(raw, prefixLine) {
  let text = raw;

  // Strip markdown code fences if the model added them despite instructions.
  text = text.replace(/^```[\w]*\n?/g, "").replace(/\n?```$/g, "");

  // Trim trailing newline that would push the cursor down.
  text = text.replace(/\n+$/, "");

  // If the prefix line has leading whitespace and the completion doesn't
  // start with that indentation, try to align it.
  const prefixIndent = prefixLine.match(/^[\t ]*/);
  if (prefixIndent && prefixIndent[0] && !text.startsWith(prefixIndent[0])) {
    // Only auto-indent single-line completions (multi-line is trickier).
    if (!text.includes("\n")) {
      text = prefixIndent[0] + text.trimStart();
    }
  }

  return text;
}

// ----------------------------------------------------------------------------
// InlineCompletionItemProvider implementation.
// ----------------------------------------------------------------------------

class CodeSageInlineCompletionProvider {
  constructor(context) {
    this.context = context;
    this.abortController = null;
    this.debounceTimer = null;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.text = "$(sparkle) CodeSage";
    this.statusBarItem.tooltip = "CodeSage inline completions";
    this.statusBarItem.command = "codesage.toggleInlineCompletions";
    this.statusBarItem.hide();
  }

  async provideInlineCompletionItems(document, position, context, token) {
    const cfg = await readConfig(this.context);
    if (!cfg.enabled) return { items: [] };
    if (!cfg.providerId || !cfg.modelId) return { items: [] };

    if (cfg.trigger === "manual" && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
      return { items: [] };
    }

    const excludedLangs = ["plaintext", "markdown", "log"];
    if (excludedLangs.includes(document.languageId)) return { items: [] };

    // Abort any in-flight request (abort-on-new-keystroke).
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const debounceMs = cfg.debounceMs || 400;
    const maxPrefix = cfg.maxPrefixChars || 3000;
    const maxSuffix = cfg.maxSuffixChars || 1500;

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) {
          resolve({ items: [] });
          return;
        }

        let creds;
        try {
          creds = await resolveCredentials(this.context, cfg);
        } catch (e) {
          creds = null;
        }
        if (!creds) {
          resolve({ items: [] });
          return;
        }

        const text = document.getText();
        const offset = document.offsetAt(position);
        const prefixStart = Math.max(0, offset - maxPrefix);
        const suffixEnd = Math.min(text.length, offset + maxSuffix);
        const prefix = text.slice(prefixStart, offset);
        const suffix = text.slice(offset, suffixEnd);

        const line = document.lineAt(position.line);
        const prefixLine = line.text.slice(0, position.character);

        if (prefix.trim().length === 0 && prefix.length < 3) {
          resolve({ items: [] });
          return;
        }

        this.abortController = new AbortController();
        this.statusBarItem.show();

        try {
          const raw = await fetchCompletion({
            apiKey: creds.apiKey,
            baseUrl: creds.baseUrl,
            model: creds.model,
            prefix,
            suffix,
            languageId: document.languageId,
            signal: this.abortController.signal,
          });

          if (token.isCancellationRequested) {
            resolve({ items: [] });
            return;
          }

          const cleaned = cleanCompletion(raw, prefixLine);
          if (!cleaned || cleaned.trim().length === 0) {
            resolve({ items: [] });
            return;
          }

          const item = new vscode.InlineCompletionItem(
            cleaned,
            new vscode.Range(position, position)
          );
          resolve({ items: [item] });
        } catch (err) {
          if (err.name === "AbortError") {
            // Normal — a newer keystroke aborted this request.
          } else {
            console.error("[CodeSage InlineCompletions]", err.message);
          }
          resolve({ items: [] });
        } finally {
          this.abortController = null;
          this.statusBarItem.hide();
        }
      }, debounceMs);
    });
  }
}

// ----------------------------------------------------------------------------
// Registration entry point — called by extension.js wrapper.
// ----------------------------------------------------------------------------

async function saveConfig(context, patch) {
  const cfg = await readConfig(context);
  const next = { ...cfg, ...patch };
  await context.secrets.store(CONFIG_SECRET_KEY, JSON.stringify(next));
  return next;
}

/**
 * Native VS Code QuickPick flow to choose provider + model. Deliberately NOT
 * a webview UI — this repo's minified webview bundle has broken the whole
 * panel twice from direct-edit attempts (see history.txt). QuickPick/InputBox
 * are stable, built-in VS Code APIs that don't touch that bundle at all.
 */
async function runConfigureFlow(context) {
  const providerItems = Object.keys(PROVIDER_BASE_URLS).map((id) => ({
    label: id,
    description: LEGACY_KEY_MAP[id] ? `uses your existing "${id}" key` : "",
    id,
  }));

  const providerPick = await vscode.window.showQuickPick(providerItems, {
    title: "CodeSage Inline Completions — Provider (1/2)",
    placeHolder: "Pick the provider to use for inline completions",
    ignoreFocusOut: true,
  });
  if (!providerPick) return;

  const secretName = LEGACY_KEY_MAP[providerPick.id];
  let hasKey = false;
  try {
    hasKey = !!(await context.secrets.get(secretName));
  } catch (e) {
    hasKey = false;
  }
  if (!hasKey && providerPick.id !== "ollama") {
    const choice = await vscode.window.showWarningMessage(
      `No API key found for "${providerPick.id}" yet. Add one under CodeSage's ` +
        `Key Management for this provider first — inline completions reuses ` +
        `that same key (including rotation, if you have multiple).`,
      "Continue anyway",
      "Cancel"
    );
    if (choice !== "Continue anyway") return;
  }

  const suggestedModels = SUGGESTED_MODELS[providerPick.id] || [];
  const modelItems = [
    ...suggestedModels.map((m) => ({ label: m })),
    { label: "$(edit) Custom model id…", custom: true },
  ];
  const modelPick = await vscode.window.showQuickPick(modelItems, {
    title: "CodeSage Inline Completions — Model (2/2)",
    placeHolder: `Pick a model for ${providerPick.id}`,
    ignoreFocusOut: true,
  });
  if (!modelPick) return;

  let modelId = modelPick.label;
  if (modelPick.custom) {
    modelId = await vscode.window.showInputBox({
      title: "CodeSage Inline Completions — Custom model id",
      placeHolder: "exact model id, e.g. gpt-4o-mini",
      ignoreFocusOut: true,
    });
    if (!modelId) return;
  }

  await saveConfig(context, {
    enabled: true,
    providerId: providerPick.id,
    modelId,
  });
  vscode.window.showInformationMessage(
    `CodeSage inline completions: ON — ${providerPick.id} / ${modelId}`
  );
}

// A short curated list of fast/cheap models per provider for the QuickPick.
// Users can always pick "Custom model id…" for anything else.
const SUGGESTED_MODELS = {
  openai: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"],
  "openai-native": ["gpt-4o-mini", "gpt-4.1-mini"],
  openrouter: [
    "openai/gpt-4o-mini",
    "meta-llama/llama-3.1-8b-instruct",
    "google/gemini-2.0-flash-001",
  ],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  deepseek: ["deepseek-chat", "deepseek-coder"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  fireworks: ["accounts/fireworks/models/llama-v3p1-8b-instruct"],
  mistral: ["codestral-latest", "mistral-small-latest"],
  xai: ["grok-2-latest"],
  moonshot: ["moonshot-v1-8k"],
  cerebras: ["llama-3.3-70b", "llama3.1-8b"],
  sambanova: ["Meta-Llama-3.1-8B-Instruct"],
  qwen: ["qwen2.5-coder-32b-instruct"],
  ollama: ["qwen2.5-coder:7b", "codellama:7b"],
};

function register(context) {
  const provider = new CodeSageInlineCompletionProvider(context);

  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    provider
  );
  context.subscriptions.push(disposable);

  // Main entry point — pick provider + model, reusing existing keys.
  const configureCmd = vscode.commands.registerCommand(
    "codesage.configureInlineCompletions",
    () => runConfigureFlow(context)
  );
  context.subscriptions.push(configureCmd);

  // Quick on/off toggle for whatever provider/model was last configured.
  const toggleCmd = vscode.commands.registerCommand(
    "codesage.toggleInlineCompletions",
    async () => {
      const cfg = await readConfig(context);
      if (!cfg.providerId || !cfg.modelId) {
        vscode.window.showInformationMessage(
          "CodeSage inline completions: not configured yet — running setup…"
        );
        await runConfigureFlow(context);
        return;
      }
      const next = await saveConfig(context, { enabled: !cfg.enabled });
      vscode.window.showInformationMessage(
        `CodeSage inline completions: ${next.enabled ? "ON" : "OFF"} (${next.providerId} / ${next.modelId})`
      );
    }
  );
  context.subscriptions.push(toggleCmd);

  readConfig(context).then((cfg) => {
    if (cfg.enabled) provider.statusBarItem.show();
    console.log("[CodeSage] Inline completions provider registered (enabled:", cfg.enabled + ")");
  });
}

module.exports = { register };
