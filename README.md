# cloud-harizafiq

A lightweight file hosting system built with Express and MinIO (S3-compatible storage).

It provides:
- a web UI for drag-and-drop uploads
- presigned upload/download URLs
- file listing with preview metadata
- file deletion

## Tech Stack

- Node.js + Express
- AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
- MinIO (or any S3-compatible endpoint)
- Plain HTML/CSS/JS frontend served from `public/index.html`

## Project Structure

- `index.js` - API server and static file host
- `public/index.html` - UI for upload/list/download/delete
- `.env.example` - required environment variables template

## Requirements

- Node.js 18+ recommended
- Running MinIO server (or compatible S3 service)
- A bucket already created in your storage backend

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Fill `.env` values:

```env
MINIO_ENDPOINT=http://localhost:9000
MINIO_PUBLIC_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=ACCESS_KEY
MINIO_SECRET_KEY=SECRET_KEY
BUCKET=bucket_name
```

## Environment Variables

- `MINIO_ENDPOINT`  
  Internal endpoint used by the Node server to sign requests.
- `MINIO_PUBLIC_ENDPOINT`  
  Public endpoint used by browser clients.  
  Useful when your MinIO is behind a reverse proxy/tunnel/domain.
- `MINIO_ACCESS_KEY`  
  Access key for S3/MinIO.
- `MINIO_SECRET_KEY`  
  Secret key for S3/MinIO.
- `BUCKET`  
  Bucket name where files are stored.

## Run Locally

```bash
npm start
```

Server starts at:

- `http://localhost:3000`

## API Endpoints

### `POST /generate-upload-url`

Generates a short-lived presigned URL for browser uploads.

Request body:

```json
{
  "filename": "example.png",
  "contentType": "image/png"
}
```

Response:

```json
{
  "uploadUrl": "https://...",
  "publicUrl": "https://.../bucket/example.png"
}
```

### `GET /generate-download-url?filename=<name>`

Generates a short-lived presigned URL for downloading a file.

### `GET /files`

Lists objects in the configured bucket.

### `DELETE /files/:filename`

Deletes a file from the bucket.

## How It Works

1. Browser asks backend for a presigned upload URL.
2. Backend signs against `MINIO_ENDPOINT`.
3. Backend rewrites URL host to `MINIO_PUBLIC_ENDPOINT` so browser can access it.
4. Browser uploads directly to MinIO (backend does not proxy file payloads).
5. UI fetches file list and renders previews/actions.

## Notes

- Presigned URLs currently expire in 5 minutes (`expiresIn: 300`).
- Filenames are used as object keys directly; uploading same name overwrites existing object.
- Make sure CORS is configured on MinIO bucket for browser uploads if needed.

## Security Recommendations

- Do not commit `.env` or credential files.
- Use least-privilege storage credentials.
- Prefer HTTPS for public endpoints.
- Consider file size limits and file type validation in production.

## Future Improvements

- Add authentication/authorization
- Add pagination for large buckets
- Add server-side validation and rate limiting
- Add tests and health checks

