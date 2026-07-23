/**
 * CodeSage "Create Project" wrapper entry point.
 *
 * This file replaces the original dist/extension.js. It:
 *   1. Loads the original bundled extension (now at dist/extension.original.js)
 *      and proxies activate / deactivate / reportRolloutActivation through.
 *   2. After the original activate() finishes, registers an additional
 *      command — `codesage.createProjectButtonClicked` — which opens a
 *      dedicated wizard webview panel. The wizard walks the user through
 *      Project type -> Platform -> Framework -> App spec, then drives the
 *      GitHub REST + Git Data API to scaffold a repo, push framework files,
 *      generate app source via CodeSage's configured LLM, trigger a GitHub
 *      Actions build, poll it, and surface results (test pass/fail,
 *      screenshots, live Pages URL, artifact download).
 *
 * Design notes:
 *   - The original minified bundle is left untouched. We only wrap it.
 *   - All wizard UI lives in /create-project/wizard.html (loaded at runtime
 *     via fs.readFile from the extension's install directory).
 *   - All GitHub + LLM logic lives in /create-project/host.js (required at
 *     runtime as a CommonJS module).
 *   - GitHub token is stored in VS Code's SecretStorage under the key
 *     `codesage.githubToken`. First use prompts the user; thereafter it is
 *     reused automatically.
 *   - LLM credentials are reused from CodeSage's own storage (apiProvider
 *     in globalState + provider-specific key in secrets). The wizard never
 *     asks for or persists LLM keys of its own.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const vscode = require("vscode");

// ----------------------------------------------------------------------------
// Neutralize the fetch/http interceptor injected at the top of the original
// CodeSage bundle (extension.original.js). That interceptor wraps
// globalThis.fetch + http.request + https.request to log Authorization
// headers for LLM provider domains. It has a bug that corrupts HTTP request
// arguments, causing "other side closed: SocketError: other side closed
// (UND_ERR_SOCKET)" errors in CodeSage's chat.
//
// We save the pristine versions BEFORE loading the original bundle, then
// restore them AFTER. This undoes the interceptor's wrapping.
// ----------------------------------------------------------------------------
const __pristineFetch = globalThis.fetch;
const __http = require("http");
const __https = require("https");
const __pristineHttpRequest = __http.request;
const __pristineHttpsRequest = __https.request;

// Load the original bundle. It exports {activate, deactivate, reportRolloutActivation}.
// This triggers the fetch interceptor installation at the top of the file.
const original = require("./extension.original.js");

// Immediately restore the pristine fetch + http/https.request, undoing the
// interceptor's wrappers. This prevents the socket corruption bug.
globalThis.fetch = __pristineFetch;
__http.request = __pristineHttpRequest;
__https.request = __pristineHttpsRequest;

// Load the host-side helpers (GitHub + LLM + workflow templates).
const host = require("../create-project/host.js");

const WIZARD_CMD = "codesage.createProjectButtonClicked";
const WIZARD_VIEW_TITLE = "Project Space";
const TOKEN_SECRET_KEY = "codesage.githubToken";
// Mirrors host.js. Used for Appetize.io API key — first-use prompt, then
// reused automatically forever after. Stored in VS Code SecretStorage.
const APPETIZE_SECRET_KEY = "codesage.appetizeApiKey";

// Track open wizard panels so we don't open duplicates.
const openPanels = new Set();

/**
 * Activate. Proxies to the original activate, then registers our extra
 * command on top.
 */
async function activate(context) {
  // Run the original activate first — sets up the entire CodeSage UI,
  // sidebar, chat, MCP, history, account, settings, etc.
  let originalResult;
  try {
    originalResult = await original.activate(context);
  } catch (err) {
    console.error("[CreateProject] original activate threw:", err);
    // Don't fail the whole extension — CodeSage's own UI may still be usable.
  }

  try {
    registerCreateProjectCommand(context);
  } catch (err) {
    console.error("[CreateProject] failed to register command:", err);
  }

  return originalResult;
}

/**
 * Deactivate. Just proxy.
 */
async function deactivate() {
  if (typeof original.deactivate === "function") {
    return original.deactivate();
  }
}

// reportRolloutActivation is a VS Code rollout helper some extensions expose.
function reportRolloutActivation() {
  if (typeof original.reportRolloutActivation === "function") {
    return original.reportRolloutActivation.apply(this, arguments);
  }
}

/**
 * Register the Create Project command + open the wizard panel.
 * Also registers the Projects dropdown command.
 */
function registerCreateProjectCommand(context) {
  const cmd = vscode.commands.registerCommand(
    WIZARD_CMD,
    async () => openWizard(context)
  );
  context.subscriptions.push(cmd);

  // Projects dropdown — lists local VS Code workspaces + GitHub repos,
  // lets the user switch which project CodeSage works on.
  const projectsCmd = vscode.commands.registerCommand(
    "codesage.projectsButtonClicked",
    async () => showProjectsQuickPick(context)
  );
  context.subscriptions.push(projectsCmd);
}

/**
 * Active project key — stored in globalState. When set, this is the
 * owner/repo that CodeSage's AI works on via the GitHub API (through the
 * GitHub MCP server). No local files involved.
 *
 * When a GitHub repo is selected, a rules file is written to
 * ~/Documents/Cline/Rules/codesage-active-project.md that tells the AI:
 *   - Use GitHub MCP tools only (no local file operations)
 *   - Which repo to work on (owner/repo)
 *   - What kind of project it is (Flutter/Android, React/Web, etc.)
 *
 * When the active project is cleared, the rules file is deleted and the AI
 * goes back to normal local-file mode.
 */
const ACTIVE_PROJECT_KEY = "codesage.createProject.activeProject";
const ACTIVE_PROJECT_RULES_FILENAME = "codesage-active-project.md";

/**
 * Get the global Cline rules directory (~/Documents/Cline/Rules/).
 * This is where CodeSage looks for global .md rule files that get injected
 * into every chat's system prompt.
 */
async function getGlobalRulesDir() {
  const path = require("path");
  const os = require("os");
  const fs = require("fs");
  // CodeSage uses Documents/Cline/Rules — try that first, fall back to home
  const candidates = [
    path.join(os.homedir(), "Documents", "Cline", "Rules"),
    path.join(os.homedir(), "Documents", "cline", "Rules"),
    path.join(os.homedir(), ".cline", "rules"),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      // try next
    }
  }
  // Last resort — create in home
  const fallback = path.join(os.homedir(), ".cline", "rules");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Fetch codesage-project.txt from the repo via GitHub API. This file was
 * pushed by the wizard when the project was created and contains:
 *   project_type: Flutter (Android)
 *   framework: flutter
 *   platform: Android
 *   about:
 *   <user's description>
 *
 * Returns { projectType, framework, platform, about } or null if the file
 * doesn't exist (e.g. repo wasn't created by the wizard).
 */
async function fetchProjectInfo(token, owner, repo) {
  const https = require("https");
  try {
    const content = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "GET",
          hostname: "api.github.com",
          path: `/repos/${owner}/${repo}/contents/codesage-project.txt`,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.raw+json",
            "User-Agent": "CodeSage-CreateProject",
          },
        },
        (res) => {
          if (res.statusCode !== 200) { resolve(null); return; }
          let chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }
      );
      req.on("error", () => resolve(null));
      req.end();
    });
    if (!content) return null;

    // Parse the simple key:value format
    const info = { projectType: "Unknown", framework: "unknown", platform: "unknown", about: "" };
    const lines = content.split("\n");
    let inAbout = false;
    const aboutLines = [];
    for (const line of lines) {
      if (inAbout) {
        aboutLines.push(line);
        continue;
      }
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) {
        const key = m[1];
        const val = m[2];
        if (key === "project_type") info.projectType = val;
        else if (key === "framework") info.framework = val;
        else if (key === "platform") info.platform = val;
      }
      if (line.trim() === "about:") { inAbout = true; }
    }
    info.about = aboutLines.join("\n").trim();
    return info;
  } catch (e) {
    return null;
  }
}

/**
 * Derive the project type from the wizard's create request. Used when the
 * wizard finishes — we know the framework, so we build the info directly
 * rather than fetching from GitHub.
 */
function detectProjectTypeFromRequest(request) {
  const framework = request.framework;
  const map = {
    react: { type: "react", framework: "React", language: "TypeScript/JavaScript", details: "Website (React + Vite)" },
    flutter: { type: "flutter", framework: "Flutter", language: "Dart", details: "Android app (Flutter)" },
    kotlin: { type: "kotlin", framework: "Kotlin + Java", language: "Kotlin/Java", details: "Android app (native Kotlin)" },
    electron: { type: "electron", framework: "Electron", language: "JavaScript", details: "Desktop app (Electron)" },
    tauri: { type: "tauri", framework: "Tauri", language: "Rust + TypeScript", details: "Desktop app (Tauri)" },
  };
  return map[framework] || { type: "unknown", framework: "Unknown", language: "Unknown", details: "Project type unknown" };
}

/**
 * Write the active-project rules file. This file lives in the global Cline
 * rules directory and gets injected into every chat's system prompt.
 */
async function writeActiveProjectRules(project, projectInfo) {
  const path = require("path");
  const fs = require("fs");
  const rulesDir = await getGlobalRulesDir();
  const rulesFile = path.join(rulesDir, ACTIVE_PROJECT_RULES_FILENAME);

  // projectInfo comes from codesage-project.txt (fetched via GitHub API)
  // or from detectProjectTypeFromRequest (when the wizard just finished).
  // It has: { projectType, framework, platform, about } OR
  //         { type, framework, language, details } (legacy format)
  const fw = projectInfo.framework || projectInfo.type || "unknown";
  const about = projectInfo.about || projectInfo.details || "";
  const projectTypeLabel = projectInfo.projectType || projectInfo.details || fw;

  const instructions = `# Active Project: GitHub MCP Mode

## CRITICAL: Use GitHub MCP tools ONLY — LOCAL FILE TOOLS ARE FORBIDDEN

You are working on a **GitHub repository** — NOT a local workspace. You MUST use the GitHub MCP server tools for ALL file operations.

### FORBIDDEN tools (will create files on the LOCAL machine — DO NOT USE):
- \`read_file\` — use the GitHub MCP read tool instead
- \`write_to_file\` — this creates files on the LOCAL machine, NOT on GitHub
- \`replace_in_file\` — this edits LOCAL files, NOT GitHub files
- \`list_files\` — this lists LOCAL files, NOT GitHub files
- \`search_files\` — this searches LOCAL files
- \`execute_command\` — this runs commands on the LOCAL machine. Builds happen on GitHub via Actions, NOT locally.

**If you use ANY of these tools, you are doing it WRONG.** Files created locally will NOT be on GitHub and will NOT trigger builds.

### REQUIRED tools (GitHub MCP — look for tools starting with mcp__github):
The GitHub MCP server provides tools for reading, creating, and updating files directly on GitHub. The tool names depend on how the server is configured — look for ANY available tool that starts with \`mcp__github\`. Common names:

- \`mcp__github__get_file_contents\` or \`mcp__github-local__get_file_contents\` — read a file from the repo
- \`mcp__github__create_or_update_file\` or \`mcp__github-local__create_or_update_file\` — create or edit a file (commits to GitHub immediately)
- \`mcp__github__push_files\` or \`mcp__github-local__push_files\` — push multiple files in one commit
- \`mcp__github__search_code\` or \`mcp__github-local__search_code\` — search code in the repo
- \`mcp__github__create_branch\` or \`mcp__github-local__create_branch\` — create a new branch
- \`mcp__github__create_pull_request\` or \`mcp__github-local__create_pull_request\` — open a PR

**Before doing anything else, list your available MCP tools** to find the exact names. Use whichever \`mcp__github\` tools are available.

If NO \`mcp__github\` tools are available, STOP and tell the user: "GitHub MCP server is not connected. Please configure it in Project Space → Settings → GitHub MCP server."

## Active Repository

- **Owner/Repo:** ${project.owner}/${project.repo}
- **URL:** ${project.url}
- **Default branch:** main

When the user says "the repo" or "the project", they mean ${project.owner}/${project.repo}. Pass \`owner: "${project.owner}"\` and \`repo: "${project.repo}"\` to every GitHub MCP tool call.

## Project Type

${projectTypeLabel}

${about ? `## About This App

${about}
` : ""}
## Workflow

1. **Read before edit:** Always use the GitHub MCP get_file_contents tool before making changes.
2. **Push changes:** Use the GitHub MCP create_or_update_file or push_files tool. This commits directly to GitHub.
3. **Build triggers automatically:** Pushing to \`main\` triggers GitHub Actions. Do NOT run builds locally. Do NOT use execute_command.
4. **Check build status ONCE:** After pushing, wait 60 seconds, then check via GitHub API ONCE. Do NOT poll repeatedly.
5. **Commit messages:** Use clear messages like "feat: add counter" or "fix: resolve null pointer".

## CRITICAL: Do NOT poll build status repeatedly

After pushing code, the build runs automatically on GitHub. DO NOT:
- Fetch the Actions web page URL repeatedly to check progress
- Poll the build status more than once
- Read HTML from github.com/.../actions/runs/...

Instead: push → wait 60s → check via GitHub API ONCE → tell the user the result → move on.

## When the user asks to "download the app"

Point them to: https://github.com/${project.owner}/${project.repo}/actions → latest successful run → Artifacts section.
`;

  fs.writeFileSync(rulesFile, instructions, "utf8");
}

/**
 * Delete the active-project rules file (when the user clears the active
 * project or switches to a local workspace).
 */
async function clearActiveProjectRules() {
  const path = require("path");
  const fs = require("fs");
  const rulesDir = await getGlobalRulesDir();
  const rulesFile = path.join(rulesDir, ACTIVE_PROJECT_RULES_FILENAME);
  try {
    fs.unlinkSync(rulesFile);
  } catch (e) {
    // already gone — fine
  }
}

/**
 * Show a QuickPick listing GitHub repos. Selecting one:
 *   1. Detects the project type (Flutter/React/Electron/etc.)
 *   2. Writes a global rules file that tells the AI to use GitHub MCP only
 *   3. Stores the active project in globalState
 *
 * Selecting "Clear active project" deletes the rules file so the AI goes
 * back to normal local-file mode.
 */
async function showProjectsQuickPick(context) {
  const token = await context.secrets.get(TOKEN_SECRET_KEY);
  const current = context.globalState.get(ACTIVE_PROJECT_KEY);

  if (!token) {
    const action = await vscode.window.showErrorMessage(
      "No GitHub token configured. Open the Create Project wizard (⚙) to add one, then your GitHub repos will appear here.",
      "Open wizard"
    );
    if (action === "Open wizard") {
      vscode.commands.executeCommand(WIZARD_CMD);
    }
    return;
  }

  // Fetch the user's repos
  let repos = [];
  try {
    const https = require("https");
    repos = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "GET",
          hostname: "api.github.com",
          path: "/user/repos?sort=updated&per_page=50&type=all",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "CodeSage-CreateProject",
          },
        },
        (res) => {
          let chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (e) { reject(e); }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to fetch GitHub repos: ${e.message}`);
    return;
  }

  if (!Array.isArray(repos) || repos.length === 0) {
    vscode.window.showInformationMessage(
      "No GitHub repos found. Use the Create Project wizard to create one."
    );
    return;
  }

  // Build QuickPick items
  const items = repos.map((r) => ({
    label: `$(repo) ${r.full_name}${current && current.owner === r.owner.login && current.repo === r.name ? " ✓ active" : ""}`,
    description: r.language || "",
    detail: r.html_url,
    owner: r.owner.login,
    repo: r.name,
    url: r.html_url,
  }));

  // Add a "clear active project" option at the top if one is set
  if (current) {
    items.unshift({
      label: "$(circle-slash) Clear active project (back to local workspace mode)",
      description: "",
      detail: "AI will use normal local file tools — no GitHub MCP",
      action: "clear",
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: current
      ? `Active: ${current.owner}/${current.repo} (GitHub MCP mode) — select another repo or clear…`
      : "Select a GitHub repo — AI will use GitHub MCP tools only, no local files…",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return;

  if (picked.action === "clear") {
    await context.globalState.update(ACTIVE_PROJECT_KEY, undefined);
    await clearActiveProjectRules();
    vscode.window.showInformationMessage(
      "Active project cleared. AI will use normal local file tools. Start a new chat for the change to take effect."
    );
    return;
  }

  // Fetch project info from codesage-project.txt (pushed by the wizard)
  vscode.window.showInformationMessage(`Reading project info for ${picked.owner}/${picked.repo}…`);
  let projectInfo = await fetchProjectInfo(token, picked.owner, picked.repo);
  if (!projectInfo) {
    // File doesn't exist — repo wasn't created by the wizard. Use basic info.
    projectInfo = {
      projectType: picked.description || "Unknown project type",
      framework: "unknown",
      platform: "unknown",
      about: "(This repo was not created by the CodeSage wizard — no codesage-project.txt found.)",
    };
  }

  // Set the active project
  const project = {
    owner: picked.owner,
    repo: picked.repo,
    url: picked.url,
  };
  await context.globalState.update(ACTIVE_PROJECT_KEY, project);

  // Write the rules file
  await writeActiveProjectRules(project, projectInfo);

  vscode.window.showInformationMessage(
    `Active project: ${picked.owner}/${picked.repo} (${projectInfo.projectType}). AI will use GitHub MCP tools only. Start a new chat for the instructions to take effect.`
  );
}

/**
 * Open (or focus) the wizard webview panel.
 */
async function openWizard(context) {
  // Reuse an existing panel if one is visible.
  for (const panel of openPanels) {
    if (panel.visible) {
      panel.reveal(vscode.ViewColumn.Active);
      return;
    }
  }

  const panel = vscode.window.createWebviewPanel(
    "codesage.createProject",
    WIZARD_VIEW_TITLE,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(
          path.join(context.extensionPath, "create-project")
        ),
      ],
    }
  );

  panel.iconPath = {
    light: vscode.Uri.file(
      path.join(context.extensionPath, "assets", "icons", "icon.svg")
    ),
    dark: vscode.Uri.file(
      path.join(context.extensionPath, "assets", "icons", "icon.svg")
    ),
  };

  // Load the wizard HTML and patch in the CSP nonce + resource URIs.
  const htmlPath = path.join(
    context.extensionPath,
    "create-project",
    "wizard.html"
  );
  let html = fs.readFileSync(htmlPath, "utf8");

  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${panel.webview.cspSource} https: data:`,
    `style-src 'unsafe-inline' ${panel.webview.cspSource}`,
    `script-src 'unsafe-inline' ${panel.webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${panel.webview.cspSource}`,
    // Allow Appetize.io embeds (used by Flutter live-preview iframe).
    // GitHub.com is allowed so artifact download links work if embedded.
    `frame-src https://appetize.io https://*.appetize.io`,
  ].join("; ");

  html = html
    .replace(/__CSP__/g, csp)
    .replace(/__NONCE__/g, nonce);

  panel.webview.html = html;

  panel.onDidDispose(() => openPanels.delete(panel));
  openPanels.add(panel);

  // Wire up messaging between the wizard and the host.
  const messenger = new WizardMessenger(panel, context);
  panel.webview.onDidReceiveMessage(
    (msg) => messenger.handle(msg),
    null,
    context.subscriptions
  );
}

/**
 * Tiny message router for the wizard <-> host channel.
 */
class WizardMessenger {
  constructor(panel, context) {
    this.panel = panel;
    this.context = context;
  }

  send(msg) {
    this.panel.webview.postMessage(msg);
  }

  async handle(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "getState":
        return this.handleGetState();
      case "setToken":
        return this.handleSetToken(msg);
      case "clearToken":
        return this.handleClearToken();
      case "setAppetizeKey":
        return this.handleSetAppetizeKey(msg);
      case "clearAppetizeKey":
        return this.handleClearAppetizeKey();
      case "openSecretsPage":
        return this.handleOpenSecretsPage();
      case "enableAppetize":
        return this.handleEnableAppetize(msg);
      case "create":
        return this.handleCreate(msg);
      case "resumeCreate":
        return this.handleResumeCreate(msg);
      case "checkResumable":
        return this.handleCheckResumable();
      case "forgetRun":
        return this.handleForgetRun();
      case "getGithubMcpStatus":
        return this.handleGetGithubMcpStatus();
      case "configureGithubMcp":
        return this.handleConfigureGithubMcp();
      case "removeGithubMcp":
        return this.handleRemoveGithubMcp();
      case "listProjects":
        return this.handleListProjects();
      case "selectProject":
        return this.handleSelectProject(msg);
      case "getTestBuilds":
        return this.handleGetTestBuilds();
      case "launchTest":
        return this.handleLaunchTest(msg);
      case "openExternal":
        if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "copy":
        if (msg.text) vscode.env.clipboard.writeText(msg.text);
        return;
    }
  }

  async handleGetState() {
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    const appetizeKey = await this.context.secrets.get(APPETIZE_SECRET_KEY);
    this.send({
      type: "state",
      hasToken: !!token,
      hasAppetizeKey: !!appetizeKey,
    });
  }

  async handleSetToken(msg) {
    if (!msg.token) {
      this.send({ type: "tokenSet", ok: false, error: "No token provided" });
      return;
    }
    await this.context.secrets.store(TOKEN_SECRET_KEY, msg.token);
    this.send({ type: "tokenSet", ok: true });
  }

  async handleClearToken() {
    await this.context.secrets.delete(TOKEN_SECRET_KEY);
    this.send({ type: "tokenCleared" });
  }

  async handleSetAppetizeKey(msg) {
    if (!msg.key) {
      this.send({ type: "appetizeKeySet", ok: false, error: "No key provided" });
      return;
    }
    await this.context.secrets.store(APPETIZE_SECRET_KEY, msg.key);
    this.send({ type: "appetizeKeySet", ok: true });
  }

  /**
   * Delete the stored Appetize API key from SecretStorage. Used by the
   * settings modal's "Clear stored key" button for the Appetize section.
   */
  async handleClearAppetizeKey() {
    try {
      await this.context.secrets.delete(APPETIZE_SECRET_KEY);
      this.send({ type: "appetizeKeyCleared", ok: true });
    } catch (err) {
      this.send({
        type: "appetizeKeyCleared",
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Open the GitHub Actions secrets page in the user's browser.
   * If there's an active project, opens that repo's secrets page.
   * Otherwise opens the user's global secrets page.
   */
  async handleOpenSecretsPage() {
    const project = this.context.globalState.get(ACTIVE_PROJECT_KEY);
    let url;
    if (project && project.owner && project.repo) {
      url = `https://github.com/${project.owner}/${project.repo}/settings/secrets/actions`;
    } else {
      url = "https://github.com/settings/secrets/actions";
    }
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Push the stored Appetize API key as a GitHub repo secret to all the
   * user's repos. Uses a child Node.js process that npm-installs
   * libsodium-wrappers and does the encryption — no CDN downloads,
   * no manual nonce derivation, no WASM loading issues.
   */
  async handlePushAppetizeSecret() {
    const appetizeKey = await this.context.secrets.get(APPETIZE_SECRET_KEY);
    if (!appetizeKey) {
      this.send({ type: "appetizeSecretPushed", ok: false, error: "No Appetize key stored. Add one first." });
      return;
    }

    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
      this.send({ type: "appetizeSecretPushed", ok: false, error: "No GitHub token. Add one first." });
      return;
    }

    try {
      // Fetch the user's repos
      const repos = await this._githubGet(token, "/user/repos?per_page=100&type=all&sort=updated");
      if (!Array.isArray(repos) || repos.length === 0) {
        this.send({ type: "appetizeSecretPushed", ok: false, error: "No repos found." });
        return;
      }

      // For each repo: get public key, encrypt via child process, PUT secret
      let successCount = 0;
      let failCount = 0;
      const failed = [];
      const batchSize = 3;

      for (let i = 0; i < repos.length; i += batchSize) {
        const batch = repos.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (repo) => {
          try {
            // 1. Get the repo's public key
            const pubKeyData = await this._githubGet(token, `/repos/${repo.full_name}/actions/secrets/public-key`);
            if (!pubKeyData || !pubKeyData.key) throw new Error("No public key");

            // 2. Encrypt via child process (installs libsodium-wrappers once, cached after)
            const encryptedB64 = await this._encryptSecret(pubKeyData.key, appetizeKey);

            // 3. PUT the secret
            await this._githubPut(token, `/repos/${repo.full_name}/actions/secrets/APPETIZE_API_KEY`, {
              encrypted_value: encryptedB64,
              key_id: pubKeyData.key_id,
            });
            return { ok: true, repo: repo.full_name };
          } catch (err) {
            return { ok: false, repo: repo.full_name, error: err.message };
          }
        }));

        for (const r of results) {
          if (r.ok) successCount++;
          else { failCount++; failed.push(r.repo + ": " + r.error); }
        }
      }

      const msg = {
        type: "appetizeSecretPushed",
        ok: successCount > 0,
        count: successCount,
        total: repos.length,
        failed: failCount,
        failedRepos: failed.slice(0, 5),
      };
      if (successCount === 0 && failed.length > 0) {
        msg.error = "Pushed to 0 of " + repos.length + " repos. Errors: " + failed.slice(0, 3).join("; ");
      }
      this.send(msg);
    } catch (err) {
      this.send({
        type: "appetizeSecretPushed",
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Encrypt a secret value using GitHub's public key via libsodium's
   * crypto_box_seal. Uses a child Node.js process that installs
   * libsodium-wrappers in a temp dir (cached after first run).
   *
   * This avoids all the issues with CDN loading, WASM, `self` references,
   * and manual nonce derivation — libsodium-wrappers handles everything.
   */
  async _encryptSecret(publicKeyB64, secretValue) {
    const { exec } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const os = require("os");

    const tmpDir = path.join(os.tmpdir(), "codesage-sodium");
    const nodeModulesDir = path.join(tmpDir, "node_modules", "libsodium-wrappers");

    // Install libsodium-wrappers if not already cached
    if (!fs.existsSync(nodeModulesDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
      await new Promise((resolve, reject) => {
        exec("npm install libsodium-wrappers", { cwd: tmpDir }, (err) => {
          if (err) reject(new Error("npm install libsodium-wrappers failed: " + err.message));
          else resolve();
        });
      });
    }

    // Run encryption in a child process
    const script = `
      const sodium = require("${nodeModulesDir.replace(/\\/g, "\\\\")}");
      sodium.ready.then(() => {
        const pk = sodium.from_base64(${JSON.stringify(publicKeyB64)}, sodium.base64_variants.ORIGINAL);
        const msg = sodium.from_string(${JSON.stringify(secretValue)});
        const enc = sodium.crypto_box_seal(msg, pk);
        process.stdout.write(sodium.to_base64(enc, sodium.base64_variants.ORIGINAL));
      }).catch(e => { process.stderr.write(e.message); process.exit(1); });
    `;

    const result = await new Promise((resolve, reject) => {
      exec(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err, stdout, stderr) => {
        if (err) reject(new Error("Encryption failed: " + (stderr || err.message)));
        else resolve(stdout.trim());
      });
    });

    return result;
  }

  /**
   * Helper: GitHub PUT request.
   */
  async _githubPut(token, apiPath, body) {
    const https = require("https");
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const req = https.request(
        {
          method: "PUT",
          hostname: "api.github.com",
          path: apiPath,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
            "User-Agent": "CodeSage-CreateProject",
          },
        },
        (res) => {
          let chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode >= 200 && res.statusCode < 300) resolve();
            else {
              let detail = text;
              try { detail = JSON.parse(text).message || text; } catch(e) {}
              reject(new Error(`HTTP ${res.statusCode} on PUT ${apiPath}: ${detail}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Triggered by the wizard after `done` has arrived, when the user has
   * entered (or replaced) their Appetize API key and wants to enable live
   * preview for the just-built APK. Delegates to host.enableAppetizePreview
   * which downloads the artifact, extracts the APK, uploads to Appetize, and
   * streams `appetizeReady` or `appetizeFailed` back to the wizard.
   */
  async handleEnableAppetize(msg) {
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    try {
      await host.enableAppetizePreview({
        secrets: this.context.secrets,
        token,
        archiveDownloadUrl: msg.archiveDownloadUrl,
        apiKey: msg.key,
        send: (m) => this.send(m),
      });
    } catch (err) {
      this.send({
        type: "appetizeFailed",
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  async handleCreate(msg) {
    const self = this;
    const ctx = {
      context: this.context,
      request: msg,
      send: (m) => {
        // Intercept the 'done' message to auto-set the just-created repo as
        // the active project + write the GitHub MCP rules file.
        if (m.type === "done" && m.owner && m.repo) {
          const project = { owner: m.owner, repo: m.repo, url: m.repoUrl };
          self.context.globalState.update(ACTIVE_PROJECT_KEY, project);
          // Build project info from the request — we know the framework +
          // description since the user just entered them in the wizard.
          const frameworkMap = {
            react: "React (Website)",
            flutter: "Flutter (Android)",
            kotlin: "Kotlin + Java (Android)",
            electron: "Electron (Desktop)",
            tauri: "Tauri (Desktop)",
          };
          const projectInfo = {
            projectType: frameworkMap[msg.framework] || msg.framework || "Unknown",
            framework: msg.framework || "unknown",
            platform: msg.platform || "unknown",
            about: msg.description || "",
          };
          writeActiveProjectRules(project, projectInfo).catch(() => {});
        }
        self.send(m);
      },
      secrets: this.context.secrets,
      tokenKey: TOKEN_SECRET_KEY,
    };
    try {
      await host.runCreatePipeline(ctx);
    } catch (err) {
      this.send({
        type: "fatal",
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Resume a previously-interrupted pipeline run. The saved state (repo
   * name, owner, commit SHAs, run ID, stage) is loaded from globalState and
   * passed to runCreatePipeline as `resumeState`. Completed stages are
   * skipped; the failed stage is retried.
   */
  async handleResumeCreate(msg) {
    const resumeState = await host.getResumableRun(this.context);
    if (!resumeState) {
      this.send({
        type: "fatal",
        message: "No saved pipeline state to resume. Start a new project instead.",
      });
      return;
    }
    // Use the saved request (repoName, spec, framework, etc.) — the user
    // can't edit it mid-resume. If msg has overrides, they're ignored.
    const ctx = {
      context: this.context,
      request: resumeState.request,
      resumeState,
      send: (m) => this.send(m),
      secrets: this.context.secrets,
      tokenKey: TOKEN_SECRET_KEY,
    };
    try {
      await host.runCreatePipeline(ctx);
    } catch (err) {
      this.send({
        type: "fatal",
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Check if there's a saved pipeline state that can be resumed. Called by
   * the wizard on load. Replies with `resumable: true/false` + the state
   * details so the wizard can show a "Resume from {stage}" banner.
   */
  async handleCheckResumable() {
    const state = await host.getResumableRun(this.context);
    if (state) {
      this.send({
        type: "resumable",
        resumable: true,
        stage: state.stage,
        repoName: state.repoName,
        repoUrl: state.repoUrl,
        owner: state.owner,
        request: state.request,
      });
    } else {
      this.send({ type: "resumable", resumable: false });
    }
  }

  /**
   * Clear the saved pipeline state. Called when the user clicks "Start over"
   * — ensures Resume isn't offered again for this run.
   */
  async handleForgetRun() {
    await host.forgetRun(this.context);
    this.send({ type: "runForgotten" });
  }

  /**
   * Get the MCP settings file path. CodeSage resolves this via the gZp
   * function (offset 23187084 in the bundle):
   *   1. CLINE_MCP_SETTINGS_PATH env var (if set)
   *   2. CLINE_DATA_DIR/settings/cline_mcp_settings.json (if env set)
   *   3. CLINE_DIR/data/settings/cline_mcp_settings.json (if env set)
   *   4. ~/.cline/data/settings/cline_mcp_settings.json (DEFAULT)
   *
   * NOT in VS Code's globalStorageUri — that was my earlier mistake.
   */
  getMcpSettingsPath() {
    const path = require("path");
    const os = require("os");
    const fs = require("fs");
    const filename = "cline_mcp_settings.json";

    // Check env vars in order (matching gZp in the bundle)
    if (process.env.CLINE_MCP_SETTINGS_PATH) {
      return path.join(process.env.CLINE_MCP_SETTINGS_PATH.trim(), filename);
    }
    if (process.env.CLINE_DATA_DIR) {
      return path.join(process.env.CLINE_DATA_DIR.trim(), "settings", filename);
    }
    const base = process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
    return path.join(base, "data", "settings", filename);
  }

  /**
   * Read + parse the MCP settings file. Returns {mcpServers: {}} if the
   * file doesn't exist or is invalid.
   */
  readMcpSettings() {
    const fs = require("fs");
    const path = require("path");
    try {
      const filePath = this.getMcpSettingsPath();
      // Create the directory if it doesn't exist (so writeMcpSettings works)
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.mcpServers) {
        return parsed;
      }
      return { mcpServers: {} };
    } catch (e) {
      return { mcpServers: {} };
    }
  }

  /**
   * Write the MCP settings file. Merges with existing config so we don't
   * clobber other MCP servers the user may have installed.
   */
  writeMcpSettings(config) {
    const fs = require("fs");
    const path = require("path");
    const filePath = this.getMcpSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  }

  /**
   * Check if the GitHub MCP server is configured (and whether it's using
   * PAT auth vs OAuth). Sends status back to the wizard.
   */
  async handleGetGithubMcpStatus() {
    try {
      const fs = require("fs");
      const filePath = this.getMcpSettingsPath();
      const config = this.readMcpSettings();
      const local = config.mcpServers["github-local"];
      const remote = config.mcpServers["github"];
      
      // Build a detailed status with the actual file path for debugging
      let details = `[File: ${filePath} | exists: ${fs.existsSync(filePath)} | servers: ${Object.keys(config.mcpServers).join(", ") || "none"}] `;
      
      if (local && local.env && local.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
        details += `Configured as 'github-local' with PAT auth.`;
        if (remote) {
          details += ` WARNING: remote 'github' entry also exists — delete it in CodeSage's MCP panel.`;
        }
        this.send({ type: "githubMcpStatus", configured: true, details });
      } else if (remote) {
        details += remote.oauth
          ? `Only remote 'github' (OAuth — broken). Click 'Auto-configure' to add 'github-local'.`
          : `Only 'github' exists. Click 'Auto-configure' to add 'github-local'.`;
        this.send({ type: "githubMcpStatus", configured: false, details });
      } else {
        details += `No GitHub MCP configured. Click 'Auto-configure'.`;
        this.send({ type: "githubMcpStatus", configured: false, details });
      }
    } catch (e) {
      this.send({
        type: "githubMcpStatus",
        configured: false,
        details: "Error: " + (e.message || String(e)),
      });
    }
  }

  /**
   * Auto-configure the GitHub MCP server with the stored GitHub token.
   * This fixes the "incompatible auth server: does not support dynamic
   * client registration" error by using PAT auth instead of OAuth.
   *
   * IMPORTANT: We use the server name "github-local" (NOT "github") to
   * avoid colliding with the marketplace-installed remote GitHub MCP entry.
   * CodeSage's remote-config sync (bPs function) re-adds the "github" entry
   * from the marketplace on every startup, overwriting any local config
   * under that name. By using "github-local", our PAT-based config survives
   * the sync. The user should also click "Delete Server" on the broken
   * "github" entry in CodeSage's MCP panel to stop the OAuth error.
   *
   * No-Docker path. Plain `npx -y @modelcontextprotocol/server-github` is
   * unreliable: that package is archived and its dependency zod-to-json-schema
   * has since shipped versions missing files it imports (dist/esm/parsers/*.js),
   * which crashes the stdio process with ERR_MODULE_NOT_FOUND -> ClIne/CodeSage
   * sees "MCP error -32000: Connection closed". npx re-resolves deps fresh
   * (or from whatever's cached) on every launch, so it can drift onto a
   * broken zod-to-json-schema at any time.
   *
   * Fix: do a one-time local `npm install` into
   * ~/.codesage/mcp-servers/github-server with an npm "overrides" pin on
   * zod-to-json-schema@3.23.0 (last version that shipped the parser files
   * the SDK expects). Verified working. Then point the MCP entry directly
   * at "node" + the installed dist/index.js, so nothing re-resolves at
   * launch time.
   *
   * Writes/updates the "github-local" entry in cline_mcp_settings.json:
   *   {
   *     "command": "node",
   *     "args": ["<installDir>/node_modules/@modelcontextprotocol/server-github/dist/index.js"],
   *     "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<token>" }
   *   }
   */
  async handleConfigureGithubMcp() {
    const path = require("path");
    const os = require("os");
    const fs = require("fs");
    const { execFile } = require("child_process");

    try {
      const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
      if (!token) {
        this.send({
          type: "githubMcpConfigured",
          ok: false,
          error: "No GitHub token stored. Add one in the GitHub token section above first.",
        });
        return;
      }

      // Note: wizard.html already shows "Configuring…" on click, so we don't
      // send an interim status here — it only understands ok:true as final.
      const installDir = path.join(os.homedir(), ".codesage", "mcp-servers", "github-server");
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify(
          {
            name: "codesage-github-mcp-server",
            private: true,
            description: "Pinned local install of @modelcontextprotocol/server-github to work around its broken zod-to-json-schema dependency (ERR_MODULE_NOT_FOUND). Managed by CodeSage — safe to delete and reconfigure.",
            dependencies: {
              "@modelcontextprotocol/server-github": "latest",
            },
            // Recent zod-to-json-schema releases dropped dist/esm/parsers/*.js
            // that server-github still imports. Pin to the last version that
            // has them.
            overrides: {
              "zod-to-json-schema": "3.23.0",
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await new Promise((resolve, reject) => {
        // On Windows, npm ships as npm.cmd (a batch file). Node's execFile
        // can't spawn a .cmd directly without shell:true — without it you
        // get "spawn EINVAL" instead of actually running npm, especially
        // inside the VS Code extension host process. shell:true is safe
        // here since args have no untrusted/user-controlled content.
        execFile(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["install", "--no-audit", "--no-fund"],
          { cwd: installDir, timeout: 120000, shell: process.platform === "win32" },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`npm install failed: ${error.message}\n${stderr || ""}`));
            } else {
              resolve();
            }
          }
        );
      });

      const entryPoint = path.join(
        installDir,
        "node_modules",
        "@modelcontextprotocol",
        "server-github",
        "dist",
        "index.js"
      );
      if (!fs.existsSync(entryPoint)) {
        throw new Error(`Install succeeded but entry point is missing: ${entryPoint}`);
      }

      const config = this.readMcpSettings();
      config.mcpServers["github-local"] = {
        command: "node",
        args: [entryPoint],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: token,
        },
        disabled: false,
        alwaysAllow: [],
        type: "stdio",
        timeout: 300,
      };
      this.writeMcpSettings(config);

      this.send({
        type: "githubMcpConfigured",
        ok: true,
        details: "Written as 'github-local' — pinned local install, no Docker and no npx drift. IMPORTANT: also click 'Delete Server' on the broken 'github' entry in CodeSage's MCP panel, then reload the window.",
      });
    } catch (err) {
      this.send({
        type: "githubMcpConfigured",
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Remove the github-local MCP server entry from the settings file.
   */
  async handleRemoveGithubMcp() {
    try {
      const config = this.readMcpSettings();
      if (config.mcpServers["github-local"]) {
        delete config.mcpServers["github-local"];
        this.writeMcpSettings(config);
      }
      this.send({ type: "githubMcpRemoved", ok: true });
    } catch (err) {
      this.send({
        type: "githubMcpRemoved",
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Fetch the user's GitHub repos and send them to the Projects tab.
   * Also sends the current active project (if set).
   */
  async handleListProjects() {
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
      this.send({
        type: "projectsList",
        error: "No GitHub token. Add one in the settings (⚙).",
      });
      return;
    }
    try {
      const https = require("https");
      const repos = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            method: "GET",
            hostname: "api.github.com",
            path: "/user/repos?sort=updated&per_page=50&type=all",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "CodeSage-CreateProject",
            },
          },
          (res) => {
            let chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch (e) { reject(e); }
            });
          }
        );
        req.on("error", reject);
        req.end();
      });
      if (!Array.isArray(repos)) {
        this.send({ type: "projectsList", error: "Invalid response from GitHub." });
        return;
      }
      const active = this.context.globalState.get(ACTIVE_PROJECT_KEY);
      this.send({
        type: "projectsList",
        repos: repos.map((r) => ({
          owner: r.owner.login,
          name: r.name,
          url: r.html_url,
          language: r.language || "",
        })),
        active: active || null,
      });
    } catch (err) {
      this.send({
        type: "projectsList",
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Select a project as active (same logic as the Projects dropdown but
   * triggered from the Projects tab inside the wizard).
   */
  async handleSelectProject(msg) {
    try {
      const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
      const project = { owner: msg.owner, repo: msg.repo, url: msg.url };
      await this.context.globalState.update(ACTIVE_PROJECT_KEY, project);

      // Fetch project info + write rules file (same as dropdown)
      let projectInfo = null;
      if (token) {
        projectInfo = await fetchProjectInfo(token, msg.owner, msg.repo);
      }
      if (!projectInfo) {
        projectInfo = {
          projectType: "Unknown",
          framework: "unknown",
          platform: "unknown",
          about: "(No codesage-project.txt found — repo was not created by the wizard.)",
        };
      }
      await writeActiveProjectRules(project, projectInfo);

      // Re-fetch the repo list so the UI updates with the new active status
      await this.handleListProjects();
      this.send({ type: "projectSelected", ok: true, project });
    } catch (err) {
      this.send({
        type: "projectSelected",
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Fetch recent GitHub Actions runs + their artifacts for the active
   * project. Sends the list to the Test tab so the user can see builds
   * + launch them on Appetize / Pages.
   */
  async handleGetTestBuilds() {
    const project = this.context.globalState.get(ACTIVE_PROJECT_KEY);
    if (!project) {
      this.send({ type: "testBuilds", error: "No active project." });
      return;
    }
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
      this.send({ type: "testBuilds", error: "No GitHub token." });
      return;
    }

    try {
      // Fetch recent workflow runs
      const https = require("https");
      const runsData = await this._githubGet(token, `/repos/${project.owner}/${project.repo}/actions/runs?per_page=10`);
      const runs = (runsData.workflow_runs || []).slice(0, 10);

      // Fetch artifacts for each completed run (in parallel, limited)
      const builds = [];
      const batchSize = 3;
      for (let i = 0; i < runs.length; i += batchSize) {
        const batch = runs.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (run) => {
          let artifactName = null, artifactUrl = null, artifactSize = 0;
          if (run.status === "completed") {
            try {
              const artsData = await this._githubGet(token, `/repos/${project.owner}/${project.repo}/actions/runs/${run.id}/artifacts`);
              const apk = (artsData.artifacts || []).find((a) => a.name === "apk" || a.name === "dist" || a.name.includes("apk"));
              if (apk) {
                artifactName = apk.name;
                artifactUrl = apk.archive_download_url;
                artifactSize = apk.size_in_bytes;
              }
            } catch (e) { /* ignore */ }
          }
          return {
            runId: run.id,
            runNumber: run.run_number,
            status: run.conclusion || run.status,
            createdAt: run.created_at,
            runUrl: run.html_url,
            artifactName,
            artifactUrl,
            artifactSize,
            version: null, // could parse from commit message later
          };
        }));
        builds.push(...results);
      }

      // Fetch project type from codesage-project.txt
      let projectType = "Unknown";
      try {
        const info = await fetchProjectInfo(token, project.owner, project.repo);
        if (info) projectType = info.projectType || info.framework || "Unknown";
      } catch (e) { /* ignore */ }

      // For React projects, also fetch the Pages URL
      let pagesUrl = null;
      if (projectType.toLowerCase().includes("react")) {
        try {
          const pages = await this._githubGet(token, `/repos/${project.owner}/${project.repo}/pages`);
          pagesUrl = pages.html_url;
        } catch (e) {
          pagesUrl = `https://${project.owner}.github.io/${project.repo}/`;
        }
      }

      this.send({
        type: "testBuilds",
        project,
        projectType,
        pagesUrl,
        builds,
      });
    } catch (err) {
      this.send({
        type: "testBuilds",
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Launch a test on the selected platform. For Appetize: downloads the
   * APK artifact, uploads to Appetize, returns the embed URL. For Pages:
   * returns the live URL. For Download: opens the artifact download page.
   */
  async handleLaunchTest(msg) {
    const project = this.context.globalState.get(ACTIVE_PROJECT_KEY);
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);

    if (msg.platform === "pages") {
      // For React — just return the Pages URL
      let pagesUrl = `https://${project.owner}.github.io/${project.repo}/`;
      try {
        const pages = await this._githubGet(token, `/repos/${project.owner}/${project.repo}/pages`);
        pagesUrl = pages.html_url;
      } catch (e) { /* use default */ }
      this.send({ type: "testLaunchResult", pagesUrl });
      return;
    }

    if (msg.platform === "download") {
      // Open the Actions run page in browser
      this.send({
        type: "testLaunchResult",
        error: "Click 'View run ↗' to download the artifact from GitHub.",
      });
      return;
    }

    // Appetize — fetch the tiny appetize-url.txt artifact (uploaded by the
    // workflow on GitHub's servers, NOT downloaded to the user's machine).
    // This is ~50 bytes — zero bandwidth impact.
    try {
      // Fetch artifacts for this run, looking for "appetize-url"
      const artsData = await this._githubGet(token, `/repos/${project.owner}/${project.repo}/actions/runs/${msg.runId}/artifacts`);
      const urlArtifact = (artsData.artifacts || []).find((a) => a.name === "appetize-url");
      if (!urlArtifact) {
        this.send({
          type: "testLaunchResult",
          error: "No Appetize URL found for this build. Make sure you've pushed the APPETIZE_API_KEY secret to GitHub (Settings → Appetize → Push to GitHub repos), then trigger a new build.",
        });
        return;
      }

      // Download the tiny appetize-url.txt ZIP (a few hundred bytes)
      const zipBuffer = await host.downloadArtifactZip(token, urlArtifact.archive_download_url);
      const txtFile = host.extractFirstFileWithExtension(zipBuffer, "txt");
      if (!txtFile) {
        this.send({ type: "testLaunchResult", error: "appetize-url.txt not found in artifact." });
        return;
      }

      const content = txtFile.buffer.toString("utf8").trim();
      if (content.startsWith("appetize_error=")) {
        this.send({ type: "testLaunchResult", error: "Workflow failed to upload to Appetize: " + content.slice("appetize_error=".length).slice(0, 200) });
        return;
      }
      if (!content.startsWith("https://appetize.io/embed/")) {
        this.send({ type: "testLaunchResult", error: "Invalid Appetize URL in artifact: " + content.slice(0, 100) });
        return;
      }

      // Success — embed URL is ready. Zero APK download through user's machine.
      this.send({
        type: "testLaunchResult",
        embedUrl: content,
        manageUrl: content.replace("/embed/", "/app/"),
      });
    } catch (err) {
      this.send({
        type: "testLaunchResult",
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  /**
   * Helper: GitHub GET request (returns parsed JSON).
   */
  async _githubGet(token, apiPath) {
    const https = require("https");
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "GET",
          hostname: "api.github.com",
          path: apiPath,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "CodeSage-CreateProject",
          },
        },
        (res) => {
          let chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (e) { reject(e); }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

module.exports = { activate, deactivate, reportRolloutActivation };
