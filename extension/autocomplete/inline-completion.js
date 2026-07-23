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
 *   - Uses a DEDICATED model from settings (user's choice) to isolate
 *     autocomplete quota/cost from the chat model.
 *
 * Credential resolution (tries in order):
 *   1. Cline file storage (~/.cline/data/globalState.json + secrets.json).
 *      Reads `apiProvider` + the provider's API key. Only used if the provider
 *      is OpenAI-compatible (openrouter, openai) — Anthropic/Gemini use
 *      non-OpenAI request shapes and are skipped here.
 *   2. VS Code settings fallback:
 *        codesage.inlineCompletions.apiKey  (secret)
 *        codesage.inlineCompletions.baseUrl  (default: https://openrouter.ai/api/v1)
 *      This lets the user set a dedicated key for a compatible endpoint.
 *
 * The LLM call uses the OpenAI /v1/chat/completions shape (non-streaming),
 * which is compatible with: OpenRouter, OpenAI, Together, Groq, Fireworks,
 * Ollama, LM Studio, vLLM, etc.
 */

"use strict";

const vscode = require("vscode");
const path = require("path");
const os = require("os");
const fs = require("fs");

// ----------------------------------------------------------------------------
// Cline file-based storage reader (mirrors create-project/host.js pattern).
// CodeSage (built on Cline) stores config in ~/.cline/data/, NOT in VS Code's
// own globalState/secrets.
// ----------------------------------------------------------------------------

function getClineDataDir() {
  if (process.env.CLINE_DATA_DIR) return process.env.CLINE_DATA_DIR;
  const base = process.env.CLINE_DIR || path.join(os.homedir(), ".cline");
  return path.join(base, "data");
}

function readClineGlobalState() {
  try {
    const p = path.join(getClineDataDir(), "globalState.json");
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function readClineSecrets() {
  try {
    const p = path.join(getClineDataDir(), "secrets.json");
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

/**
 * Try to resolve credentials from Cline storage for an OpenAI-compatible
 * provider. Returns { apiKey, baseUrl, model } or null if not resolvable.
 *
 * Cline stores the provider name in globalState["apiProvider"] and the key
 * in secrets under various possible key names depending on provider.
 */
function resolveClineCredentials(configModel) {
  const gs = readClineGlobalState();
  const secrets = readClineSecrets();

  const provider = gs["apiProvider"];
  if (!provider) return null;

  // Only use Cline creds for OpenAI-compatible providers.
  // Anthropic (/v1/messages) and Gemini (generateContent) use different
  // request shapes — skip those and fall through to the VS Code settings.
  const compatibleProviders = {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      keyNames: ["openrouterApiKey", "apiKey"],
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      keyNames: ["openaiApiKey", "apiKey"],
    },
    openaiNative: {
      baseUrl: "https://api.openai.com/v1",
      keyNames: ["openaiApiKey", "apiKey"],
    },
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      keyNames: ["deepseekApiKey", "apiKey"],
    },
    mistral: {
      baseUrl: "https://api.mistral.ai/v1",
      keyNames: ["mistralApiKey", "apiKey"],
    },
    together: {
      baseUrl: "https://api.together.xyz/v1",
      keyNames: ["togetherApiKey", "apiKey"],
    },
    groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      keyNames: ["groqApiKey", "apiKey"],
    },
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      keyNames: ["ollamaApiKey", "apiKey"],
    },
    lmstudio: {
      baseUrl: "http://localhost:1234/v1",
      keyNames: ["lmstudioApiKey", "apiKey"],
    },
  };

  const info = compatibleProviders[provider];
  if (!info) return null;

  let apiKey = null;
  for (const kn of info.keyNames) {
    if (secrets[kn] && secrets[kn] !== undefined) {
      apiKey = secrets[kn];
      break;
    }
  }
  if (!apiKey) return null;

  // The model: use the dedicated setting if provided, otherwise try Cline's
  // stored model name for this provider.
  const model = configModel || gs[`${provider}ModelId`] || gs["apiModelId"] || null;
  if (!model) return null;

  return { apiKey, baseUrl: info.baseUrl, model };
}

/**
 * Resolve credentials from VS Code settings (the dedicated fallback).
 */
async function resolveSettingsCredentials(context, configModel) {
  const config = vscode.workspace.getConfiguration("codesage.inlineCompletions");

  // API key is stored in VS Code SecretStorage for security.
  let apiKey = null;
  try {
    apiKey = await context.secrets.get("codesage.inlineCompletions.apiKey");
  } catch (e) {
    // ignore
  }

  if (!apiKey) return null;

  const baseUrl =
    (config.get("baseUrl") || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const model = configModel;

  if (!model) return null;

  return { apiKey, baseUrl, model };
}

/**
 * Master credential resolver. Tries Cline storage first, then VS Code settings.
 */
async function resolveCredentials(context) {
  const config = vscode.workspace.getConfiguration("codesage.inlineCompletions");
  const configModel = config.get("model") || "";

  // 1. Try Cline storage (zero-setup if user already has CodeSage configured).
  const cline = resolveClineCredentials(configModel);
  if (cline) return cline;

  // 2. Fall back to VS Code settings.
  const settings = await resolveSettingsCredentials(context, configModel);
  if (settings) return settings;

  return null;
}

// ----------------------------------------------------------------------------
// LLM call — OpenAI-compatible /v1/chat/completions (non-streaming).
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an inline code completion engine. You are given the code before and after the cursor position. " +
  "Output ONLY the code that should be inserted at the cursor. " +
  "No explanation, no markdown fences, no leading/trailing commentary — raw code only. " +
  "Keep completions concise (1-5 lines typically). Match the surrounding style, indentation, and language.";

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
    const config = vscode.workspace.getConfiguration("codesage.inlineCompletions");
    const enabled = config.get("enabled");
    if (!enabled) return { items: [] };

    const model = config.get("model");
    if (!model) return { items: [] };

    const trigger = config.get("trigger") || "auto";
    // In "manual" mode, only trigger when explicitly invoked (VS Code handles
    // this via the editor.action.triggerSuggest command; for inline completions,
    // manual mode means we only fire when context.triggerKind is Invoke).
    if (trigger === "manual" && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
      return { items: [] };
    }

    // Don't fire in excluded languages.
    const excludedLangs = config.get("excludedLanguages") || ["plaintext", "markdown", "log"];
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

    const debounceMs = config.get("debounceMs") || 400;
    const maxPrefix = config.get("maxPrefixChars") || 3000;
    const maxSuffix = config.get("maxSuffixChars") || 1500;

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) {
          resolve({ items: [] });
          return;
        }

        // Resolve credentials.
        let creds;
        try {
          creds = await resolveCredentials(this.context);
        } catch (e) {
          creds = null;
        }
        if (!creds) {
          resolve({ items: [] });
          return;
        }

        // Grab prefix + suffix.
        const text = document.getText();
        const offset = document.offsetAt(position);
        const prefixStart = Math.max(0, offset - maxPrefix);
        const suffixEnd = Math.min(text.length, offset + maxSuffix);
        const prefix = text.slice(prefixStart, offset);
        const suffix = text.slice(offset, suffixEnd);

        // The line the cursor is on (for indentation alignment).
        const line = document.lineAt(position.line);
        const prefixLine = line.text.slice(0, position.character);

        // If the prefix is just whitespace and very short, skip (avoid trivial
        // completions at the start of an empty file).
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
            // Silently fail — log to output channel for debugging but never
            // surface a modal error mid-typing.
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

function register(context) {
  const config = vscode.workspace.getConfiguration("codesage.inlineCompletions");
  const enabled = config.get("enabled");

  // Register the inline completion provider for ALL languages.
  // VS Code will call provideInlineCompletionItems as the user types.
  const provider = new CodeSageInlineCompletionProvider(context);

  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    provider
  );
  context.subscriptions.push(disposable);

  // Toggle command — lets the user turn completions on/off quickly.
  const toggleCmd = vscode.commands.registerCommand(
    "codesage.toggleInlineCompletions",
    async () => {
      const cfg = vscode.workspace.getConfiguration("codesage.inlineCompletions");
      const current = cfg.get("enabled");
      await cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `CodeSage inline completions: ${!current ? "ON" : "OFF"}`
      );
    }
  );
  context.subscriptions.push(toggleCmd);

  // Command to set the API key (stores in SecretStorage).
  const setKeyCmd = vscode.commands.registerCommand(
    "codesage.setInlineCompletionsApiKey",
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter the API key for CodeSage inline completions",
        password: true,
        placeHolder: "sk-or-v1-... / sk-... / etc.",
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store("codesage.inlineCompletions.apiKey", key);
        vscode.window.showInformationMessage(
          "CodeSage inline completions API key saved."
        );
      }
    }
  );
  context.subscriptions.push(setKeyCmd);

  // Show status bar item if enabled.
  if (enabled) {
    provider.statusBarItem.show();
  }

  console.log("[CodeSage] Inline completions provider registered (enabled:", enabled + ")");
}

module.exports = { register };
