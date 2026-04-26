# Deployment Guide

This documents the production deployment of cloud-harizafiq on a Windows PC with a dynamic public IP, served at `https://storage.harizafiq.com` via Cloudflare Tunnel.

---

## Architecture

```
Browser
  │  HTTPS
  ▼
Cloudflare Edge (handles TLS, no port forwarding needed)
  │
  │  Cloudflare Tunnel (outbound connection from this PC)
  ▼
cloudflared service (C:\Program Files (x86)\cloudflared\cloudflared.exe)
  │  config: C:\cloudflared\config.yml
  │
  ▼
Caddy (reverse proxy, port 80)
  │
  ├── /generate-upload-url*    ─┐
  ├── /generate-download-url*   ├─► Express app (port 3000)
  ├── /files*                  ─┘
  │
  └── /* (presigned URL paths) ──► MinIO Docker (port 9000)
```

**Why Cloudflare Tunnel?** The tunnel creates an outbound connection from this machine to Cloudflare's edge. No router port forwarding is needed, and the dynamic IP is irrelevant — traffic is routed through the tunnel regardless of the machine's IP.

Windows services at boot:

| Service | What it runs | Purpose |
|---|---|---|
| `cloudflared` | `cloudflared.exe tunnel --config C:\cloudflared\config.yml run` | Tunnel to Cloudflare |
| `CaddyProxy` | `C:\Caddy\caddy.exe` | Reverse proxy on port 80 |
| `CloudHarizafiq` | `node index.js` | Express API + frontend on port 3000 |

MinIO runs as a Docker container (`restart: unless-stopped`). Docker Desktop launches on user login.

---

## Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org/) installed
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed, set to launch on login
- MinIO Docker container running:
  ```bash
  docker run -d --name minio ^
    -p 9000:9000 -p 9001:9001 ^
    -e "MINIO_ROOT_USER=<access-key>" ^
    -e "MINIO_ROOT_PASSWORD=<secret-key>" ^
    -v C:\minio-data:/data ^
    minio/minio server /data --console-address ":9001"
  ```
- A Cloudflare account managing your domain
- A bucket already created in MinIO (admin console at `http://localhost:9001`)

---

## Step 1 — Configure environment variables

Copy `.env.example` to `.env`:

```env
MINIO_ENDPOINT=http://localhost:9000
MINIO_PUBLIC_ENDPOINT=https://storage.harizafiq.com
MINIO_ACCESS_KEY=your-access-key
MINIO_SECRET_KEY=your-secret-key
BUCKET=your-bucket-name
```

`MINIO_ENDPOINT` is used server-side for signing presigned URLs. `MINIO_PUBLIC_ENDPOINT` is the host rewritten into those URLs so the browser can reach MinIO through Caddy.

---

## Step 2 — Set MinIO container restart policy

```bash
docker update --restart unless-stopped minio
```

---

## Step 3 — Set up Cloudflare Tunnel

### Install cloudflared

```bash
winget install Cloudflare.cloudflared
```

### Authenticate

```bash
cloudflared tunnel login
```

A browser window opens — select your domain (`harizafiq.com`). This writes `cert.pem` to `C:\Users\{user}\.cloudflared\`.

### Create the tunnel

```bash
cloudflared tunnel create minio-tunnel
```

Note the tunnel ID from the output.

### Create `C:\cloudflared\config.yml`

```yaml
tunnel: <your-tunnel-id>
credentials-file: C:\Users\<your-user>\.cloudflared\<your-tunnel-id>.json

ingress:
  - hostname: cloud.harizafiq.com
    service: http://host.docker.internal:9000
  - hostname: storage.harizafiq.com
    service: http://localhost:80
  - service: http_status:404
```

`storage.harizafiq.com` routes to Caddy on port 80, which handles all routing internally. `cloud.harizafiq.com` routes directly to MinIO (legacy, kept for direct bucket access).

### Create the DNS records

```bash
cloudflared tunnel route dns minio-tunnel cloud.harizafiq.com
cloudflared tunnel route dns minio-tunnel storage.harizafiq.com
```

This creates CNAME records in Cloudflare pointing to the tunnel — no IP address management needed.

### Install cloudflared as a Windows service (elevated PowerShell)

```powershell
# Register the service
cloudflared service install

# Update ImagePath to include the config file
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared' `
  -Name ImagePath `
  -Value '"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --config "C:\cloudflared\config.yml" run'

Restart-Service cloudflared
```

Verify the tunnel is connected:

```bash
cloudflared tunnel info minio-tunnel
```

You should see active connections listed under `CONNECTOR ID`.

---

## Step 4 — Install Caddy

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

**Why `header_up Host localhost:9000`?** Presigned URLs are signed with `localhost:9000` as the host (because `MINIO_ENDPOINT` is `http://localhost:9000`). Without this rewrite, MinIO would receive `Host: storage.harizafiq.com` and reject the request because the host doesn't match the signature.

**Why no CORS configuration?** The browser page and all presigned URLs are both on `storage.harizafiq.com` (via the tunnel → Caddy → MinIO). Same origin — no preflight needed.

---

## Step 5 — Install NSSM and register Windows services

[NSSM](https://nssm.cc/) wraps any executable as a Windows service with auto-restart and log rotation.

Download and extract (no admin needed for this):

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

> `D:\cf-ddns\admin-setup.ps1` automates both service installs and can be re-run after a fresh Windows setup.

---

## Verification

```powershell
# Services should be Running
Get-Service cloudflared, CaddyProxy, CloudHarizafiq | Select-Object Name, Status, StartType

# Tunnel should show active connections
cloudflared tunnel info minio-tunnel

# Ports 80 and 3000 should be listening
netstat -ano | findstr ":80 "
netstat -ano | findstr ":3000 "

# MinIO container running with correct restart policy
docker inspect minio --format "{{.HostConfig.RestartPolicy.Name}}"

# End-to-end: should return 200
curl -o /dev/null -w "%{http_code}" https://storage.harizafiq.com/
```

---

## Day-to-day operations

### Restart after code changes

```powershell
Restart-Service CloudHarizafiq
```

### View logs

```powershell
# Express app
Get-Content D:\git-folder\cloud-harizafiq\logs\app-error.log -Tail 50

# Caddy
Get-Content C:\Caddy\logs\caddy-error.log -Tail 50

# Tunnel
Get-EventLog -LogName Application -Source "*cloudflared*" -Newest 20
```

### Stop / start all services

```powershell
Stop-Service cloudflared, CaddyProxy, CloudHarizafiq
Start-Service cloudflared, CaddyProxy, CloudHarizafiq
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

C:\cloudflared\
  config.yml                      Tunnel ingress rules

C:\Caddy\
  caddy.exe                       Caddy binary
  Caddyfile                       Reverse proxy routing config
  logs\                           Caddy logs

C:\nssm\
  nssm.exe                        Service manager binary

C:\Program Files (x86)\cloudflared\
  cloudflared.exe                 Cloudflared binary (installed via winget)

C:\Users\{user}\.cloudflared\
  cert.pem                        Cloudflare auth cert
  {tunnel-id}.json                Tunnel credentials
```
