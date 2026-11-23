# BAW Service Runner

A starter VS Code extension for running IBM Business Automation Workflow service-start REST calls from `.baw` files.

## Example

```baw
env dev {
    url: https://baw-dev.example.com
    username: admin
    password: change-me
}

env test {
    url: https://baw-test.example.com
    username: admin
    password: change-me
}

service "Start Order" {
    id: OrderApp@StartOrder

    {
        "orderNumber": "1001",
        "customerName": "John"
    }
}
```

The extension adds a `▶ Run Service: ...` CodeLens above each service block. The response opens in a side-by-side editor with an environment selector and rerun button.

## Build and run

1. Install Node.js and VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Open this folder in VS Code.
5. Press `F5` to launch the Extension Development Host.
6. Open a `.baw` file and click **Run Service** above a service.

## Request behaviour

The extension sends:

`POST {url}/rest/bpm/wle/v1/service/{serviceId}?action=start&params={url-encoded-json}`

with HTTP Basic authentication.

## Security

This starter supports the requested inline `password` property for quick local testing. Do not commit real credentials or share `.baw` files containing passwords. A production-ready version should resolve passwords from VS Code SecretStorage or environment variables. It currently does not implement TLS certificate bypass, BPMCSRFToken handling, or cloud-specific authentication flows. Check your BAW deployment's authentication and CSRF requirements before using it.

## Current scope

- `.baw` language registration and basic syntax highlighting
- `env` and `service` records
- JSON input validation
- CodeLens run links
- Side-by-side response panel
- Environment switching and rerun
- HTTP status, duration, headers and formatted response
