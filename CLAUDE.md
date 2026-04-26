# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` - Install dependencies (Node.js 18+ required)
- `npm start` - Start the Express server on port 3000 (dev only; production runs as `CloudHarizafiq` Windows service)
- No linting, testing, or build commands currently configured

## Production Deployment (Windows — storage.harizafiq.com)

The app is deployed on Windows with three auto-start Windows services managed by NSSM (`C:\nssm\nssm.exe`):

| Service name | What it runs | Port |
|---|---|---|
| `CaddyProxy` | Caddy reverse proxy (`C:\Caddy\caddy.exe`) | 80 |
| `CloudHarizafiq` | This Express app (`node index.js`) | 3000 |
| `CloudflareDDNS` | DDNS loop (`node D:\cf-ddns\ddns-service.js`) | — |

MinIO runs as a Docker container (`docker ps` → `minio`, restart policy `unless-stopped`).

### Service management
```powershell
# View status
Get-Service CaddyProxy, CloudHarizafiq, CloudflareDDNS

# Restart after code changes
Restart-Service CloudHarizafiq

# View Express app logs
Get-Content D:\git-folder\cloud-harizafiq\logs\app.log -Tail 50
Get-Content D:\git-folder\cloud-harizafiq\logs\app-error.log -Tail 50
```

### Reverse proxy (Caddy)
Config: `C:\Caddy\Caddyfile`. Routes:
- `/generate-upload-url*`, `/generate-download-url*`, `/files*`, `/` → Express (`:3000`)
- Everything else (presigned URL paths like `/images/file.jpg?X-Amz-*`) → MinIO (`:9000`)

**Critical:** The MinIO reverse_proxy block sets `header_up Host localhost:9000`. Without this, MinIO rejects presigned URLs because the signature was computed against `localhost:9000` but Caddy would forward `Host: storage.harizafiq.com`.

### DNS / Dynamic IP
`D:\cf-ddns\ddns-service.js` — Node.js loop that updates `storage.harizafiq.com` in Cloudflare every 5 minutes. Uses `checkip.amazonaws.com` for IPv4 (machine also has IPv6; other services timed out or returned IPv6).

Cloudflare zone: `e1aefa20de42d8f71110b7d2934ff04b`
DNS record ID for `storage.harizafiq.com`: `d639f20ed6943e1e257609d215501c4c`

### Re-running admin setup
If services need to be reinstalled (e.g. after fresh Windows install), run as Administrator:
```powershell
D:\cf-ddns\admin-setup.ps1
```

## Architecture Overview

**cloud-harizafiq** is a lightweight S3-compatible file hosting system. It consists of:

### Backend (index.js, ~103 lines)
- Single Express server with 4 API endpoints
- Uses AWS SDK v3 to communicate with MinIO/S3-compatible storage
- Provides presigned URL generation for browser-based uploads and downloads
- Serves static frontend from `public/` directory
- All S3 operations use `forcePathStyle: true` for MinIO compatibility

### Frontend (public/index.html, ~463 lines)
- Single-page app: inline HTML + CSS + vanilla JavaScript
- Drag-and-drop file upload with XMLHttpRequest progress tracking
- File listing with auto-generated previews (images display thumbnails, other types get file icons)
- Actions per file: copy direct link, download via presigned URL, delete
- Toast notifications for user feedback

### Data Flow
1. Browser requests presigned upload URL from backend
2. Backend signs against `MINIO_ENDPOINT` (internal `http://localhost:9000`), rewrites host to `MINIO_PUBLIC_ENDPOINT` (`https://storage.harizafiq.com`) via `toPublicUrl()`
3. Browser uploads directly to MinIO via Caddy (no payload proxy through Express)
4. Browser fetches file list via `/files` endpoint
5. Frontend renders preview grid with action buttons

### Critical Implementation Details
- **URL Rewriting**: `toPublicUrl()` replaces the internal MinIO endpoint with the public endpoint in presigned URLs. Caddy then rewrites `Host` back to `localhost:9000` before forwarding to MinIO so the signature validates.
- **Presigned URL Expiration**: Hard-coded to 5 minutes (300 seconds) in both upload and download endpoints
- **No Authentication**: Currently no auth layer; all endpoints are public
- **Single Bucket Mode**: Operates on one bucket specified via environment variable
- **Same-origin uploads**: Both the UI and presigned URLs are on `storage.harizafiq.com`, so no CORS configuration is needed

## Environment Variables (required)

- `MINIO_ENDPOINT` - Internal endpoint for server-to-MinIO communication (`http://localhost:9000`)
- `MINIO_PUBLIC_ENDPOINT` - Public endpoint rewritten into presigned URLs (`https://storage.harizafiq.com`)
- `MINIO_ACCESS_KEY` - S3/MinIO access key
- `MINIO_SECRET_KEY` - S3/MinIO secret key
- `BUCKET` - Bucket name where files are stored (`images`)

See `.env.example` for template.

## API Endpoints

All endpoints are JSON-based:

- `POST /generate-upload-url` - Request: `{filename, contentType}` → Response: `{uploadUrl, publicUrl}`
- `GET /generate-download-url?filename=<name>` - Response: `{downloadUrl}`
- `GET /files` - Response: array of `{name, size, lastModified, url}`
- `DELETE /files/:filename` - Response: `{deleted: filename}`

## Known Constraints & Future Work

- File size limits not enforced (Cloudflare free plan caps at 100 MB per request)
- No pagination; `/files` lists all objects in bucket (can be slow on large buckets)
- No file type validation on upload
- Uploading the same filename overwrites the existing object
