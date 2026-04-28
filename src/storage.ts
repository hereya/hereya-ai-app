import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new S3Client({ region: process.env.awsRegion });
const bucket = () => process.env.bucketName!;
const prefix = () => process.env.s3Prefix!;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const INVALID_PATH_RE = /\.\.|\/\/|^\//;

export function validatePath(p: string): void {
  if (!p || INVALID_PATH_RE.test(p)) {
    throw new InvalidPathError(`Invalid path: "${p}". Must not contain "..", "//", or start with "/".`);
  }
}

export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}

function fullKey(p: string): string {
  const pfx = prefix();
  return pfx ? `${pfx}/${p}` : p;
}

function stripPrefix(key: string): string {
  const pfx = prefix();
  if (pfx && key.startsWith(pfx + "/")) {
    return key.slice(pfx.length + 1);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

export async function createFolder(path: string): Promise<void> {
  validatePath(path);
  const key = fullKey(path).replace(/\/?$/, "/"); // ensure trailing slash
  await client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: "",
    })
  );
}

// ---------------------------------------------------------------------------
// Upload / Download URLs
// ---------------------------------------------------------------------------

export async function getUploadUrl(
  path: string,
  contentType = "application/octet-stream",
  expiresIn = 3600
): Promise<{ url: string; path: string }> {
  validatePath(path);
  const key = fullKey(path);
  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(client, command, { expiresIn });
  return { url, path };
}

export async function getDownloadUrl(
  path: string,
  expiresIn = 3600
): Promise<{ url: string; path: string }> {
  validatePath(path);
  const key = fullKey(path);

  // Check file exists
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key })
    );
  } catch (err: any) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      throw new FileNotFoundError(`File not found: "${path}"`);
    }
    throw err;
  }

  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
  });
  const url = await getSignedUrl(client, command, { expiresIn });
  return { url, path };
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------

export interface FileInfo {
  name: string;
  size: number;
  last_modified: string;
}

export interface ListResult {
  path: string;
  files: FileInfo[];
  folders: string[];
}

export async function listFiles(
  path?: string,
  recursive = false
): Promise<ListResult> {
  if (path) validatePath(path);

  const pfx = path ? fullKey(path).replace(/\/?$/, "/") : (prefix() ? prefix() + "/" : "");

  const params: any = {
    Bucket: bucket(),
    Prefix: pfx,
    MaxKeys: 1000,
  };

  if (!recursive) {
    params.Delimiter = "/";
  }

  const result = await client.send(new ListObjectsV2Command(params));

  const files: FileInfo[] = (result.Contents ?? [])
    .filter((obj) => obj.Key !== pfx) // exclude the folder marker itself
    .map((obj) => ({
      name: stripPrefix(obj.Key!).replace(/^.*\//, ""), // just the filename
      size: obj.Size ?? 0,
      last_modified: obj.LastModified?.toISOString() ?? "",
    }));

  const folders: string[] = (result.CommonPrefixes ?? [])
    .map((cp) => stripPrefix(cp.Prefix!).replace(/\/$/, ""))
    .filter(Boolean);

  return {
    path: path ?? "",
    files,
    folders,
  };
}

// ---------------------------------------------------------------------------
// Write file content
// ---------------------------------------------------------------------------

export async function putFileContent(
  path: string,
  content: string,
  contentType = "text/html"
): Promise<void> {
  validatePath(path);
  const key = fullKey(path);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: content,
      ContentType: contentType,
    })
  );
}

// ---------------------------------------------------------------------------
// Read file content
// ---------------------------------------------------------------------------

export async function getFileContent(path: string): Promise<string | null> {
  validatePath(path);
  const key = fullKey(path);

  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket(), Key: key })
    );
    return (await result.Body?.transformToString("utf-8")) ?? null;
  } catch (err: any) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delete file
// ---------------------------------------------------------------------------

export async function deleteFile(path: string): Promise<void> {
  validatePath(path);
  const key = fullKey(path);

  // Check file exists
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key })
    );
  } catch (err: any) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      throw new FileNotFoundError(`File not found: "${path}"`);
    }
    throw err;
  }

  await client.send(
    new DeleteObjectCommand({ Bucket: bucket(), Key: key })
  );
}

// ---------------------------------------------------------------------------
// Delete folder recursively
// ---------------------------------------------------------------------------

export async function deleteFolderRecursive(path: string): Promise<void> {
  validatePath(path);
  const pfx = fullKey(path).replace(/\/?$/, "/");

  let continuationToken: string | undefined;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: pfx,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (list.Contents ?? []).map((obj) => ({ Key: obj.Key! }));

    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: objects },
        })
      );
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);
}
