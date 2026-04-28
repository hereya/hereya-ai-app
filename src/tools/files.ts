import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createFolder,
  getUploadUrl,
  getDownloadUrl,
  listFiles,
  deleteFile,
  InvalidPathError,
  FileNotFoundError,
} from "../storage.js";
import { toolError } from "../errors.js";

export function registerFileTools(server: McpServer) {
  // --- create-folder ---
  server.registerTool(
    "create-folder",
    {
      title: "Create Folder",
      description:
        "Create a folder in the org's file storage. Used to organize files by app or category.",
      inputSchema: {
        path: z
          .string()
          .describe("Folder path relative to org root (e.g., recipes/photos)"),
      },
    },
    async ({ path }) => {
      try {
        await createFolder(path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ path, created: true }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof InvalidPathError) {
          return toolError("INVALID_PATH", err.message);
        }
        throw err;
      }
    }
  );

  // --- get-upload-url ---
  server.registerTool(
    "get-upload-url",
    {
      title: "Get Upload URL",
      description:
        "Get a presigned URL for uploading a file directly to storage. The URL is valid for the specified duration. Upload the file via HTTP PUT to the returned URL.",
      inputSchema: {
        path: z
          .string()
          .describe("File path (e.g., recipes/photos/tarte-tatin.jpg)"),
        content_type: z
          .string()
          .optional()
          .default("application/octet-stream")
          .describe("MIME type. Default: application/octet-stream"),
        expires_in: z
          .number()
          .int()
          .optional()
          .default(3600)
          .describe("URL expiry in seconds. Default: 3600"),
      },
    },
    async ({ path, content_type, expires_in }) => {
      try {
        const result = await getUploadUrl(path, content_type, expires_in);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                upload_url: result.url,
                path: result.path,
                expires_in,
              }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof InvalidPathError) {
          return toolError("INVALID_PATH", err.message);
        }
        throw err;
      }
    }
  );

  // --- get-download-url ---
  server.registerTool(
    "get-download-url",
    {
      title: "Get Download URL",
      description:
        "Get a presigned URL for downloading a file directly from storage. The URL is valid for the specified duration.",
      inputSchema: {
        path: z.string().describe("File path"),
        expires_in: z
          .number()
          .int()
          .optional()
          .default(3600)
          .describe("URL expiry in seconds. Default: 3600"),
      },
    },
    async ({ path, expires_in }) => {
      try {
        const result = await getDownloadUrl(path, expires_in);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                download_url: result.url,
                path: result.path,
                expires_in,
              }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof InvalidPathError) {
          return toolError("INVALID_PATH", err.message);
        }
        if (err instanceof FileNotFoundError) {
          return toolError("FILE_NOT_FOUND", err.message);
        }
        throw err;
      }
    }
  );

  // --- list-files ---
  server.registerTool(
    "list-files",
    {
      title: "List Files",
      description:
        "List files and subfolders at a path in the org's storage.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Folder path. Default: root"),
        recursive: z
          .boolean()
          .optional()
          .default(false)
          .describe("List all files recursively. Default: false"),
      },
    },
    async ({ path, recursive }) => {
      try {
        const result = await listFiles(path, recursive);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        if (err instanceof InvalidPathError) {
          return toolError("INVALID_PATH", err.message);
        }
        throw err;
      }
    }
  );

  // --- delete-file ---
  server.registerTool(
    "delete-file",
    {
      title: "Delete File",
      description: "Delete a file from storage.",
      inputSchema: {
        path: z.string().describe("File path to delete"),
      },
    },
    async ({ path }) => {
      try {
        await deleteFile(path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ deleted: path }),
            },
          ],
        };
      } catch (err) {
        if (err instanceof InvalidPathError) {
          return toolError("INVALID_PATH", err.message);
        }
        if (err instanceof FileNotFoundError) {
          return toolError("FILE_NOT_FOUND", err.message);
        }
        throw err;
      }
    }
  );
}
