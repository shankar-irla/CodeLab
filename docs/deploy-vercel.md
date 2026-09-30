# Public deployment: Vercel and a Docker host

Vercel can host the CodeLab editor. Java execution still needs a Linux host with Docker Engine: the runner creates a separate, network-disabled container for each submitted program. The deployment files in this repository keep that boundary and expose only the API through HTTPS.

## 1. Start the Java API host

Use a Linux VM with a public IP, Docker Engine and the Docker Compose plugin. Point a DNS name such as api.example.com to the VM. Allow inbound TCP ports 80 and 443; keep ports 8000 and 8100 private.

From the CodeLab folder on the VM:

1. Copy .env.server.example to .env.
2. Set API_DOMAIN to the DNS name and ALLOWED_ORIGINS to the Vercel production origin. Add a custom frontend domain as a comma-separated second origin if needed.
3. Start the services:

```sh
docker compose -f docker-compose.server.yml up -d --build
```

Caddy obtains and renews the HTTPS certificate. Confirm the API is ready at https://api.example.com/api/runtime.

## 2. Deploy the editor to Vercel

Import the repository into Vercel and use the CodeLab folder as the project root. The included vercel.json builds the Vite app from the npm workspace and serves its SPA routes.

Set this Vercel environment variable for Production (and Preview if you want preview deployments to run code):

```text
VITE_API_BASE_URL=https://api.example.com/api
```

Deploy or redeploy the frontend. The browser sends execution requests to the public API over HTTPS; FastAPI permits browser requests only from the origins in ALLOWED_ORIGINS.

## Capacity notes

The API keeps short-lived run jobs in memory, so run exactly one API replica with this version. The runner allows a small bounded queue and runs Java with container CPU, memory, process, timeout, and network limits. For sustained public traffic, add durable shared job storage, per-user/IP rate limits, monitoring, and worker autoscaling before increasing capacity.

Vercel can also run untrusted code with its Sandbox product, but this project currently uses the Docker API directly. A Vercel-only deployment therefore needs a separate runner integration; the deployment prepared here keeps the existing isolated runner on a Linux Docker host.

Each visitor gets an independent workspace saved in that browser's local storage. The public editor does not require a login; work is not synced between devices or shared between visitors.
