# Deployment Guide

This documents the production deployment of cloud-harizafiq on a Windows PC with a dynamic public IP, served at `https://storage.harizafiq.com` via Cloudflare.

---

## Architecture

```
Browser
  │  HTTPS
  ▼
Cloudflare (proxied, handles TLS)
  │  HTTP :80
  ▼
Windows PC ── Caddy (reverse proxy, port 80)
                │
                ├── /generate-upload-url*    ─┐
                ├── /generate-download-url*   ├─► Express app (port 3000)
                ├── /files*                  ─┘
                │
                └── /* (presigned URL paths) ──► MinIO Docker (port 9000)
```

Three Windows services (managed by NSSM) run at boot:

| Service | Binary | Purpose |
|---|---|---|
| `CaddyProxy` | `C:\Caddy\caddy.exe` | Reverse proxy on port 80 |
| `CloudHarizafiq` | `node index.js` | Express API + frontend |
| `CloudflareDDNS` | `node D:\cf-ddns\ddns-service.js` | Updates DNS record every 5 min |

MinIO runs as a Docker container with `restart: unless-stopped`.

---

## Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org/) installed (confirms with `node --version`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and set to launch on login
- MinIO container already running:
  ```
  docker run -d --name minio \
    -p 9000:9000 -p 9001:9001 \
    -e MINIO_ROOT_USER=<access-key> \
    -e MINIO_ROOT_PASSWORD=<secret-key> \
    -v minio-data:/data \
    minio/minio server /data --console-address ":9001"
  ```
- A Cloudflare account managing your domain, with an API token that has `Zone:DNS:Edit` permission
- A bucket already created in MinIO

---

## Step 1 — Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```env
MINIO_ENDPOINT=http://localhost:9000
MINIO_PUBLIC_ENDPOINT=https://storage.harizafiq.com
MINIO_ACCESS_KEY=your-access-key
MINIO_SECRET_KEY=your-secret-key
BUCKET=your-bucket-name
```

`MINIO_ENDPOINT` is used server-side for signing. `MINIO_PUBLIC_ENDPOINT` is rewritten into the presigned URLs that the browser receives. They are different because MinIO is only reachable internally; the browser goes through Caddy → MinIO.

---

## Step 2 — Set MinIO container restart policy

So the container survives reboots (Docker Desktop auto-launches on user login):

```bash
docker update --restart unless-stopped minio
```

---

## Step 3 — Set up Cloudflare DNS

### Create the DNS record

Run `D:\cf-ddns\setup-dns.js` once. It:
1. Fetches your current public IPv4 from `checkip.amazonaws.com`
2. Creates an `A` record for `storage.harizafiq.com` (proxied / orange cloud)
3. Patches `update-ip.js` with the returned record ID

```bash
cd D:\cf-ddns
node --input-type=module < setup-dns.js
```

> **Note:** The script uses `checkip.amazonaws.com` rather than `ifconfig.me` or `api.ipify.org` because this machine has native IPv6 connectivity — other services either return the IPv6 address or time out when forced to IPv4.

### Cloudflare SSL mode

In Cloudflare → your domain → **SSL/TLS**, set the mode to **Flexible**. Cloudflare terminates HTTPS from the browser and connects to the origin over plain HTTP on port 80. The origin does not need a certificate.

---

## Step 4 — Set up the DDNS updater

`D:\cf-ddns\ddns-service.js` is a persistent Node.js loop that updates the DNS record every 5 minutes. It is registered as a Windows service (see Step 6) rather than a scheduled task because creating root-level scheduled tasks requires interactive admin access each time.

The script is self-contained — no `.env` file needed. It reads the Cloudflare API token, zone ID, and record ID directly from its constants.

---

## Step 5 — Install Caddy

Download the binary (no installer):

```powershell
New-Item -ItemType Directory -Force -Path C:\Caddy
Invoke-WebRequest -Uri "https://caddyserver.com/api/download?os=windows&arch=amd64" `
  -OutFile "C:\Caddy\caddy.exe" -UseBasicParsing
```

Create `C:\Caddy\Caddyfile`:

```caddy
:80 {
    # Express: UI and API endpoints
    handle /generate-upload-url* {
        reverse_proxy localhost:3000
    }
    handle /generate-download-url* {
        reverse_proxy localhost:3000
    }
    handle /files* {
        reverse_proxy localhost:3000
    }
    handle / {
        reverse_proxy localhost:3000
    }

    # MinIO: presigned URL paths (e.g. /images/filename?X-Amz-*)
    # Host header must match what was signed (localhost:9000)
    handle {
        reverse_proxy localhost:9000 {
            header_up Host localhost:9000
        }
    }
}
```

**Why the `header_up Host` directive?** Presigned URLs are signed with `localhost:9000` as the host (because `MINIO_ENDPOINT` is `http://localhost:9000`). When a browser sends the request to `storage.harizafiq.com`, Caddy would normally forward `Host: storage.harizafiq.com` to MinIO — but MinIO would reject it because the host doesn't match the signature. Setting `header_up Host localhost:9000` makes MinIO see the host it originally signed against.

**Why no CORS configuration?** The browser page is served from `storage.harizafiq.com` and all presigned URLs also resolve to `storage.harizafiq.com` (via Caddy → MinIO). Same origin — no preflight needed.

---

## Step 6 — Install NSSM and register Windows services

[NSSM](https://nssm.cc/) (Non-Sucking Service Manager) wraps any executable as a Windows service with auto-restart.

Download and extract:

```powershell
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" `
  -OutFile "$env:TEMP\nssm.zip" -UseBasicParsing
Expand-Archive "$env:TEMP\nssm.zip" "$env:TEMP\nssm-extract" -Force
New-Item -ItemType Directory -Force -Path C:\nssm
Copy-Item "$env:TEMP\nssm-extract\nssm-2.24\win64\nssm.exe" C:\nssm\nssm.exe
```

Run the commands below **in an elevated (Administrator) PowerShell**:

### Caddy service

```powershell
nssm install CaddyProxy C:\Caddy\caddy.exe
nssm set CaddyProxy AppParameters "run --config C:\Caddy\Caddyfile"
nssm set CaddyProxy AppDirectory C:\Caddy
nssm set CaddyProxy DisplayName "Caddy Reverse Proxy"
nssm set CaddyProxy Start SERVICE_AUTO_START
nssm set CaddyProxy AppStdout C:\Caddy\logs\caddy.log
nssm set CaddyProxy AppStderr C:\Caddy\logs\caddy-error.log
nssm set CaddyProxy AppRotateFiles 1
nssm set CaddyProxy AppRotateBytes 5000000
New-Item -ItemType Directory -Force C:\Caddy\logs
Start-Service CaddyProxy
```

### Express app service

```powershell
$node = "C:\Program Files\nodejs\node.exe"
$app  = "D:\git-folder\cloud-harizafiq"

nssm install CloudHarizafiq $node
nssm set CloudHarizafiq AppParameters "index.js"
nssm set CloudHarizafiq AppDirectory $app
nssm set CloudHarizafiq DisplayName "cloud-harizafiq Node App"
nssm set CloudHarizafiq Start SERVICE_AUTO_START
nssm set CloudHarizafiq AppStdout "$app\logs\app.log"
nssm set CloudHarizafiq AppStderr "$app\logs\app-error.log"
nssm set CloudHarizafiq AppRotateFiles 1
nssm set CloudHarizafiq AppRotateBytes 5000000
New-Item -ItemType Directory -Force "$app\logs"
Start-Service CloudHarizafiq
```

### DDNS service

```powershell
$node = "C:\Program Files\nodejs\node.exe"

nssm install CloudflareDDNS $node
nssm set CloudflareDDNS AppParameters "D:\cf-ddns\ddns-service.js"
nssm set CloudflareDDNS AppDirectory D:\cf-ddns
nssm set CloudflareDDNS DisplayName "Cloudflare DDNS Updater"
nssm set CloudflareDDNS Start SERVICE_AUTO_START
nssm set CloudflareDDNS AppStdout D:\cf-ddns\logs\ddns.log
nssm set CloudflareDDNS AppStderr D:\cf-ddns\logs\ddns-error.log
nssm set CloudflareDDNS AppRotateFiles 1
nssm set CloudflareDDNS AppRotateBytes 2000000
New-Item -ItemType Directory -Force D:\cf-ddns\logs
Start-Service CloudflareDDNS
```

> An `admin-setup.ps1` script at `D:\cf-ddns\admin-setup.ps1` automates all three service installs and can be re-run if services need to be reinstalled after a fresh Windows setup.

---

## Step 7 — Open Windows Firewall port 80

In an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Caddy HTTP Inbound" `
  -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
```

---

## Step 8 — Forward port 80 on your router

Log into your router admin panel and add a port forwarding rule:

| Field | Value |
|---|---|
| External port | 80 |
| Internal IP | This machine's local IP (`ipconfig` to find it) |
| Internal port | 80 |
| Protocol | TCP |

---

## Verification

After all steps are complete:

```powershell
# All three services should be Running / Automatic
Get-Service CaddyProxy, CloudHarizafiq, CloudflareDDNS | Select Name, Status, StartType

# Port 80 and 3000 should be listening
netstat -ano | findstr ":80 "
netstat -ano | findstr ":3000 "

# DDNS log should show successful updates
Get-Content D:\cf-ddns\logs\ddns.log -Tail 5

# MinIO container running with correct restart policy
docker inspect minio --format "{{.HostConfig.RestartPolicy.Name}}"
```

Then open `https://storage.harizafiq.com` in a browser — you should see the file upload UI.

---

## Day-to-day operations

### Restarting after code changes

```powershell
Restart-Service CloudHarizafiq
```

### Viewing logs

```powershell
# Express app
Get-Content D:\git-folder\cloud-harizafiq\logs\app-error.log -Tail 50

# Caddy
Get-Content C:\Caddy\logs\caddy-error.log -Tail 50

# DDNS
Get-Content D:\cf-ddns\logs\ddns.log -Tail 20
```

### Stopping / starting services

```powershell
Stop-Service CaddyProxy, CloudHarizafiq, CloudflareDDNS
Start-Service CaddyProxy, CloudHarizafiq, CloudflareDDNS
```

### Checking the current public IP

```powershell
(Invoke-WebRequest https://checkip.amazonaws.com -UseBasicParsing).Content.Trim()
```

---

## File map

```
D:\git-folder\cloud-harizafiq\   ← this repo
  index.js                        Express app entry point
  .env                            Runtime config (gitignored)
  .env.example                    Config template
  public\index.html               Frontend SPA
  DEPLOYMENT.md                   This file
  CLAUDE.md                       AI assistant context
  logs\                           App logs (gitignored)

C:\Caddy\
  caddy.exe                       Caddy binary
  Caddyfile                       Reverse proxy config
  logs\                           Caddy logs

D:\cf-ddns\
  ddns-service.js                 Persistent DDNS loop (registered as service)
  update-ip.js                    One-shot DDNS updater (manual use / testing)
  setup-dns.js                    One-time script: creates CF record, patches update-ip.js
  run-ddns.bat                    Wrapper bat (legacy, kept for reference)
  admin-setup.ps1                 Full service install script (run as admin)
  logs\                           DDNS logs

C:\nssm\
  nssm.exe                        Service manager binary
```
