/**
 * Create Project — host-side logic.
 *
 * Exposed surface:
 *   - runCreatePipeline(ctx)    -> creates repo, pushes scaffold, triggers build, reports results
 *   - enableAppetizePreview()   -> uploads APK to Appetize for live preview
 *   - getResumableRun(ctx)      -> checks for interrupted run to resume
 *   - forgetRun(ctx)            -> clears saved run state
 *
 * Pipeline stages:
 *   1. Resolve GitHub token (prompt if missing)
 *   2. Create target repo (POST /user/repos, public, auto_init)
 *   3. Push framework scaffold + workflow via Git Data API (single commit)
 *   4. Dispatch the workflow (POST .../actions/workflows/build.yml/dispatches)
 *   5. Poll run status until completed
 *   6. Fetch artifacts + (for React) GitHub Pages URL + (for Flutter) Appetize upload
 *   7. Send {type:'done', ...} with all results
 *
 * No LLM, no AI code generation — the wizard is purely a project creator.
 * All AI development happens in CodeSage's normal chat after the project is created.
 */

"use strict";

const https = require("https");
const { URL } = require("url");
// ----------------------------------------------------------------------------
// Cline file-based storage
// ----------------------------------------------------------------------------
//
// CodeSage (built on Cline) does NOT use VS Code's context.globalState or
// context.secrets for its API configuration. It uses its OWN file-based
// key-value store at:
//
//   ~/.cline/data/globalState.json   — all globalState keys as a JSON object
//   ~/.cline/data/secrets.json       — all secrets as a JSON object (mode 0o600)
//
// The directory can be overridden via CLINE_DATA_DIR or CLINE_DIR env vars.
// This was discovered by reading the bundled extension.original.js — the
// $5e class (ClineFileStorage) reads/writes a JSON file, and the data dir
// resolver function sz() defaults to ~/.cline/data.
//
// ALL LLM provider config + API keys live in these files, NOT in VS Code's
// storage. My earlier code read context.globalState / context.secrets, which
// is why it always reported "no key" — the keys were never there.

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
 * Get a value from Cline's globalState file. Falls back to VS Code's
 * context.globalState if the file doesn't have the key (for backwards
 * compat with any keys that might still be in VS Code's storage).
 */
function clineGet(context, key) {
  const fileState = readClineGlobalState();
  if (key in fileState && fileState[key] !== undefined) return fileState[key];
  return context.globalState.get(key);
}

/**
 * Get a secret from Cline's secrets file. Falls back to VS Code's
 * context.secrets if the file doesn't have the key.
 */
async function clineGetSecret(context, key) {
  const fileSecrets = readClineSecrets();
  if (key in fileSecrets && fileSecrets[key] !== undefined) return fileSecrets[key];
  try {
    return await context.secrets.get(key);
  } catch (e) {
    return undefined;
  }
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

// SecretStorage key for the Appetize.io API token. Mirrors the pattern used
// for the GitHub PAT (codesage.githubToken) — first-use prompt, then reused
// automatically forever after.
const APPETIZE_SECRET_KEY = "codesage.appetizeApiKey";

/**
 * Build the codesage-project.txt file content. This file is pushed to the
 * repo as part of the scaffold and stores the project type + the user's
 * description. When the user selects this repo from the Projects dropdown,
 * the dropdown reads this file via GitHub API and uses it to generate the
 * AI's instructions — no file-probing auto-detection needed.
 *
 * Format is simple key:value lines so it's easy to parse + human-readable.
 */
function buildProjectInfoFile(framework, request) {
  const lines = [
    `project_type: ${framework.label}`,
    `framework: ${request.framework || "unknown"}`,
    `platform: ${request.platform || "unknown"}`,
    `project_category: ${request.projectType || "unknown"}`,
    `created_at: ${new Date().toISOString()}`,
    "",
    "about:",
    request.description || "(no description provided)",
  ];
  return lines.join("\n") + "\n";
}

// Framework registry. Each entry contains:
//   - scaffold:    () => { [path: string]: string }   // files to push as the initial commit
//   - workflow:    () => string                        // .github/workflows/build.yml content
//   (llmPrompt/parseLlm removed in 3.1.0 — no more AI code generation)
//   - previewType: 'pages' | 'appetize' | 'download'   // how the user can try the result
const FRAMEWORKS = {
  react: {
    label: "React (Website)",
    projectType: "Website",
    platform: "Web",
    scaffold: scaffoldReact,
    workflow: workflowReact,
    previewType: "pages",
  },
  next: {
    label: "Next.js (Website)",
    projectType: "Website",
    platform: "Web",
    scaffold: scaffoldNext,
    workflow: workflowNext,
    previewType: "pages",
  },
  vue: {
    label: "Vue (Website)",
    projectType: "Website",
    platform: "Web",
    scaffold: scaffoldVue,
    workflow: workflowVue,
    previewType: "pages",
  },
  flutter: {
    label: "Flutter (Android)",
    projectType: "Mobile App",
    platform: "Android",
    scaffold: scaffoldFlutter,
    workflow: workflowFlutter,
    previewType: "appetize",
  },
  kotlin: {
    label: "Kotlin (Android)",
    projectType: "Mobile App",
    platform: "Android",
    scaffold: scaffoldKotlin,
    workflow: workflowKotlin,
    previewType: "appetize",
  },
  "react-native": {
    label: "React Native (Android)",
    projectType: "Mobile App",
    platform: "Android",
    scaffold: scaffoldReactNative,
    workflow: workflowReactNative,
    previewType: "appetize",
  },
  kivy: {
    label: "Kivy (Android)",
    projectType: "Mobile App",
    platform: "Android",
    scaffold: scaffoldKivy,
    workflow: workflowKivy,
    previewType: "appetize",
  },
  electron: {
    label: "Electron (Desktop)",
    projectType: "Desktop App",
    platform: "Cross-platform",
    scaffold: scaffoldElectron,
    workflow: workflowElectron,
    previewType: "download",
  },
  tauri: {
    label: "Tauri (Desktop)",
    projectType: "Desktop App",
    platform: "Cross-platform",
    scaffold: scaffoldTauri,
    workflow: workflowTauri,
    previewType: "download",
  },
};



// ----------------------------------------------------------------------------
// Public: run the full create-project pipeline
// ----------------------------------------------------------------------------
// Pipeline state persistence + resume
// ----------------------------------------------------------------------------

const PIPELINE_STATE_KEY = "codesage.createProject.lastRun";

/**
 * Save the current pipeline state to globalState so it can be resumed later
 * if the build fails or the user closes the wizard. Only persists what's
 * needed to skip already-completed stages — NOT the GitHub token (that's in
 * SecretStorage) or any secret values.
 */
async function savePipelineState(context, state) {
  try {
    await context.globalState.update(PIPELINE_STATE_KEY, state);
  } catch (e) {
    // non-fatal — resume just won't be available
  }
}

async function loadPipelineState(context) {
  try {
    return clineGet(context, PIPELINE_STATE_KEY) || null;
  } catch (e) {
    return null;
  }
}

async function clearPipelineState(context) {
  try {
    await context.globalState.update(PIPELINE_STATE_KEY, undefined);
  } catch (e) {
    // ignore
  }
}

/**
 * Public: read the last saved pipeline state (if any). Used by the wizard
 * on load to offer a "Resume" button.
 */
async function getResumableRun(context) {
  const state = await loadPipelineState(context);
  if (!state || !state.request || !state.stage) return null;
  return state;
}

/**
 * Public: clear the saved pipeline state. Called when the user clicks
 * "Start over" or when a run completes successfully.
 */
async function forgetRun(context) {
  await clearPipelineState(context);
}

// ----------------------------------------------------------------------------
// Public: run the full create-project pipeline
// ----------------------------------------------------------------------------

async function runCreatePipeline(ctx) {
  const { request, send, context, secrets, tokenKey } = ctx;
  const resumeState = ctx.resumeState || null; // set when resuming

  const framework = FRAMEWORKS[request.framework];
  if (!framework) {
    send({ type: "fatal", message: `Unknown framework: ${request.framework}` });
    return;
  }

  // Pipeline state — accumulates as each stage completes. If resuming,
  // pre-populate from the saved state so completed stages are skipped.
  const pipelineState = resumeState
    ? { ...resumeState, request } // request may have been edited
    : {
        request,
        stage: "token",
        repoName: null,
        owner: null,
        repoFullName: null,
        repoUrl: null,
        scaffoldCommitSha: null,
        runId: null,
        runUrl: null,
      };

  // Helper: persist current state + advance to next stage
  async function checkpoint(stage, extra = {}) {
    Object.assign(pipelineState, extra, { stage });
    await savePipelineState(context, pipelineState);
  }
  // --- Stage 1: token ---
  send({ type: "progress", stage: "token", message: "Resolving GitHub token..." });
  let token = await secrets.get(tokenKey);
  if (!token) {
    send({
      type: "needToken",
      message:
        "A GitHub Personal Access Token is required to create the repo and trigger builds. " +
        "Required scopes: repo, workflow. The token is stored in VS Code's encrypted SecretStorage.",
    });
    return; // wizard will re-invoke handleCreate after the user provides a token
  }

  // --- Stage 3: create repo (or skip if resuming and repo already created) ---
  let repoName, owner, repo;
  if (pipelineState.repoName && pipelineState.owner && pipelineState.repoUrl) {
    repoName = pipelineState.repoName;
    owner = pipelineState.owner;
    repo = { name: repoName, full_name: `${owner}/${repoName}`, html_url: pipelineState.repoUrl };
    send({
      type: "progress",
      stage: "repo",
      message: `Repo already created: ${repo.full_name} (resumed)`,
    });
  } else {
    repoName = sanitizeRepoName(request.repoName || `codesage-${Date.now()}`);
    send({
      type: "progress",
      stage: "repo",
      message: `Creating public repo '${repoName}'...`,
    });
    const user = await githubGet(token, "/user");
    owner = user.login;
    repo = await githubPost(token, "/user/repos", {
      name: repoName,
      description: request.spec
        ? truncate(request.spec, 80)
        : "Created by CodeSage Create Project wizard",
      private: false,
      // auto_init: true creates an initial commit with a README.md on the
      // 'main' branch. Without this, the repo has zero commits and GitHub's
      // Git Data API returns 409 "Git Repository is empty." on every blob /
      // tree / commit / ref call. Setting it to true means refs/heads/main
      // exists, so commitFilesViaGitData can use it as the parent and push
      // the scaffold as a normal second commit (the scaffold's own README.md
      // will overwrite the auto-init one via the base_tree overlay).
      auto_init: true,
    });
    send({
      type: "progress",
      stage: "repo",
      message: `Repo created: ${repo.full_name}`,
    });
    await checkpoint("scaffold", {
      repoName,
      owner,
      repoFullName: repo.full_name,
      repoUrl: repo.html_url,
    });
  }

  // --- Stage 4 + 5: scaffold commit (or skip if resuming and scaffold already pushed) ---
  let scaffoldCommitSha;
  if (pipelineState.scaffoldCommitSha) {
    scaffoldCommitSha = pipelineState.scaffoldCommitSha;
    send({
      type: "progress",
      stage: "scaffold",
      message: `Scaffold already pushed: ${scaffoldCommitSha.slice(0, 7)} (resumed)`,
    });
  } else {
    send({ type: "progress", stage: "scaffold", message: `Building ${framework.label} scaffold...` });
    const scaffoldFiles = framework.scaffold();
    // Add the workflow file at .github/workflows/build.yml so it's in the same commit
    scaffoldFiles[".github/workflows/build.yml"] = framework.workflow();
    // Add codesage-project.txt — stores the project type + user's description
    // so the Projects dropdown can read it later and tell the AI what kind
    // of project this is (no auto-detection needed).
    scaffoldFiles["codesage-project.txt"] = buildProjectInfoFile(framework, request);
    send({
      type: "progress",
      stage: "scaffold",
      message: `Pushing ${Object.keys(scaffoldFiles).length} files via Git Data API...`,
    });
    const scaffoldCommit = await commitFilesViaGitData(
      token,
      owner,
      repo.name,
      "Initial scaffold (CodeSage Create Project)",
      scaffoldFiles,
      null // parentSha = null -> creates the initial commit on the empty repo
    );
    scaffoldCommitSha = scaffoldCommit.sha;
    send({
      type: "progress",
      stage: "scaffold",
      message: `Scaffold commit pushed: ${scaffoldCommitSha.slice(0, 7)}`,
    });
    await checkpoint("done", { scaffoldCommitSha });
  }

  // --- DONE — stop here. No build, no dispatch, no polling. ---
  // The scaffold + workflow are pushed. The build will trigger automatically
  // when the AI (or the user) pushes code changes via the GitHub MCP.
  // The wizard's job is done — it created the project, nothing more.
  await clearPipelineState(context);
  send({
    type: "done",
    success: true,
    conclusion: "scaffold_pushed",
    repoUrl: repo.html_url,
    runUrl: null,
    pagesUrl: null,
    previewType: framework.previewType,
    artifacts: [],
    owner,
    repo: repo.name,
    appetizeEmbedUrl: null,
    appetizeManageUrl: null,
    appetizeError: null,
    appetizeKeyNeeded: false,
  });
}

// ----------------------------------------------------------------------------
// GitHub API primitives
// ----------------------------------------------------------------------------

function githubGet(token, path) {
  return githubRequest(token, "GET", path, null);
}

function githubPost(token, path, body) {
  return githubRequest(token, "POST", path, body || {});
}

function githubRequest(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(GITHUB_API + apiPath);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "CodeSage-CreateProject",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        let chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (e) {
            parsed = text;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg =
              (parsed && (parsed.message || parsed.error)) ||
              `HTTP ${res.statusCode}`;
            const err = new Error(`${msg} (${method} ${apiPath})`);
            err.status = res.statusCode;
            err.body = parsed;
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ----------------------------------------------------------------------------
// Git Data API: commit many files in a single commit (blobs -> tree -> commit -> ref)
// ----------------------------------------------------------------------------

async function commitFilesViaGitData(
  token,
  owner,
  repo,
  message,
  files,
  parentSha
) {
  // 1. Get the current ref (heads/main). If no parent, we'll create it.
  let baseTreeSha = null;
  if (parentSha) {
    baseTreeSha = parentSha;
  } else {
    // Try to read the existing HEAD commit; if repo is empty, this will 404 and we proceed with baseTreeSha=null.
    try {
      const ref = await githubGet(
        token,
        `/repos/${owner}/${repo}/git/refs/heads/main`
      );
      parentSha = ref.object.sha;
      baseTreeSha = parentSha;
    } catch (e) {
      // Repo is empty — no parent commit. We'll create the initial commit.
      parentSha = null;
      baseTreeSha = null;
    }
  }

  // 2. Create a blob for each file (parallel).
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    content: String(content),
  }));
  const blobShas = await Promise.all(
    entries.map(async (e) => {
      const blob = await githubPost(
        token,
        `/repos/${owner}/${repo}/git/blobs`,
        { content: e.content, encoding: "utf-8" }
      );
      return { path: e.path, sha: blob.sha };
    })
  );

  // 3. Create a tree referencing the blobs.
  const tree = await githubPost(token, `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: blobShas.map((b) => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      sha: b.sha,
    })),
  });

  // 4. Create the commit.
  const commitPayload = {
    message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  };
  const commit = await githubPost(
    token,
    `/repos/${owner}/${repo}/git/commits`,
    commitPayload
  );

  // 5. Update the ref (or create it if it doesn't exist).
  try {
    await githubPatch(
      token,
      `/repos/${owner}/${repo}/git/refs/heads/main`,
      { sha: commit.sha, force: false }
    );
  } catch (e) {
    // ref doesn't exist yet -> create it
    await githubPost(
      token,
      `/repos/${owner}/${repo}/git/refs`,
      { sha: commit.sha, ref: "refs/heads/main" }
    );
  }

  return commit;
}

function githubPatch(token, path, body) {
  return githubRequest(token, "PATCH", path, body || {});
}

// ----------------------------------------------------------------------------
// React scaffold + workflow
// ----------------------------------------------------------------------------

function scaffoldReact() {
  return {
    "package.json": JSON.stringify(
      {
        name: "codesage-app",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "tsc -b && vite build",
          preview: "vite preview --host --port 4173",
          test: "playwright test",
        },
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          "@playwright/test": "^1.48.0",
          "@types/react": "^18.3.12",
          "@types/react-dom": "^18.3.1",
          "@vitejs/plugin-react": "^4.3.3",
          typescript: "^5.6.3",
          vite: "^5.4.10",
        },
      },
      null,
      2
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          useDefineForClassFields: true,
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          skipLibCheck: true,
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noFallthroughCasesInSwitch: true,
        },
        include: ["src"],
      },
      null,
      2
    ),
    "tsconfig.node.json": JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          skipLibCheck: true,
          module: "ESNext",
          moduleResolution: "bundler",
          allowSyntheticDefaultImports: true,
        },
        include: ["vite.config.ts"],
      },
      null,
      2
    ),
    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodeSage App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/main.tsx": `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
    "src/App.tsx": `// Placeholder. Will be overwritten by CodeSage AI code generation.
import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 32, textAlign: "center" }}>
      <h1>CodeSage App</h1>
      <p>Waiting for AI-generated content...</p>
      <button onClick={() => setCount((c) => c + 1)}>clicked {count} times</button>
    </div>
  );
}
`,
    "src/index.css": `:root { font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; }
#root { min-height: 100vh; }
`,
    "tests/app.spec.ts": `import { test, expect } from "@playwright/test";

test("app renders heading", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("body")).not.toBeEmpty();
  // Take a screenshot for the artifacts
  await page.screenshot({ path: "screenshots/home.png", fullPage: true });
});

test("no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto("./");
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
`,
    "playwright.config.ts": `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:4173",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
`,
    ".gitignore": `node_modules
dist
playwright-report
test-results
screenshots
*.log
.env
`,
    "README.md": `# CodeSage App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
npm install
npm run dev
\`\`\`

## Build

\`\`\`bash
npm run build
npm run preview
\`\`\`

## Test

\`\`\`bash
npm run test
\`\`\`
`,
  };
}

function workflowReact() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci || npm install
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

// ----------------------------------------------------------------------------
// Flutter scaffold + workflow
// ----------------------------------------------------------------------------

function scaffoldFlutter() {
  // Use a stable Dart package name derived from the repo name (applied at scaffold time
  // via a placeholder; the workflow will flutter create --platforms=android . to normalize
  // missing files, so we only need the essential hand-written skeleton).
  const pkgName = "codesage_app";
  return {
    "pubspec.yaml": `name: ${pkgName}
description: A Flutter app created by the CodeSage Create Project wizard.
publish_to: none
version: 0.1.0+1

environment:
  sdk: ">=3.3.0 <4.0.0"
  flutter: ">=3.19.0"

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`,
    "analysis_options.yaml": `include: package:flutter_lints/flutter.yaml

linter:
  rules:
    avoid_print: false
    prefer_single_quotes: true
`,
    "lib/main.dart": `// Placeholder. Will be overwritten by CodeSage AI code generation.
import 'package:flutter/material.dart';

void main() {
  runApp(const CodeSageApp());
}

class CodeSageApp extends StatelessWidget {
  const CodeSageApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CodeSage App',
      theme: ThemeData(colorSchemeSeed: Colors.blue, useMaterial3: true),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _counter = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('CodeSage App')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('Waiting for AI-generated content...'),
            Text('\$_counter', style: Theme.of(context).textTheme.headlineMedium),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => setState(() => _counter++),
        child: const Icon(Icons.add),
      ),
    );
  }
}
`,
    "test/widget_test.dart": `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:${pkgName}/main.dart';

void main() {
  testWidgets('App renders home page', (WidgetTester tester) async {
    await tester.pumpWidget(const CodeSageApp());
    expect(find.text('CodeSage App'), findsOneWidget);
  });
`,
    "android/app/build.gradle": `plugins {
    id "com.android.application"
    id "kotlin-android"
    id "dev.flutter.flutter-gradle-plugin"
}

def localProperties = new Properties()
def localPropertiesFile = rootProject.file("local.properties")
if (localPropertiesFile.exists()) {
    localPropertiesFile.withReader("UTF-8") { reader ->
        localProperties.load(reader)
    }
}

def flutterVersionCode = localProperties.getProperty("flutter.versionCode") ?: "1"
def flutterVersionName = localProperties.getProperty("flutter.versionName") ?: "1.0"

android {
    namespace "com.codesage.app"
    compileSdk flutter.compileSdkVersion
    ndkVersion flutter.ndkVersion

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = '17'
    }

    sourceSets {
        main.java.srcDirs += 'src/main/kotlin'
    }

    defaultConfig {
        applicationId "com.codesage.app"
        minSdk flutter.minSdkVersion
        targetSdk flutter.targetSdkVersion
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }

    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}

flutter {
    source "../.."
}
`,
    "android/build.gradle": `allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.buildDir = "../build"
subprojects {
    project.buildDir = "\${rootProject.buildDir}/\${project.name}"
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register("clean", Delete) {
    delete rootProject.buildDir
}
`,
    "android/settings.gradle": `pluginManagement {
    def flutterSdkPath = {
        def properties = new Properties()
        file("local.properties").withInputStream { properties.load(it) }
        def flutterSdkPath = properties.getProperty("flutter.sdk")
        assert flutterSdkPath != null, "flutter.sdk not set in local.properties"
        return flutterSdkPath
    }()

    includeBuild("\${flutterSdkPath}/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id "dev.flutter.flutter-plugin-loader" version "1.0.0"
    id "com.android.application" version "8.7.0" apply false
    id "org.jetbrains.kotlin.android" version "2.0.21" apply false
}

include ":app"
`,
    "android/gradle.properties": `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G -XX:+HeapDumpOnOutOfMemoryError
android.useAndroidX=true
android.enableJetifier=true
`,
    "android/app/src/main/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="CodeSage App"
        android:name="\${applicationName}"
        android:icon="@drawable/ic_launcher">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:taskAffinity=""
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme"
              />
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
</manifest>
`,
    "android/app/src/main/kotlin/com/codesage/app/MainActivity.kt": `package com.codesage.app

import io.flutter.embedding.android.FlutterActivity

class MainActivity: FlutterActivity()
`,
    "android/app/src/main/res/values/styles.xml": `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="LaunchTheme" parent="@android:style/Theme.Light.NoTitleBar">
        <item name="android:windowBackground">@drawable/launch_background</item>
    </style>
    <style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
        <item name="android:windowBackground">?android:colorBackground</item>
    </style>
</resources>
`,
    "android/app/src/main/res/drawable/launch_background.xml": `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="?android:colorBackground" />
</layer-list>
`,
    "android/app/src/main/res/drawable/ic_launcher.xml": `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#2196F3"
        android:pathData="M0,0h108v108h-108z" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M27,27h54v54h-54z"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="0" />
    <path
        android:fillColor="#2196F3"
        android:pathData="M40,40h28v28h-28z" />
</vector>
`,
    ".gitignore": `# Flutter / Dart
.dart_tool/
.flutter-plugins
.flutter-plugins-dependencies
.packages
.pub-cache/
.pub/
build/
flutter_*.png
flutter_*.png.ref

# Android
android/.gradle/
android/captures/
android/gradlew
android/gradlew.bat
android/local.properties
android/**/GeneratedPluginRegistrant.java
android/key.properties
*.jks

# IDE
.idea/
.vscode/
*.iml

# Misc
.DS_Store
*.log
.env
`,
    "README.md": `# CodeSage Flutter App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
flutter pub get
flutter run
\`\`\`

## Build a debug APK

\`\`\`bash
flutter build apk --debug
\`\`\`

## Test

\`\`\`bash
flutter test
\`\`\`
`,
  };
}

function workflowFlutter() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          cache: true
      - run: flutter pub get
      - run: flutter build apk --debug
      - uses: actions/upload-artifact@v4
        with:
          name: apk
          path: build/app/outputs/flutter-apk/*.apk
          retention-days: 14
      - name: Upload to Appetize.io
        if: \${{ secrets.APPETIZE_API_KEY != '' }}
        env:
          APPETIZE_API_KEY: \${{ secrets.APPETIZE_API_KEY }}
        run: |
          APK_FILE=$(find build/app/outputs/flutter-apk -name "*.apk" | head -1)
          RESPONSE=$(curl -s -X POST "https://api.appetize.io/v1/apps" \\
            -u "\${APPETIZE_API_KEY}:" \\
            -F "platform=android" \\
            -F "file=@\${APK_FILE};type=application/vnd.android.package-archive")
          PUBLIC_KEY=$(echo "\${RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('publicKey',''))" 2>/dev/null || echo "")
          if [ -z "\${PUBLIC_KEY}" ]; then
            echo "Appetize upload failed: \${RESPONSE}"
            echo "appetize_error=\${RESPONSE}" > appetize-url.txt
          else
            echo "https://appetize.io/embed/\${PUBLIC_KEY}?device=pixel4&osVersion=11.0&scale=auto&orientation=portrait" > appetize-url.txt
            echo "Appetize URL: https://appetize.io/app/\${PUBLIC_KEY}"
          fi
      - name: Upload Appetize URL
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: appetize-url
          path: appetize-url.txt
          if-no-files-found: ignore
          retention-days: 14
`;
}

// ----------------------------------------------------------------------------
// Appetize.io live-preview (used by frameworks whose previewType === "appetize")
// ----------------------------------------------------------------------------
//
// Flow:
//   1. (in runCreatePipeline) after GitHub Actions run completes, look for the
//      'apk' artifact. If user has stored an Appetize API key, download the
//      artifact ZIP, extract the .apk, upload it to Appetize, and include the
//      embed URL in the `done` message. If no key is stored, set
//      `appetizeKeyNeeded: true` and let the wizard prompt the user.
//   2. (in enableAppetizePreview, called from the wizard after `done`) the
//      user has entered a key. Store it, then redo the download/extract/upload
//      flow and emit `appetizeReady` or `appetizeFailed` so the wizard can
//      update the results panel without a full page reload.
//
// All Appetize calls return `{ ok, error, embedUrl, manageUrl }` rather than
// throwing — quota / auth / network failures are surfaced as `ok: false` with
// a human-readable error, never as exceptions.

const APPETIZE_API_HOST = "api.appetize.io";
const APPETIZE_EMBED_TEMPLATE = "https://appetize.io/embed/{PUBLIC_KEY}?device=pixel4&osVersion=11.0&scale=auto&orientation=portrait";
const APPETIZE_MANAGE_TEMPLATE = "https://appetize.io/app/{PUBLIC_KEY}";

/**
 * Build a multipart/form-data body from a fields object. String values become
 * plain form fields; objects of shape `{ buffer, filename, contentType }`
 * become file uploads. Returns `{ body: Buffer, contentType: string }`.
 *
 * Implemented by hand because we don't want to pull in `form-data` as a
 * dependency just for one upload.
 */
function buildMultipartBody(fields) {
  const boundary =
    "----CodeSageBoundary" +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          "utf8"
        )
      );
    } else if (typeof value === "object" && Buffer.isBuffer(value.buffer)) {
      const filename = value.filename || "file";
      const contentType = value.contentType || "application/octet-stream";
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
          "utf8"
        )
      );
      parts.push(value.buffer);
      parts.push(Buffer.from("\r\n", "utf8"));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Upload an APK buffer to Appetize.io. Returns:
 *   { ok: true, publicKey, embedUrl, manageUrl }   on success
 *   { ok: false, error }                            on any failure (never throws)
 *
 * Quota/rate-limit/auth errors are mapped to clear, user-facing messages so
 * the wizard can show them inline without exposing HTTP status noise.
 */
function uploadToAppetize(apkBuffer, appetizeApiKey) {
  return new Promise((resolve) => {
    if (!apkBuffer || !Buffer.isBuffer(apkBuffer) || apkBuffer.length === 0) {
      resolve({ ok: false, error: "No APK bytes to upload." });
      return;
    }
    if (!appetizeApiKey) {
      resolve({ ok: false, error: "No Appetize API key provided." });
      return;
    }

    // Appetize uses HTTP Basic Auth with the API token as the username and
    // an empty password.
    const basicAuth = Buffer.from(`${appetizeApiKey}:`).toString("base64");
    const { body, contentType } = buildMultipartBody({
      platform: "android",
      file: {
        buffer: apkBuffer,
        filename: "app-debug.apk",
        contentType: "application/vnd.android.package-archive",
      },
    });

    const req = https.request(
      {
        method: "POST",
        hostname: APPETIZE_API_HOST,
        path: "/v1/apps",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": contentType,
          "Content-Length": body.length,
          "User-Agent": "CodeSage-CreateProject",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (e) {
            parsed = text;
          }

          if (res.statusCode >= 200 && res.statusCode < 300 && parsed) {
            // Appetize response shape: { publicKey: "...", ... }
            // Some older docs use public_key. Be lenient.
            const publicKey =
              parsed.publicKey ||
              parsed.public_key ||
              (parsed.app && (parsed.app.publicKey || parsed.app.public_key));
            if (publicKey) {
              const embedUrl = APPETIZE_EMBED_TEMPLATE.replace(
                "{PUBLIC_KEY}",
                publicKey
              );
              const manageUrl = APPETIZE_MANAGE_TEMPLATE.replace(
                "{PUBLIC_KEY}",
                publicKey
              );
              resolve({ ok: true, publicKey, embedUrl, manageUrl });
              return;
            }
            resolve({
              ok: false,
              error:
                "Appetize accepted the upload but did not return a publicKey. Response: " +
                text.slice(0, 300),
            });
            return;
          }

          // Map well-known failure modes to clear messages.
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({
              ok: false,
              error:
                "Appetize.io rejected the API key. Check your token at appetize.io/settings.",
            });
            return;
          }
          if (res.statusCode === 402) {
            resolve({
              ok: false,
              error:
                "Appetize.io free-tier quota exceeded. Upgrade your Appetize plan or wait until your quota resets.",
            });
            return;
          }
          if (res.statusCode === 429) {
            resolve({
              ok: false,
              error:
                "Appetize.io rate limit reached. Wait a minute and try again, or upload fewer apps.",
            });
            return;
          }
          if (res.statusCode === 413) {
            resolve({
              ok: false,
              error:
                "APK is too large for Appetize.io's upload limit. Try a smaller debug build or strip unused ABIs.",
            });
            return;
          }

          const msg =
            (parsed &&
              (parsed.error?.message ||
                parsed.message ||
                parsed.error)) ||
            `HTTP ${res.statusCode}`;
          resolve({
            ok: false,
            error: `Appetize upload failed: ${msg}`,
          });
        });
      }
    );
    req.on("error", (err) => {
      resolve({
        ok: false,
        error: `Network error uploading to Appetize: ${err.message}`,
      });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Download a URL into a Buffer, following up to 5 HTTP redirects. When the
 * redirect goes cross-host (e.g. api.github.com -> objects.githubusercontent.com),
 * the Authorization header is stripped so we don't leak the GitHub token.
 */
function downloadBuffer(url, headers, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { ...headers, "User-Agent": "CodeSage-CreateProject" },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const nextUrl = res.headers.location;
          const nextU = new URL(nextUrl);
          const nextHeaders = { ...headers };
          // Drop auth-related headers when redirected cross-host
          if (nextU.hostname !== u.hostname) {
            delete nextHeaders.Authorization;
            delete nextHeaders["X-GitHub-Api-Version"];
            delete nextHeaders.Accept;
          }
          res.resume(); // drain
          resolve(downloadBuffer(nextUrl, nextHeaders, maxRedirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Download a GitHub Actions artifact ZIP. The `archive_download_url` returns
 * a 302 to a short-lived S3 URL — `downloadBuffer` follows it and strips the
 * Authorization header when the host changes.
 */
function downloadArtifactZip(token, archiveDownloadUrl) {
  return downloadBuffer(archiveDownloadUrl, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  });
}

/**
 * Minimal ZIP local-file-header parser. Walks the entries in a ZIP buffer and
 * returns the first one whose filename ends with the given extension.
 *
 * Implemented by hand because we don't want to bundle a full unzip library
 * just for this one use case. Supports the two compression methods GitHub
 * artifact ZIPs use: 0 (stored) and 8 (deflate-raw). Any other method throws.
 *
 * Handles entries written in "streaming" mode (general-purpose bit flag 3
 * set), where the local header's compressed-size field is 0 and the real
 * size is only recorded in a data descriptor written after the file's
 * bytes. Without this, streamed entries produce a truncated/empty buffer
 * and `zlib.inflateRawSync` throws "unexpected end of file".
 *
 * Returns `{ name, buffer }` or `null` if no matching entry is found.
 */
function extractFirstFileWithExtension(zipBuffer, extension) {
  const LOCAL_FILE_HEADER_SIG = 0x04034b50;
  const DATA_DESCRIPTOR_SIG = 0x08074b50;
  const CENTRAL_DIR_SIG = 0x02014b50;
  const STREAMED_FLAG = 0x0008;
  const ext = "." + extension.toLowerCase();
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (offset + 30 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig !== LOCAL_FILE_HEADER_SIG) break;
    const flags = zipBuffer.readUInt16LE(offset + 6);
    const method = zipBuffer.readUInt16LE(offset + 8);
    const headerCompSize = zipBuffer.readUInt32LE(offset + 18);
    const nameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > zipBuffer.length) break;
    const name = zipBuffer.slice(nameStart, nameEnd).toString("utf8");
    const dataStart = nameEnd + extraLen;

    let dataEnd;
    let descriptorLen = 0;
    if (flags & STREAMED_FLAG) {
      // Size unknown up front — the header's compSize field is unreliable
      // (typically 0). Scan forward for the data descriptor (or, if it
      // omitted its optional signature, for the next entry/central-dir
      // header) to find where this entry's bytes actually end.
      let searchFrom = dataStart;
      let boundary = -1;
      while (searchFrom + 4 <= zipBuffer.length) {
        const maybeSig = zipBuffer.readUInt32LE(searchFrom);
        if (
          maybeSig === DATA_DESCRIPTOR_SIG ||
          maybeSig === LOCAL_FILE_HEADER_SIG ||
          maybeSig === CENTRAL_DIR_SIG
        ) {
          boundary = searchFrom;
          break;
        }
        searchFrom++;
      }
      if (boundary === -1) break; // truncated/corrupt zip — bail out cleanly
      if (zipBuffer.readUInt32LE(boundary) === DATA_DESCRIPTOR_SIG) {
        dataEnd = boundary;
        descriptorLen = 16; // sig(4) + crc(4) + compSize(4) + uncompSize(4)
      } else {
        // Descriptor present but without its optional signature: the 12
        // bytes immediately before the next header are crc+compSize+uncompSize.
        dataEnd = boundary - 12;
        descriptorLen = 12;
      }
    } else {
      dataEnd = dataStart + headerCompSize;
    }

    if (dataEnd > zipBuffer.length || dataEnd < dataStart) break;

    if (name.toLowerCase().endsWith(ext)) {
      const rawData = zipBuffer.slice(dataStart, dataEnd);
      let buffer;
      if (method === 0) {
        buffer = rawData;
      } else if (method === 8) {
        // deflate-raw (no zlib header)
        const zlib = require("zlib");
        buffer = zlib.inflateRawSync(rawData);
      } else {
        throw new Error(
          `Unsupported ZIP compression method ${method} for entry '${name}'`
        );
      }
      return { name, buffer };
    }

    offset = flags & STREAMED_FLAG ? dataEnd + descriptorLen : dataEnd;
  }
  return null;
}

/**
 * Internal: the shared download → extract → upload flow used by both the
 * pipeline (auto-upload at the end) and `enableAppetizePreview` (user entered
 * key after `done`). Returns `{ ok, error, embedUrl, manageUrl }`.
 */
async function _appetizeUploadFlow({
  token,
  send,
  archiveDownloadUrl,
  artifactSize,
  apiKey,
}) {
  try {
    send({
      type: "progress",
      stage: "preview",
      message: `Downloading APK artifact${artifactSize ? ` (${formatBytes(artifactSize)})` : ""}...`,
    });
    const zipBuffer = await downloadArtifactZip(token, archiveDownloadUrl);
    send({
      type: "progress",
      stage: "preview",
      message: `Extracting APK from ${formatBytes(zipBuffer.length)} ZIP...`,
    });
    const apkFile = extractFirstFileWithExtension(zipBuffer, "apk");
    if (!apkFile) {
      return { ok: false, error: "No .apk file found inside the artifact ZIP." };
    }
    send({
      type: "progress",
      stage: "preview",
      message: `Uploading ${apkFile.name} (${formatBytes(apkFile.buffer.length)}) to Appetize.io...`,
    });
    const result = await uploadToAppetize(apkFile.buffer, apiKey);
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Public entry point invoked by the wizard's `enableAppetize` message — used
 * after `done` has already been sent, when the user has just entered (or
 * replaced) their Appetize API key. Stores the key, then runs the upload flow
 * and emits `appetizeReady` or `appetizeFailed` back to the wizard.
 *
 * Never throws — all failures go back as `appetizeFailed` with a clear
 * message, so the wizard can keep the rest of the results panel intact.
 */
async function enableAppetizePreview({
  secrets,
  token,
  archiveDownloadUrl,
  apiKey,
  send,
}) {
  if (!apiKey) {
    send({ type: "appetizeFailed", error: "No Appetize API key provided." });
    return;
  }
  if (!archiveDownloadUrl) {
    send({
      type: "appetizeFailed",
      error: "No artifact URL provided — cannot download the APK.",
    });
    return;
  }
  if (!token) {
    send({
      type: "appetizeFailed",
      error: "No GitHub token available to download the artifact.",
    });
    return;
  }

  // Persist the key for next time. Do this BEFORE the upload so that even if
  // the upload fails, the key is saved and the user can retry without
  // re-entering it.
  try {
    await secrets.store(APPETIZE_SECRET_KEY, apiKey);
  } catch (e) {
    // Storage failure is not fatal — continue with the in-memory key.
  }

  const result = await _appetizeUploadFlow({
    token,
    send,
    archiveDownloadUrl,
    apiKey,
  });
  if (result.ok) {
    send({
      type: "appetizeReady",
      embedUrl: result.embedUrl,
      manageUrl: result.manageUrl,
    });
  } else {
    send({ type: "appetizeFailed", error: result.error });
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function sanitizeRepoName(name) {
  let s = String(name).toLowerCase().trim();
  s = s.replace(/[^a-z0-9._-]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (!s) s = "codesage-app";
  if (s.length > 60) s = s.slice(0, 60);
  return s;
}

function truncate(s, n) {
  s = String(s).trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return "?";
  n = Number(n);
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}


// ----------------------------------------------------------------------------
// Next.js scaffold + workflow (static export, deploys to GitHub Pages)
// ----------------------------------------------------------------------------
function scaffoldNext() {
  return {
    "package.json": JSON.stringify({
      name: "codesage-app",
      private: true,
      version: "0.0.0",
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
      },
      dependencies: {
        next: "^14.2.15",
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
      devDependencies: {
        "@types/node": "^20.11.0",
        "@types/react": "^18.3.12",
        "@types/react-dom": "^18.3.1",
        typescript: "^5.6.3",
      },
    }, null, 2),
    "next.config.mjs": `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};
export default nextConfig;
`,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    }, null, 2),
    "next-env.d.ts": `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`,
    "app/layout.tsx": `export const metadata = {
  title: "CodeSage App",
  description: "Created by the CodeSage Create Project wizard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
`,
    "app/page.tsx": `// Placeholder. Will be overwritten by CodeSage AI code generation.
export default function Page() {
  return (
    <main style={{ padding: 32, textAlign: "center" }}>
      <h1>CodeSage App</h1>
      <p>Waiting for AI-generated content...</p>
    </main>
  );
}
`,
    ".gitignore": `node_modules
.next
out
*.log
.env
`,
    "README.md": `# CodeSage Next.js App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
npm install
npm run dev
\`\`\`

## Build (static export)

\`\`\`bash
npm run build
\`\`\`
`,
  };
}

function workflowNext() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci || npm install
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: out
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

// ----------------------------------------------------------------------------
// Vue scaffold + workflow (Vite + Vue 3, deploys to GitHub Pages)
// ----------------------------------------------------------------------------
function scaffoldVue() {
  return {
    "package.json": JSON.stringify({
      name: "codesage-app",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "vue-tsc -b && vite build",
        preview: "vite preview --host --port 4173",
      },
      dependencies: { vue: "^3.5.12" },
      devDependencies: {
        "@vitejs/plugin-vue": "^5.1.4",
        typescript: "^5.6.3",
        vite: "^5.4.10",
        "vue-tsc": "^2.1.10",
      },
    }, null, 2),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        jsx: "preserve",
        resolveJsonModule: true,
        isolatedModules: true,
        esModuleInterop: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.tsx", "src/**/*.vue"],
    }, null, 2),
    "vite.config.ts": `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodeSage App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
import "./index.css";

createApp(App).mount("#app");
`,
    "src/App.vue": `<!-- Placeholder. Will be overwritten by CodeSage AI code generation. -->
<script setup lang="ts">
import { ref } from "vue";
const count = ref(0);
</script>

<template>
  <main>
    <h1>CodeSage App</h1>
    <p>Waiting for AI-generated content...</p>
    <button @click="count++">clicked {{ count }} times</button>
  </main>
</template>

<style scoped>
main { font-family: system-ui, sans-serif; padding: 32px; text-align: center; }
</style>
`,
    "src/index.css": `:root { font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; }
#app { min-height: 100vh; }
`,
    "src/shims-vue.d.ts": `declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
`,
    ".gitignore": `node_modules
dist
*.log
.env
`,
    "README.md": `# CodeSage Vue App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
npm install
npm run dev
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`
`,
  };
}

function workflowVue() {
  return workflowNext().replace("path: out", "path: dist");
}

// ----------------------------------------------------------------------------
// Kotlin (native Android) scaffold + workflow (APK, Appetize preview)
// ----------------------------------------------------------------------------
function scaffoldKotlin() {
  return {
    "settings.gradle.kts": `pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "codesage-app"
include(":app")
`,
    "build.gradle.kts": `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`,
    "gradle.properties": `org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
`,
    "app/build.gradle.kts": `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.codesage.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.codesage.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
`,
    "app/src/main/AndroidManifest.xml": `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="CodeSage App"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/Theme.CodeSage">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
    "app/src/main/kotlin/com/codesage/app/MainActivity.kt": `package com.codesage.app

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

// Placeholder. Will be overwritten by CodeSage AI code generation.
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply {
            text = "CodeSage App\nWaiting for AI-generated content..."
            textSize = 20f
            setPadding(64, 128, 64, 64)
        }
        setContentView(tv)
    }
}
`,
    "app/src/main/res/values/styles.xml": `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.CodeSage" parent="Theme.MaterialComponents.DayNight.NoActionBar" />
</resources>
`,
    "app/src/main/res/values/strings.xml": `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">CodeSage App</string>
</resources>
`,
    "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml": `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_bg" />
    <foreground android:drawable="@color/ic_launcher_bg" />
</adaptive-icon>
`,
    "app/src/main/res/values/colors.xml": `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_bg">#2196F3</color>
</resources>
`,
    ".gitignore": `.gradle/
build/
local.properties
.idea/
*.iml
*.log
.env
`,
    "README.md": `# CodeSage Kotlin Android App

Created with the CodeSage Create Project wizard.

## Build

\`\`\`bash
./gradlew assembleDebug
\`\`\`
`,
  };
}

function workflowKotlin() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: android-actions/setup-android@v3
      - name: Grant gradle wrapper (bootstrap if missing)
        run: |
          if [ ! -f gradlew ]; then
            gradle wrapper --gradle-version 8.7
          fi
          chmod +x gradlew
      - run: ./gradlew assembleDebug --no-daemon
      - uses: actions/upload-artifact@v4
        with:
          name: apk
          path: app/build/outputs/apk/debug/*.apk
          retention-days: 14
`;
}

// ----------------------------------------------------------------------------
// React Native scaffold + workflow (Expo bare, Android APK)
// ----------------------------------------------------------------------------
function scaffoldReactNative() {
  return {
    "package.json": JSON.stringify({
      name: "codesage-app",
      version: "0.0.1",
      private: true,
      main: "node_modules/expo/AppEntry.js",
      scripts: {
        start: "expo start",
        android: "expo run:android",
        prebuild: "expo prebuild --platform android --non-interactive",
      },
      dependencies: {
        expo: "~51.0.28",
        react: "18.2.0",
        "react-native": "0.74.5",
      },
      devDependencies: {
        "@babel/core": "^7.24.0",
      },
    }, null, 2),
    "app.json": JSON.stringify({
      expo: {
        name: "CodeSage App",
        slug: "codesage-app",
        version: "0.1.0",
        orientation: "portrait",
        android: {
          package: "com.codesage.app",
        },
      },
    }, null, 2),
    "babel.config.js": `module.exports = function (api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
`,
    "App.tsx": `// Placeholder. Will be overwritten by CodeSage AI code generation.
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>CodeSage App</Text>
      <Text>Waiting for AI-generated content...</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  title: { fontSize: 24, fontWeight: "600", marginBottom: 12 },
});
`,
    ".gitignore": `node_modules
.expo
android
ios
*.log
.env
`,
    "README.md": `# CodeSage React Native (Expo) App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
npm install
npx expo start
\`\`\`

## Build APK (Android)

CI runs \`expo prebuild\` and \`gradle assembleDebug\`.
`,
  };
}

function workflowReactNative() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: android-actions/setup-android@v3
      - run: npm install
      - run: npx expo prebuild --platform android --non-interactive
      - name: Build debug APK
        working-directory: android
        run: |
          chmod +x gradlew
          ./gradlew assembleDebug --no-daemon
      - uses: actions/upload-artifact@v4
        with:
          name: apk
          path: android/app/build/outputs/apk/debug/*.apk
          retention-days: 14
`;
}

// ----------------------------------------------------------------------------
// Kivy scaffold + workflow (Python, buildozer -> Android APK)
// ----------------------------------------------------------------------------
function scaffoldKivy() {
  return {
    "main.py": `# Placeholder. Will be overwritten by CodeSage AI code generation.
from kivy.app import App
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.label import Label
from kivy.uix.button import Button


class Root(BoxLayout):
    def __init__(self, **kwargs):
        super().__init__(orientation="vertical", padding=32, spacing=16, **kwargs)
        self.add_widget(Label(text="CodeSage App", font_size="24sp"))
        self.add_widget(Label(text="Waiting for AI-generated content..."))
        self.counter = 0
        self.btn = Button(text="clicked 0 times", size_hint_y=None, height=48)
        self.btn.bind(on_release=self.on_click)
        self.add_widget(self.btn)

    def on_click(self, *_):
        self.counter += 1
        self.btn.text = f"clicked {self.counter} times"


class CodeSageApp(App):
    def build(self):
        return Root()


if __name__ == "__main__":
    CodeSageApp().run()
`,
    "requirements.txt": `kivy==2.3.0
`,
    "buildozer.spec": `[app]
title = CodeSage App
package.name = codesageapp
package.domain = com.codesage
source.dir = .
source.include_exts = py,png,jpg,kv,atlas
version = 0.1.0
requirements = python3,kivy==2.3.0
orientation = portrait
fullscreen = 0
android.api = 33
android.minapi = 24
android.archs = arm64-v8a, armeabi-v7a
android.allow_backup = 1

[buildozer]
log_level = 2
warn_on_root = 0
`,
    ".gitignore": `.buildozer/
bin/
__pycache__/
*.pyc
*.log
.env
`,
    "README.md": `# CodeSage Kivy Android App

Created with the CodeSage Create Project wizard.

## Develop (desktop)

\`\`\`bash
pip install -r requirements.txt
python main.py
\`\`\`

## Build APK (CI)

Uses buildozer in GitHub Actions.
`,
  };
}

function workflowKivy() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - name: Install system deps
        run: |
          sudo apt-get update
          sudo apt-get install -y \\
            build-essential git zip unzip openjdk-17-jdk python3-pip \\
            autoconf libtool pkg-config zlib1g-dev libncurses5-dev \\
            libncursesw5-dev libtinfo5 cmake libffi-dev libssl-dev
      - name: Install buildozer
        run: pip install --upgrade buildozer cython==0.29.36
      - name: Build APK
        run: buildozer -v android debug
      - uses: actions/upload-artifact@v4
        with:
          name: apk
          path: bin/*.apk
          retention-days: 14
`;
}

// ----------------------------------------------------------------------------
// Electron scaffold + workflow (cross-platform desktop, download artifact)
// ----------------------------------------------------------------------------
function scaffoldElectron() {
  return {
    "package.json": JSON.stringify({
      name: "codesage-app",
      version: "0.1.0",
      description: "CodeSage Electron app",
      main: "main.js",
      private: true,
      scripts: {
        start: "electron .",
        dist: "electron-builder --publish=never",
      },
      devDependencies: {
        electron: "^32.1.2",
        "electron-builder": "^24.13.3",
      },
      build: {
        appId: "com.codesage.app",
        productName: "CodeSageApp",
        files: ["**/*", "!**/node_modules/*/{README.md,*.md,LICENSE,*.map}"],
        linux: { target: ["AppImage"], category: "Utility" },
        win: { target: ["portable"] },
        mac: { target: ["dmg"] },
      },
    }, null, 2),
    "main.js": `// Placeholder. Will be overwritten by CodeSage AI code generation.
const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: { contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
`,
    "index.html": `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>CodeSage App</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; text-align: center; }
    </style>
  </head>
  <body>
    <h1>CodeSage App</h1>
    <p>Waiting for AI-generated content...</p>
  </body>
</html>
`,
    ".gitignore": `node_modules
dist
*.log
.env
`,
    "README.md": `# CodeSage Electron App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
npm install
npm start
\`\`\`

## Package

\`\`\`bash
npm run dist
\`\`\`
`,
  };
}

function workflowElectron() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm install
      - run: npx electron-builder --linux AppImage --publish never
      - uses: actions/upload-artifact@v4
        with:
          name: desktop-build
          path: dist/*.AppImage
          retention-days: 14
`;
}

// ----------------------------------------------------------------------------
// Tauri scaffold + workflow (Rust + webview, download artifact)
// ----------------------------------------------------------------------------
function scaffoldTauri() {
  return {
    "package.json": JSON.stringify({
      name: "codesage-app",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        tauri: "tauri",
      },
      devDependencies: {
        "@tauri-apps/cli": "^2.0.4",
        vite: "^5.4.10",
      },
    }, null, 2),
    "vite.config.js": `import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist" },
});
`,
    "index.html": `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>CodeSage App</title>
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; padding: 32px; text-align: center;">
      <h1>CodeSage App</h1>
      <p>Waiting for AI-generated content...</p>
    </main>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    "src/main.js": `// Placeholder. Will be overwritten by CodeSage AI code generation.
console.log("CodeSage Tauri app loaded");
`,
    "src-tauri/Cargo.toml": `[package]
name = "codesage-app"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2.0", features = [] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
`,
    "src-tauri/build.rs": `fn main() {
    tauri_build::build()
}
`,
    "src-tauri/tauri.conf.json": JSON.stringify({
      $schema: "https://schema.tauri.app/config/2.0.0",
      productName: "CodeSageApp",
      version: "0.1.0",
      identifier: "com.codesage.app",
      build: {
        beforeBuildCommand: "npm run build",
        beforeDevCommand: "npm run dev",
        devUrl: "http://localhost:1420",
        frontendDist: "../dist",
      },
      app: {
        windows: [
          { title: "CodeSage App", width: 960, height: 640 },
        ],
        security: { csp: null },
      },
      bundle: {
        active: true,
        targets: ["appimage"],
        icon: ["icons/icon.png"],
      },
    }, null, 2),
    "src-tauri/src/main.rs": `// Placeholder. Will be overwritten by CodeSage AI code generation.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running CodeSage tauri app");
}
`,
    ".gitignore": `node_modules
dist
src-tauri/target
*.log
.env
`,
    "README.md": `# CodeSage Tauri App

Created with the CodeSage Create Project wizard.

## Develop

\`\`\`bash
npm install
npm run tauri dev
\`\`\`

## Build

\`\`\`bash
npm run tauri build
\`\`\`
`,
  };
}

function workflowTauri() {
  return `name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Tauri system deps
        run: |
          sudo apt-get update
          sudo apt-get install -y \\
            libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \\
            patchelf libgtk-3-dev libssl-dev build-essential curl wget file
      - run: npm install
      - run: npx tauri build --bundles appimage
      - uses: actions/upload-artifact@v4
        with:
          name: desktop-build
          path: src-tauri/target/release/bundle/appimage/*.AppImage
          retention-days: 14
`;
}

module.exports = {
  runCreatePipeline,
  enableAppetizePreview,
  getResumableRun,
  forgetRun,
  downloadArtifactZip,
  extractFirstFileWithExtension,
  FRAMEWORKS,
  APPETIZE_SECRET_KEY,
};
