"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
let activeEnvironment = "";
let responsePanel;
let lastRun;
/**
 * Values returned by previously executed services.
 *
 * Example:
 * sharedVariables["Create Order"] = {
 *   orderId: "ORD-1001"
 * };
 *
 * Then a later service can use {{Create Order.orderId}}.
 */
const sharedVariables = {};
function activate(context) {
    const envStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    envStatusBar.command = "baw.setEnvironment";
    envStatusBar.tooltip = "Select the BAW environment";
    envStatusBar.text = `$(globe) BAW: ${activeEnvironment || "Select Env"}`;
    envStatusBar.show();
    context.subscriptions.push(envStatusBar);
    context.subscriptions.push(vscode.commands.registerCommand("baw.setEnvironment", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isBawDocument(editor.document)) {
            vscode.window.showWarningMessage("Open a .baw file to select its environment.");
            return;
        }
        const parsed = parseBaw(editor.document.getText());
        if (parsed.environments.length === 0) {
            vscode.window.showWarningMessage("No environments found. Use: env dev { ... }");
            return;
        }
        const selected = await vscode.window.showQuickPick(parsed.environments.map((env) => ({
            label: env.name,
            description: env.properties.url || ""
        })), { placeHolder: "Select BAW environment" });
        if (!selected) {
            return;
        }
        activeEnvironment = selected.label;
        envStatusBar.text = `$(globe) BAW: ${activeEnvironment}`;
        if (lastRun) {
            lastRun = { ...lastRun };
        }
        updateResponsePanel();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("baw.clearSharedVariables", () => {
        for (const key of Object.keys(sharedVariables)) {
            delete sharedVariables[key];
        }
        vscode.window.showInformationMessage("BAW shared variables cleared.");
    }));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "baw", scheme: "file" }, new BawCodeLensProvider()));
    context.subscriptions.push(vscode.commands.registerCommand("baw.runService", async (documentUri, serviceName) => {
        const document = await vscode.workspace.openTextDocument(documentUri);
        await runServiceFromDocument(document, serviceName, envStatusBar);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("baw.showResponse", () => {
        showResponsePanel(context);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        if (isBawDocument(event.document)) {
            vscode.commands.executeCommand("vscode.executeCodeLensProvider", event.document.uri);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
        if (isBawDocument(document)) {
            // Shared variables intentionally remain available for the
            // current extension session, even if the editor is closed.
        }
    }));
    // Keep the status bar label in sync when the active editor changes.
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        envStatusBar.text = `$(globe) BAW: ${activeEnvironment || "Select Env"}`;
    }));
}
function deactivate() {
    // Nothing to dispose manually; subscriptions are managed by VS Code.
}
class BawCodeLensProvider {
    provideCodeLenses(document) {
        const parsed = parseBaw(document.getText());
        return parsed.services.map((service) => {
            const position = new vscode.Position(Math.max(0, service.range.start.line), 0);
            return new vscode.CodeLens(new vscode.Range(position, position), {
                title: `$(play) Run Service: ${service.name}`,
                command: "baw.runService",
                arguments: [document.uri, service.name]
            });
        });
    }
}
function isBawDocument(document) {
    return document.languageId === "baw" ||
        document.fileName.toLowerCase().endsWith(".baw");
}
/**
 * Finds env/service blocks. Environment names can be unquoted:
 *   env dev {
 *
 * Service names can be quoted:
 *   service "Create Order" {
 */
function findNamedBlocks(source) {
    const blocks = [];
    const re = /^\s*(env|service)\s+([A-Za-z0-9_-]+|"[^"]+")\s*\{/gm;
    let match;
    while ((match = re.exec(source)) !== null) {
        const type = match[1];
        const rawName = match[2];
        const name = rawName.replace(/^"|"$/g, "");
        const openBrace = re.lastIndex - 1;
        const closeBrace = findMatchingBrace(source, openBrace);
        if (closeBrace < 0) {
            continue;
        }
        blocks.push({ type, name, openBrace, closeBrace });
        re.lastIndex = openBrace + 1;
    }
    return blocks;
}
/**
 * Finds the matching closing brace while ignoring braces inside strings
 * and # comments.
 */
function findMatchingBrace(source, openBrace) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let inComment = false;
    for (let i = openBrace; i < source.length; i++) {
        const ch = source[i];
        if (inComment) {
            if (ch === "\n") {
                inComment = false;
            }
            continue;
        }
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (ch === "\\") {
                escaped = true;
            }
            else if (ch === "\"") {
                inString = false;
            }
            continue;
        }
        if (ch === "#") {
            inComment = true;
        }
        else if (ch === "\"") {
            inString = true;
        }
        else if (ch === "{") {
            depth++;
        }
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}
function parseBaw(source) {
    const environments = [];
    const services = [];
    const blocks = findNamedBlocks(source);
    for (const block of blocks) {
        const blockContent = source.slice(block.openBrace + 1, block.closeBrace);
        if (block.type === "env") {
            environments.push({
                name: block.name,
                properties: parseEnvironmentProperties(blockContent)
            });
        }
        else {
            const idMatch = blockContent.match(/^\s*id\s*:\s*([^\r\n#]+)\s*$/m);
            const id = idMatch?.[1]?.trim();
            if (!id) {
                continue;
            }
            const body = extractServiceJson(blockContent);
            if (!body) {
                continue;
            }
            const startOffset = block.openBrace;
            const start = new vscode.Position(source.slice(0, startOffset).split("\n").length - 1, 0);
            services.push({
                name: block.name,
                id,
                body,
                range: new vscode.Range(start, start)
            });
        }
    }
    return { environments, services };
}
function parseEnvironmentProperties(content) {
    const properties = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const match = trimmed.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/);
        if (match) {
            properties[match[1]] = unquote(match[2]);
        }
    }
    return properties;
}
function unquote(value) {
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
/**
 * Service blocks contain an id line followed by a JSON object.
 * The first opening brace after the id line starts the JSON body.
 */
function extractServiceJson(content) {
    const idMatch = /^\s*id\s*:\s*[^\r\n#]+\s*$/m.exec(content);
    if (!idMatch) {
        return undefined;
    }
    const afterId = content.slice(idMatch.index + idMatch[0].length);
    const jsonOpenRelative = afterId.indexOf("{");
    if (jsonOpenRelative < 0) {
        return undefined;
    }
    const jsonOpen = idMatch.index + idMatch[0].length + jsonOpenRelative;
    const jsonClose = findMatchingBrace(content, jsonOpen);
    if (jsonClose < 0) {
        return undefined;
    }
    return content.slice(jsonOpen, jsonClose + 1).trim();
}
async function runServiceFromDocument(document, serviceName, envStatusBar) {
    const parsed = parseBaw(document.getText());
    const service = parsed.services.find((item) => item.name === serviceName);
    if (!service) {
        vscode.window.showErrorMessage(`Service not found: ${serviceName}`);
        return;
    }
    if (parsed.environments.length === 0) {
        vscode.window.showErrorMessage("No environments found. Add an env block, for example: env dev { ... }");
        return;
    }
    let environment = parsed.environments.find((item) => item.name === activeEnvironment);
    if (!environment) {
        environment = parsed.environments[0];
        activeEnvironment = environment.name;
        envStatusBar.text = `$(globe) BAW: ${activeEnvironment}`;
    }
    try {
        const result = await executeService(service, environment);
        lastRun = result;
        storeServiceResponse(service.name, result.response);
        showResponsePanelForResult(result);
        vscode.window.showInformationMessage(`${service.name} completed (HTTP ${result.status}).`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${service.name} failed: ${message}`);
    }
}
async function executeService(service, environment) {
    const baseUrl = environment.properties.url;
    const username = environment.properties.username;
    const password = environment.properties.password;
    if (!baseUrl) {
        throw new Error(`Environment "${environment.name}" has no url property.`);
    }
    if (!username || !password) {
        throw new Error(`Environment "${environment.name}" must define username and password.`);
    }
    // Environment properties are available as {{variable}}.
    // Previously executed service results are available as {{Service Name.path}}.
    const resolvedBody = resolveVariables(service.body, environment.properties);
    let params;
    try {
        params = JSON.parse(resolvedBody);
    }
    catch (error) {
        throw new Error(`Invalid JSON after variable replacement: ${error instanceof Error ? error.message : String(error)}`);
    }
    const encodedParams = encodeURIComponent(JSON.stringify(params));
    const serviceId = encodeURIComponent(service.id);
    const requestUrl = `${baseUrl.replace(/\/+$/, "")}/rest/bpm/wle/v1/service/` +
        `${serviceId}?action=start&params=${encodedParams}`;
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const startedAt = Date.now();
    const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json"
        }
    });
    const responseText = await response.text();
    const durationMs = Date.now() - startedAt;
    let responseData = responseText;
    try {
        responseData = responseText ? JSON.parse(responseText) : null;
    }
    catch {
        // Keep non-JSON responses as text.
    }
    const result = {
        serviceName: service.name,
        status: response.status,
        statusText: response.statusText,
        durationMs,
        response: responseData,
        responseText,
        requestUrl,
        requestBody: JSON.stringify(params, null, 2)
    };
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}\n${responseText}`);
    }
    return result;
}
/**
 * Replaces:
 *   {{orderNumber}}                  environment variable
 *   {{Create Order.orderId}}         previous service response value
 *   {{Create Order.data.order.id}}   nested previous service response value
 */
function resolveVariables(content, environmentVariables) {
    const variables = {
        ...environmentVariables,
        ...sharedVariables
    };
    return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expression) => {
        const value = resolveVariableExpression(expression.trim(), variables);
        if (value === undefined || value === null) {
            throw new Error(`Variable not found: {{${expression}}}`);
        }
        if (typeof value === "object") {
            return JSON.stringify(value);
        }
        return String(value);
    });
}
function resolveVariableExpression(expression, variables) {
    // Match the longest known service name first. This permits service names
    // containing spaces, for example "Create Order.orderId".
    const rootNames = Object.keys(variables).sort((a, b) => b.length - a.length);
    for (const rootName of rootNames) {
        if (expression === rootName) {
            return variables[rootName];
        }
        if (expression.startsWith(`${rootName}.`)) {
            const path = expression.slice(rootName.length + 1);
            return getNestedValue(variables[rootName], path);
        }
    }
    // Simple environment variable such as {{orderNumber}}.
    if (Object.prototype.hasOwnProperty.call(variables, expression)) {
        return variables[expression];
    }
    // Fallback: split at the first dot. This is useful if a response has
    // been stored under a service name that is not otherwise an exact prefix.
    const firstDot = expression.indexOf(".");
    if (firstDot > 0) {
        const root = expression.slice(0, firstDot);
        const path = expression.slice(firstDot + 1);
        return getNestedValue(variables[root], path);
    }
    return undefined;
}
function getNestedValue(value, path) {
    return path.split(".").reduce((current, part) => {
        if (current === null || current === undefined) {
            return undefined;
        }
        if (Array.isArray(current) && /^\d+$/.test(part)) {
            return current[Number(part)];
        }
        if (typeof current === "object") {
            return current[part];
        }
        return undefined;
    }, value);
}
function storeServiceResponse(serviceName, response) {
    sharedVariables[serviceName] = response;
}
function showResponsePanel(context) {
    if (responsePanel) {
        responsePanel.reveal(vscode.ViewColumn.Beside);
        updateResponsePanel();
        return;
    }
    responsePanel = vscode.window.createWebviewPanel("bawResponse", "BAW Response", vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true
    });
    responsePanel.onDidDispose(() => {
        responsePanel = undefined;
    }, null, context.subscriptions);
    responsePanel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "clearVariables") {
            for (const key of Object.keys(sharedVariables)) {
                delete sharedVariables[key];
            }
            updateResponsePanel();
            vscode.window.showInformationMessage("BAW shared variables cleared.");
        }
    }, undefined, context.subscriptions);
    updateResponsePanel();
}
function showResponsePanelForResult(result) {
    if (!responsePanel) {
        responsePanel = vscode.window.createWebviewPanel("bawResponse", "BAW Response", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        responsePanel.onDidDispose(() => {
            responsePanel = undefined;
        });
        responsePanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "clearVariables") {
                for (const key of Object.keys(sharedVariables)) {
                    delete sharedVariables[key];
                }
                updateResponsePanel();
                vscode.window.showInformationMessage("BAW shared variables cleared.");
            }
        });
    }
    else {
        responsePanel.reveal(vscode.ViewColumn.Beside);
    }
    responsePanel.webview.html = renderResponseHtml(result);
}
function updateResponsePanel() {
    if (!responsePanel) {
        return;
    }
    if (lastRun) {
        responsePanel.webview.html = renderResponseHtml(lastRun);
    }
    else {
        responsePanel.webview.html = renderEmptyResponseHtml();
    }
}
function renderEmptyResponseHtml() {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
pre { white-space: pre-wrap; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 12px; cursor: pointer; }
</style>
</head>
<body>
<h2>BAW Service Runner</h2>
<p>Run a service using the <b>Run Service</b> CodeLens to see its response here.</p>
<h3>Shared variables</h3>
${renderSharedVariablesHtml()}
<button onclick="vscode.postMessage({command:'clearVariables'})">Clear shared variables</button>
<script>
const vscode = acquireVsCodeApi();
</script>
</body>
</html>`;
}
function renderResponseHtml(result) {
    const response = escapeHtml(typeof result.response === "string"
        ? result.response
        : JSON.stringify(result.response, null, 2));
    const requestBody = escapeHtml(result.requestBody);
    const variablesHtml = renderSharedVariablesHtml();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
.meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; }
h2, h3 { margin-bottom: 8px; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 12px; cursor: pointer; }
.success { color: var(--vscode-testing-iconPassed); }
.failure { color: var(--vscode-testing-iconFailed); }
</style>
</head>
<body>
<h2>${escapeHtml(result.serviceName)}</h2>
<p class="meta">
<span class="${result.status >= 200 && result.status < 300 ? "success" : "failure"}">
HTTP ${result.status} ${escapeHtml(result.statusText)}
</span>
&nbsp; · &nbsp; ${result.durationMs} ms
</p>
<h3>Request URL</h3>
<pre>${escapeHtml(result.requestUrl)}</pre>
<h3>Request parameters</h3>
<pre>${requestBody}</pre>
<h3>Response</h3>
<pre>${response}</pre>
<h3>Shared variables</h3>
${variablesHtml}
<button onclick="vscode.postMessage({command:'clearVariables'})">Clear shared variables</button>
<script>
const vscode = acquireVsCodeApi();
</script>
</body>
</html>`;
}
function renderSharedVariablesHtml() {
    const entries = Object.entries(sharedVariables);
    if (entries.length === 0) {
        return "<p class=\"meta\">No shared variables yet. Run a service first.</p>";
    }
    return entries.map(([name, value]) => {
        const rendered = escapeHtml(JSON.stringify(value, null, 2));
        return `<h4>${escapeHtml(name)}</h4><pre>${rendered}</pre>`;
    }).join("");
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
//# sourceMappingURL=extension.js.map