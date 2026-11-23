import * as vscode from "vscode";

type Environment = {
  name: string;
  url: string;
  username: string;
  password: string;
};

type Service = {
  name: string;
  id: string;
  input: unknown;
};

type BawFile = {
  environments: Environment[];
  services: Service[];
};

let responsePanel: vscode.WebviewPanel | undefined;
let lastRun: { service: Service; environments: Environment[]; selectedEnv: string } | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "baw" }, {
      provideCodeLenses(document) {
        const parsed = parseBaw(document.getText());
        const lenses: vscode.CodeLens[] = [];
        for (const service of parsed.services) {
          const line = findServiceLine(document, service.name);
          if (line >= 0) {
            lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
              title: `▶ Run Service: ${service.name}`,
              command: "baw.runService",
              arguments: [document.uri, service.name]
            }));
          }
        }
        return lenses;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("baw.runService", async (uri?: vscode.Uri, serviceName?: string) => {
      const document = uri
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor?.document;

      if (!document || document.languageId !== "baw") {
        vscode.window.showErrorMessage("Open a .baw file first.");
        return;
      }

      try {
        const parsed = parseBaw(document.getText());
        const service = parsed.services.find(s => s.name === serviceName) ?? parsed.services[0];
        if (!service) throw new Error("No service records found in this .baw file.");
        if (!parsed.environments.length) throw new Error("No env records found in this .baw file.");

        const selected = lastRun?.selectedEnv && parsed.environments.some(e => e.name === lastRun.selectedEnv)
          ? lastRun.selectedEnv
          : parsed.environments[0].name;

        lastRun = { service, environments: parsed.environments, selectedEnv: selected };
        showResponsePanel(context, service, parsed.environments, selected);
        await executeService(service, parsed.environments.find(e => e.name === selected)!, selected);
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );
}

function parseBaw(source: string): BawFile {
  const environments: Environment[] = [];
  const services: Service[] = [];

  const blocks = findNamedBlocks(source);
  for (const block of blocks) {
    if (block.kind === "env") {
      const values = parseProperties(block.body);
      if (!values.url || !values.username || values.password === undefined) {
        throw new Error(`Environment "${block.name}" requires url, username and password.`);
      }
      environments.push({
        name: block.name,
        url: values.url.replace(/\/+$/, ""),
        username: values.username,
        password: values.password
      });
    } else {
      const id = block.body.match(/^\s*id\s*:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
      if (!id) throw new Error(`Service "${block.name}" is missing id:`);
      const jsonStart = block.body.indexOf("{");
      if (jsonStart < 0) throw new Error(`Service "${block.name}" is missing its JSON input block.`);
      const jsonEnd = findMatchingBrace(block.body, jsonStart);
      if (jsonEnd < 0) throw new Error(`Service "${block.name}" has an unclosed JSON input block.`);
      const jsonText = block.body.slice(jsonStart, jsonEnd + 1);
      let input: unknown;
      try { input = JSON.parse(jsonText); }
      catch (e) { throw new Error(`Invalid JSON in service "${block.name}": ${e instanceof Error ? e.message : String(e)}`); }
      services.push({ name: block.name, id, input });
    }
  }
  return { environments, services };
}

function findNamedBlocks(source: string): Array<{kind: "env" | "service"; name: string; body: string}> {
  const results: Array<{kind: "env" | "service"; name: string; body: string}> = [];
  const re = /\b(env|service)\s+"([^"]+)"\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const open = source.indexOf("{", match.index);
    const close = findMatchingBrace(source, open);
    if (close < 0) throw new Error(`Unclosed ${match[1]} block "${match[2]}".`);
    results.push({
      kind: match[1] as "env" | "service",
      name: match[2],
      body: source.slice(open + 1, close)
    });
    re.lastIndex = close + 1;
  }
  return results;
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseProperties(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(url|username|password)\s*:\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

function findServiceLine(document: vscode.TextDocument, name: string): number {
  for (let i = 0; i < document.lineCount; i++) {
    if (document.lineAt(i).text.includes(`service "${name}"`)) return i;
  }
  return -1;
}

function showResponsePanel(
  context: vscode.ExtensionContext,
  service: Service,
  environments: Environment[],
  selectedEnv: string
) {
  if (!responsePanel) {
    responsePanel = vscode.window.createWebviewPanel(
      "bawResponse",
      "BAW Response",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    responsePanel.onDidDispose(() => { responsePanel = undefined; });
    responsePanel.webview.onDidReceiveMessage(async message => {
      if (message.type === "run" && lastRun) {
        const env = lastRun.environments.find(e => e.name === message.environment);
        if (!env) return;
        lastRun.selectedEnv = env.name;
        await executeService(lastRun.service, env, env.name);
      }
      if (message.type === "copy") {
        await vscode.env.clipboard.writeText(String(message.text ?? ""));
        vscode.window.showInformationMessage("Response copied.");
      }
    });
  }
  responsePanel.title = `BAW: ${service.name}`;
  responsePanel.webview.html = getHtml(service, environments, selectedEnv);
}

async function executeService(service: Service, env: Environment, selectedEnv: string) {
  if (!responsePanel) return;
  const started = Date.now();
  responsePanel.webview.postMessage({ type: "running", environment: selectedEnv });

  const url = `${env.url}/rest/bpm/wle/v1/service/${encodeURIComponent(service.id)}`;
  const params = new URLSearchParams({
    action: "start",
    params: JSON.stringify(service.input)
  });

  try {
    const response = await fetch(`${url}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`${env.username}:${env.password}`).toString("base64")}`,
        "Accept": "application/json"
      }
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text response */ }

    responsePanel?.webview.postMessage({
      type: "result",
      status: response.status,
      statusText: response.statusText,
      duration: Date.now() - started,
      headers: Array.from(response.headers.entries()).map(([name, value]) => `${name}: ${value}`).join("\n"),
      body: JSON.stringify(body, null, 2),
      environment: selectedEnv
    });
  } catch (error) {
    responsePanel?.webview.postMessage({
      type: "error",
      duration: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
      environment: selectedEnv
    });
  }
}

function getHtml(service: Service, environments: Environment[], selected: string): string {
  const options = environments.map(e =>
    `<option value="${escapeHtml(e.name)}" ${e.name === selected ? "selected" : ""}>${escapeHtml(e.name)}</option>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>BAW Response</title>
<style>
:root { color-scheme: light dark; }
body { padding: 16px 22px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
.toolbar { display:flex; align-items:center; gap:12px; position:sticky; top:0; padding:10px 0; background:var(--vscode-editor-background); }
select, button { color:var(--vscode-foreground); background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border); padding:7px 10px; border-radius:4px; }
button { cursor:pointer; }
.meta { color:var(--vscode-descriptionForeground); margin:12px 0; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--vscode-textCodeBlock-background); padding:14px; border-radius:5px; }
#status { font-weight:600; }
</style>
</head>
<body>
<h2>${escapeHtml(service.name)}</h2>
<div class="toolbar">
  <label for="environment">Environment</label>
  <select id="environment">${options}</select>
  <button id="run">▶ Run Service</button>
  <button id="copy">Copy response</button>
</div>
<div class="meta" id="meta">Ready</div>
<div id="status"></div>
<h3>Response</h3>
<pre id="response">Run the service to see the response.</pre>
<h3>Response headers</h3>
<pre id="headers">—</pre>
<script>
const vscode = acquireVsCodeApi();
const env = document.getElementById('environment');
document.getElementById('run').addEventListener('click', () => vscode.postMessage({type:'run', environment:env.value}));
document.getElementById('copy').addEventListener('click', () => vscode.postMessage({type:'copy', text:document.getElementById('response').textContent}));
window.addEventListener('message', event => {
  const m = event.data;
  if (m.environment) env.value = m.environment;
  if (m.type === 'running') {
    document.getElementById('status').textContent = 'Running…';
    document.getElementById('meta').textContent = 'Executing against ' + m.environment;
  } else if (m.type === 'result') {
    document.getElementById('status').textContent = m.status + ' ' + m.statusText;
    document.getElementById('meta').textContent = m.duration + ' ms · ' + m.environment;
    document.getElementById('response').textContent = m.body;
    document.getElementById('headers').textContent = m.headers || '—';
  } else if (m.type === 'error') {
    document.getElementById('status').textContent = 'Request failed';
    document.getElementById('meta').textContent = m.duration + ' ms · ' + m.environment;
    document.getElementById('response').textContent = m.message;
    document.getElementById('headers').textContent = '—';
  }
});
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]!));
}

export function deactivate() {}
