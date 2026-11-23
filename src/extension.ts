import * as vscode from "vscode";

interface Environment {
    name: string;
    properties: Record<string, string>;
}

interface Service {
    name: string;
    id: string;
    body: string;
    range: vscode.Range;
}

interface Sequence {
    name: string;
    services: string[];
    range: vscode.Range;
}

interface NamedBlock {
    type: "env" | "service" | "sequence";
    name: string;
    openBrace: number;
    closeBrace: number;
}

interface ParsedBaw {
    environments: Environment[];
    services: Service[];
    sequences: Sequence[];
}

interface ServiceRunResult {
    serviceName: string;
    status: number;
    statusText: string;
    durationMs: number;
    response: unknown;
    responseText: string;
    requestUrl: string;
    requestBody: string;
}

let activeEnvironment = "";
let responsePanel: vscode.WebviewPanel | undefined;
let lastRun: ServiceRunResult | undefined;

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
const sharedVariables: Record<string, unknown> = {};

export function activate(context: vscode.ExtensionContext): void {
    const envStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    envStatusBar.command = "baw.setEnvironment";
    envStatusBar.tooltip = "Select the BAW environment";
    envStatusBar.text = `$(globe) BAW: ${activeEnvironment || "Select Env"}`;
    envStatusBar.show();

    context.subscriptions.push(envStatusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand("baw.setEnvironment", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isBawDocument(editor.document)) {
                vscode.window.showWarningMessage(
                    "Open a .baw file to select its environment."
                );
                return;
            }

            const parsed = parseBaw(editor.document.getText());
            if (parsed.environments.length === 0) {
                vscode.window.showWarningMessage(
                    "No environments found. Use: env dev { ... }"
                );
                return;
            }

            const selected = await vscode.window.showQuickPick(
                parsed.environments.map((env) => ({
                    label: env.name,
                    description: env.properties.url || ""
                })),
                { placeHolder: "Select BAW environment" }
            );

            if (!selected) {
                return;
            }

            activeEnvironment = selected.label;
            envStatusBar.text = `$(globe) BAW: ${activeEnvironment}`;

            if (lastRun) {
                lastRun = { ...lastRun };
            }
            updateResponsePanel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("baw.setSecret", async () => {
            const key = await vscode.window.showInputBox({
                prompt: "Secret name (for example BAW_PASSWORD)",
                placeHolder: "BAW_PASSWORD",
                ignoreFocusOut: true,
                validateInput: value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
                    ? undefined
                    : "Use letters, numbers and underscores; start with a letter or underscore."
            });
            if (!key) return;

            const value = await vscode.window.showInputBox({
                prompt: `Value for secret ${key}`,
                password: true,
                ignoreFocusOut: true
            });
            if (value === undefined) return;

            await context.secrets.store(`baw.secret.${key}`, value);
            vscode.window.showInformationMessage(`BAW secret "${key}" saved securely.`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("baw.deleteSecret", async () => {
            const key = await vscode.window.showInputBox({
                prompt: "Secret name to delete",
                placeHolder: "BAW_PASSWORD"
            });
            if (!key) return;
            await context.secrets.delete(`baw.secret.${key}`);
            vscode.window.showInformationMessage(`BAW secret "${key}" deleted.`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("baw.clearSharedVariables", () => {
            for (const key of Object.keys(sharedVariables)) {
                delete sharedVariables[key];
            }
            vscode.window.showInformationMessage(
                "BAW shared variables cleared."
            );
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: "baw", scheme: "file" },
            new BawCodeLensProvider()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "baw.runService",
            async (documentUri: vscode.Uri, serviceName: string) => {
                const document = await vscode.workspace.openTextDocument(documentUri);
                await runServiceFromDocument(document, serviceName, envStatusBar, context);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "baw.runSequence",
            async (documentUri: vscode.Uri, sequenceName: string) => {
                const document = await vscode.workspace.openTextDocument(documentUri);
                await runSequenceFromDocument(document, sequenceName, envStatusBar, context);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("baw.showResponse", () => {
            showResponsePanel(context);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (isBawDocument(event.document)) {
                vscode.commands.executeCommand(
                    "vscode.executeCodeLensProvider",
                    event.document.uri
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (isBawDocument(document)) {
                // Shared variables intentionally remain available for the
                // current extension session, even if the editor is closed.
            }
        })
    );

    // Keep the status bar label in sync when the active editor changes.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            envStatusBar.text = `$(globe) BAW: ${activeEnvironment || "Select Env"}`;
        })
    );
}

export function deactivate(): void {
    // Nothing to dispose manually; subscriptions are managed by VS Code.
}

class BawCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const parsed = parseBaw(document.getText());

        const serviceLenses = parsed.services.map((service) => {
            const position = new vscode.Position(Math.max(0, service.range.start.line), 0);
            return new vscode.CodeLens(new vscode.Range(position, position), {
                title: `$(play) Run Service: ${service.name}`,
                command: "baw.runService",
                arguments: [document.uri, service.name]
            });
        });
        const sequenceLenses = parsed.sequences.map((sequence) => {
            const position = new vscode.Position(Math.max(0, sequence.range.start.line), 0);
            return new vscode.CodeLens(new vscode.Range(position, position), {
                title: `$(play) Run Sequence: ${sequence.name} (${sequence.services.length} services)`,
                command: "baw.runSequence",
                arguments: [document.uri, sequence.name]
            });
        });
        return [...serviceLenses, ...sequenceLenses];
    }
}

function isBawDocument(document: vscode.TextDocument): boolean {
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
function findNamedBlocks(source: string): NamedBlock[] {
    const blocks: NamedBlock[] = [];
    const re = /^\s*(env|service|sequence)\s+([A-Za-z0-9_-]+|"[^"]+")\s*\{/gm;

    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const type = match[1] as "env" | "service" | "sequence";
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
function findMatchingBrace(source: string, openBrace: number): number {
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
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "#") {
            inComment = true;
        } else if (ch === "\"") {
            inString = true;
        } else if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

function parseBaw(source: string): ParsedBaw {
    const environments: Environment[] = [];
    const services: Service[] = [];
    const sequences: Sequence[] = [];
    const blocks = findNamedBlocks(source);

    for (const block of blocks) {
        const blockContent = source.slice(
            block.openBrace + 1,
            block.closeBrace
        );

        if (block.type === "env") {
            environments.push({
                name: block.name,
                properties: parseEnvironmentProperties(blockContent)
            });
        } else if (block.type === "sequence") {
            const runMatches = [...blockContent.matchAll(/^\s*run\s*:\s*("[^"]+"|[A-Za-z0-9_-]+)\s*$/gm)];
            const servicesInSequence = runMatches.map(match => match[1].replace(/^"|"$/g, ""));
            const start = new vscode.Position(source.slice(0, block.openBrace).split("\n").length - 1, 0);
            sequences.push({
                name: block.name,
                services: servicesInSequence,
                range: new vscode.Range(start, start)
            });
        } else {
            const idMatch = blockContent.match(
                /^\s*id\s*:\s*([^\r\n#]+)\s*$/m
            );
            const id = idMatch?.[1]?.trim();

            if (!id) {
                continue;
            }

            const body = extractServiceJson(blockContent);
            if (!body) {
                continue;
            }

            const startOffset = block.openBrace;
            const start = new vscode.Position(
                source.slice(0, startOffset).split("\n").length - 1,
                0
            );

            services.push({
                name: block.name,
                id,
                body,
                range: new vscode.Range(start, start)
            });
        }
    }

    return { environments, services, sequences };
}

function parseEnvironmentProperties(content: string): Record<string, string> {
    const properties: Record<string, string> = {};

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

function unquote(value: string): string {
    if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * Service blocks contain an id line followed by a JSON object.
 * The first opening brace after the id line starts the JSON body.
 */
function extractServiceJson(content: string): string | undefined {
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

async function runServiceFromDocument(
    document: vscode.TextDocument,
    serviceName: string,
    envStatusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext
): Promise<void> {
    const parsed = parseBaw(document.getText());
    const service = parsed.services.find((item) => item.name === serviceName);

    if (!service) {
        vscode.window.showErrorMessage(`Service not found: ${serviceName}`);
        return;
    }

    if (parsed.environments.length === 0) {
        vscode.window.showErrorMessage(
            "No environments found. Add an env block, for example: env dev { ... }"
        );
        return;
    }

    let environment = parsed.environments.find(
        (item) => item.name === activeEnvironment
    );

    if (!environment) {
        environment = parsed.environments[0];
        activeEnvironment = environment.name;
        envStatusBar.text = `$(globe) BAW: ${activeEnvironment}`;
    }

    try {
        const resolvedEnvironment = await resolveEnvironmentSecrets(environment, context.secrets);
        const result = await executeService(service, resolvedEnvironment);
        lastRun = result;
        storeServiceResponse(service.name, result.response);

        showResponsePanelForResult(result);
        vscode.window.showInformationMessage(
            `${service.name} completed (HTTP ${result.status}).`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `${service.name} failed: ${message}`
        );
    }
}

async function runSequenceFromDocument(
    document: vscode.TextDocument,
    sequenceName: string,
    envStatusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext
): Promise<void> {
    const parsed = parseBaw(document.getText());
    const sequence = parsed.sequences.find(item => item.name === sequenceName);
    if (!sequence) {
        vscode.window.showErrorMessage(`Sequence not found: ${sequenceName}`);
        return;
    }
    if (sequence.services.length === 0) {
        vscode.window.showWarningMessage(`Sequence "${sequenceName}" has no run entries.`);
        return;
    }
    let environment = parsed.environments.find(item => item.name === activeEnvironment) || parsed.environments[0];
    if (!environment) {
        vscode.window.showErrorMessage("No environments found in this .baw file.");
        return;
    }
    activeEnvironment = environment.name;
    envStatusBar.text = `$(globe) BAW: ${activeEnvironment}`;

    // Each run is awaited. A failed service stops the sequence; later services
    // are not attempted, and successful responses remain in sharedVariables.
    for (let index = 0; index < sequence.services.length; index++) {
        const serviceName = sequence.services[index];
        const service = parsed.services.find(item => item.name === serviceName);
        if (!service) {
            vscode.window.showErrorMessage(`Sequence "${sequenceName}": service "${serviceName}" was not found. Stopping.`);
            return;
        }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `BAW sequence: ${sequenceName}`,
                cancellable: false
            }, async progress => {
                progress.report({ message: `(${index + 1}/${sequence.services.length}) ${serviceName}` });
                const resolvedEnvironment = await resolveEnvironmentSecrets(environment!, context.secrets);
                const result = await executeService(service, resolvedEnvironment);
                lastRun = result;
                storeServiceResponse(service.name, result.response);
                showResponsePanelForResult(result);
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Sequence "${sequenceName}" stopped at "${serviceName}": ${message}`);
            return;
        }
    }
    vscode.window.showInformationMessage(`Sequence "${sequenceName}" completed (${sequence.services.length} services).`);
}

async function resolveEnvironmentSecrets(
    environment: Environment,
    secrets: vscode.SecretStorage
): Promise<Environment> {
    const properties: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(environment.properties)) {
        const match = rawValue.match(/^\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
        if (match) {
            const secretValue = await secrets.get(`baw.secret.${match[1]}`);
            if (secretValue === undefined) {
                const action = await vscode.window.showWarningMessage(
                    `Secret "${match[1]}" is not set.`,
                    "Set Secret"
                );
                if (action === "Set Secret") {
                    await vscode.commands.executeCommand("baw.setSecret");
                }
                throw new Error(`Missing secret: ${match[1]}. Run "BAW: Set Secret" and retry.`);
            }
            properties[key] = secretValue;
        } else {
            properties[key] = rawValue;
        }
    }
    return { name: environment.name, properties };
}

async function executeService(
    service: Service,
    environment: Environment
): Promise<ServiceRunResult> {
    const baseUrl = environment.properties.url;
    const username = environment.properties.username;
    const password = environment.properties.password;

    if (!baseUrl) {
        throw new Error(`Environment "${environment.name}" has no url property.`);
    }

    if (!username || !password) {
        throw new Error(
            `Environment "${environment.name}" must define username and password.`
        );
    }

    // Environment properties are available as {{variable}}.
    // Previously executed service results are available as {{Service Name.path}}.
    const resolvedBody = resolveVariables(service.body, environment.properties);
    let params: unknown;

    try {
        params = JSON.parse(resolvedBody);
    } catch (error) {
        throw new Error(
            `Invalid JSON after variable replacement: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    const encodedParams = encodeURIComponent(JSON.stringify(params));
    const serviceId = encodeURIComponent(service.id);
    const requestUrl =
        `${baseUrl.replace(/\/+$/, "")}/rest/bpm/wle/v1/service/` +
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

    let responseData: unknown = responseText;
    try {
        responseData = responseText ? JSON.parse(responseText) : null;
    } catch {
        // Keep non-JSON responses as text.
    }

    const result: ServiceRunResult = {
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
        throw new Error(
            `HTTP ${response.status} ${response.statusText}\n${responseText}`
        );
    }

    return result;
}

/**
 * Replaces:
 *   {{orderNumber}}                  environment variable
 *   {{Create Order.orderId}}         previous service response value
 *   {{Create Order.data.order.id}}   nested previous service response value
 * Secrets are referenced in environment properties as {{secret.SECRET_NAME}}
 * and are retrieved from VS Code SecretStorage (not from the .baw file).
 */
function resolveVariables(
    content: string,
    environmentVariables: Record<string, string>
): string {
    const variables: Record<string, unknown> = {
        ...environmentVariables,
        ...sharedVariables
    };

    return content.replace(
        /\{\{\s*([^{}]+?)\s*\}\}/g,
        (_match, expression: string) => {
            const value = resolveVariableExpression(
                expression.trim(),
                variables
            );

            if (value === undefined || value === null) {
                throw new Error(`Variable not found: {{${expression}}}`);
            }

            if (typeof value === "object") {
                return JSON.stringify(value);
            }

            return String(value);
        }
    );
}

function resolveVariableExpression(
    expression: string,
    variables: Record<string, unknown>
): unknown {
    // Match the longest known service name first. This permits service names
    // containing spaces, for example "Create Order.orderId".
    const rootNames = Object.keys(variables).sort(
        (a, b) => b.length - a.length
    );

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

function getNestedValue(value: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((current, part) => {
        if (current === null || current === undefined) {
            return undefined;
        }

        if (Array.isArray(current) && /^\d+$/.test(part)) {
            return current[Number(part)];
        }

        if (typeof current === "object") {
            return (current as Record<string, unknown>)[part];
        }

        return undefined;
    }, value);
}

function storeServiceResponse(
    serviceName: string,
    response: unknown
): void {
    sharedVariables[serviceName] = response;
}

function showResponsePanel(context: vscode.ExtensionContext): void {
    if (responsePanel) {
        responsePanel.reveal(vscode.ViewColumn.Beside);
        updateResponsePanel();
        return;
    }

    responsePanel = vscode.window.createWebviewPanel(
        "bawResponse",
        "BAW Response",
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    responsePanel.onDidDispose(() => {
        responsePanel = undefined;
    }, null, context.subscriptions);

    responsePanel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "clearVariables") {
            for (const key of Object.keys(sharedVariables)) {
                delete sharedVariables[key];
            }
            updateResponsePanel();
            vscode.window.showInformationMessage(
                "BAW shared variables cleared."
            );
        }
    }, undefined, context.subscriptions);

    updateResponsePanel();
}

function showResponsePanelForResult(result: ServiceRunResult): void {
    if (!responsePanel) {
        responsePanel = vscode.window.createWebviewPanel(
            "bawResponse",
            "BAW Response",
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        responsePanel.onDidDispose(() => {
            responsePanel = undefined;
        });
        responsePanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "clearVariables") {
                for (const key of Object.keys(sharedVariables)) {
                    delete sharedVariables[key];
                }
                updateResponsePanel();
                vscode.window.showInformationMessage(
                    "BAW shared variables cleared."
                );
            }
        });
    } else {
        responsePanel.reveal(vscode.ViewColumn.Beside);
    }

    responsePanel.webview.html = renderResponseHtml(result);
}

function updateResponsePanel(): void {
    if (!responsePanel) {
        return;
    }

    if (lastRun) {
        responsePanel.webview.html = renderResponseHtml(lastRun);
    } else {
        responsePanel.webview.html = renderEmptyResponseHtml();
    }
}

function renderEmptyResponseHtml(): string {
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

function renderResponseHtml(result: ServiceRunResult): string {
    const response = escapeHtml(
        typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2)
    );
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

function renderSharedVariablesHtml(): string {
    const entries = Object.entries(sharedVariables);

    if (entries.length === 0) {
        return "<p class=\"meta\">No shared variables yet. Run a service first.</p>";
    }

    return entries.map(([name, value]) => {
        const rendered = escapeHtml(JSON.stringify(value, null, 2));
        return `<h4>${escapeHtml(name)}</h4><pre>${rendered}</pre>`;
    }).join("");
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
