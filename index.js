import express from "express";
import dotenv from "dotenv";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

const REQUIRED_ENV = ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "BUCKET", "MINIO_PUBLIC_ENDPOINT"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: process.env.MINIO_ENDPOINT,        // localhost:9000 — direct, no tunnel
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

// Presigned URLs are signed against localhost but clients need the public domain.
function toPublicUrl(url) {
  return url.replace(process.env.MINIO_ENDPOINT, process.env.MINIO_PUBLIC_ENDPOINT);
}

app.post("/generate-upload-url", async (req, res) => {
  const { filename, contentType } = req.body;

  if (!filename) return res.status(400).json({ error: "filename is required" });

  const command = new PutObjectCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
    ContentType: contentType || "application/octet-stream",
  });

  const uploadUrl = toPublicUrl(await getSignedUrl(s3, command, { expiresIn: 300 }));

  res.json({
    uploadUrl,
    publicUrl: `${process.env.MINIO_PUBLIC_ENDPOINT}/${process.env.BUCKET}/${filename}`,
  });
});

app.get("/generate-download-url", async (req, res) => {
  const { filename } = req.query;

  if (!filename) return res.status(400).json({ error: "filename is required" });

  const command = new GetObjectCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
  });

  const downloadUrl = toPublicUrl(await getSignedUrl(s3, command, { expiresIn: 300 }));
  res.json({ downloadUrl });
});

app.get("/files", async (req, res) => {
  const command = new ListObjectsV2Command({
    Bucket: process.env.BUCKET,
  });

  const data = await s3.send(command);
  const files = (data.Contents || []).map((obj) => ({
    name: obj.Key,
    size: obj.Size,
    lastModified: obj.LastModified,
    url: `${process.env.MINIO_PUBLIC_ENDPOINT}/${process.env.BUCKET}/${obj.Key}`,
  }));

  res.json(files);
});

app.delete("/files/:filename", async (req, res) => {
  const { filename } = req.params;

  const command = new DeleteObjectCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
  });

  await s3.send(command);
  res.json({ deleted: filename });
});

app.post("/create-multipart-upload", async (req, res) => {
  const { filename, contentType } = req.body;
  if (!filename) return res.status(400).json({ error: "filename is required" });
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
    ContentType: contentType || "application/octet-stream",
  }));
  res.json({ uploadId: UploadId });
});

app.get("/generate-part-url", async (req, res) => {
  const { filename, uploadId, partNumber } = req.query;
  if (!filename || !uploadId || !partNumber) return res.status(400).json({ error: "filename, uploadId, partNumber required" });
  const url = toPublicUrl(await getSignedUrl(s3, new UploadPartCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
    UploadId: uploadId,
    PartNumber: parseInt(partNumber),
  }), { expiresIn: 3600 }));
  res.json({ url });
});

app.post("/complete-multipart-upload", async (req, res) => {
  const { filename, uploadId, parts } = req.body;
  if (!filename || !uploadId || !parts) return res.status(400).json({ error: "filename, uploadId, parts required" });
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));
  res.json({ url: `${process.env.MINIO_PUBLIC_ENDPOINT}/${process.env.BUCKET}/${filename}` });
});

app.post("/abort-multipart-upload", async (req, res) => {
  const { filename, uploadId } = req.body;
  if (!filename || !uploadId) return res.status(400).json({ error: "filename, uploadId required" });
  await s3.send(new AbortMultipartUploadCommand({
    Bucket: process.env.BUCKET,
    Key: filename,
    UploadId: uploadId,
  }));
  res.json({ aborted: filename });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
