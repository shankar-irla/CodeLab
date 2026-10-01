# Deploy the full CodeLab stack on Vercel

The root [`vercel.json`](../vercel.json) defines three Vercel Services. The editor and API receive public requests on the same domain; the Java runner stays internal and is called by the API through the `JAVA_RUNNER_URL` service binding. The Java runner starts one network-disabled Vercel Sandbox microVM for each run. Vercel Services and Container Registry are currently documented as beta products.

## 1. Build and push the Java sandbox image

The Vercel managed Sandbox images do not include a JDK. This repository includes an Ubuntu image with OpenJDK 21 at [`services/java-runner/sandbox-image/Dockerfile`](../services/java-runner/sandbox-image/Dockerfile).

Install Docker Desktop or another OCI builder, install the Vercel CLI, then run these commands from the CodeLab repository root:

```sh
vercel link
vercel vcr login docker
vercel vcr build docker services/java-runner/sandbox-image codelab-java:latest --push
```

Wait until the image is marked **Ready** in Vercel Container Registry. The runner defaults to `JAVA_SANDBOX_IMAGE=codelab-java:latest`, which resolves within the linked Vercel project. If you use a different registry repository or tag, set `JAVA_SANDBOX_IMAGE` in the Vercel project environment for the `java-runner` service.

## 2. Deploy the services

Import the CodeLab Git repository into Vercel and set the project root to the repository's `CodeLab` folder. Keep the Vercel project root at the repository root so it can read `vercel.json`, the npm workspace lockfile, and all three service roots. Deploy the project.

The route table sends `/api/*` to the FastAPI API and all other paths to the Vite web service. The web app already calls the relative `/api` path, so no cross-origin URL or `ALLOWED_ORIGINS` value is needed. The API service receives the runner base URL through Vercel's `JAVA_RUNNER_URL` binding; do not create that environment variable manually.

The runner selects `vercel-sandbox` mode on Vercel and uses Vercel's project OIDC credentials for Sandbox API calls. You can override its image with `JAVA_SANDBOX_IMAGE` as described above. The runner service has no public rewrite and remains internal.

## 3. Run locally using Vercel's service routing

Use a current Vercel CLI from the repository root. Link the project and pull the local Vercel environment so the Sandbox SDK can authenticate, then start the configured services:

```sh
vercel link
vercel env pull
vercel dev -L
```

Open the local URL printed by Vercel. The service binding is injected locally; the Java runtime still requires the pushed `codelab-java` image. For the normal local development workflow, use `npm run dev` and the installed JDK, or `npm run dev:sandbox` with Docker Desktop.

## Execution behavior and requirements

- Vercel requests execute synchronously through the API and runner functions. The local `npm run dev` flow retains its in-memory job queue and polling behavior.
- Each Vercel Java run creates a disposable microVM with one vCPU, 512 MB memory, denied outbound network access, and the requested run timeout. Standard input is written to a temporary file and passed to `System.in`; output is capped at 64 KB.
- Java execution on Vercel requires Vercel Sandbox access and a VCR image that is **Ready**. The Vercel SDK cannot run the existing Docker daemon-backed mode inside a Vercel Function.
- The Java runner registers the incoming `x-vercel-oidc-token` request headers with the Vercel Python SDK before making Sandbox API calls. The token is supplied by Vercel at runtime; do not copy it into project environment variables.
- Each visitor's files and input remain in that visitor's browser local storage. CodeLab does not provide accounts, shared projects, or cross-device sync.
- Public runs are anonymous and consume Sandbox resources. Configure suitable Vercel usage limits and add shared rate limiting before promoting the compiler to high-volume public use.

## Troubleshooting a deployed runner

Open `/api/runtime` on the deployed domain. It should return `"available": true` and the Java version. If it returns `"available": false`, check the Java runner's Vercel function logs and verify both of these deployment prerequisites:

1. Vercel Sandbox is enabled for the project and the deployment is receiving Vercel's OIDC request header.
2. `codelab-java:latest` (or the value configured as `JAVA_SANDBOX_IMAGE`) is **Ready** in the same Vercel project's Container Registry.

The editor now shows these checks in the runtime status and returns actionable runner errors instead of displaying an old execution result after the standard input changes. A static frontend deployment by itself cannot compile Java; the API, internal runner service, Vercel Sandbox access, and ready JDK image must all be present.

## Route and binding map

| Service | Public route | Calls |
| --- | --- | --- |
| `web` | `/` and remaining paths | Calls the API through same-origin `/api/*` requests |
| `api` | `/api/*` | Calls `java-runner` using the `JAVA_RUNNER_URL` binding |
| `java-runner` | Internal only | Creates isolated Vercel Sandbox jobs |
