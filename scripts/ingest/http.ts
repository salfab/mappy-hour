import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface DownloadFileOptions {
  overwrite?: boolean;
}

export interface DownloadFileResult {
  downloaded: boolean;
  bytes: number;
  destinationPath: string;
}

export async function downloadFile(
  url: string,
  destinationPath: string,
  options: DownloadFileOptions = {},
): Promise<DownloadFileResult> {
  const overwrite = options.overwrite ?? false;
  if (!overwrite && (await fileExists(destinationPath))) {
    return {
      downloaded: false,
      bytes: 0,
      destinationPath,
    };
  }

  await ensureDirectory(path.dirname(destinationPath));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(destinationPath, buffer);

  const headerBytes = Number(response.headers.get("content-length") ?? "0");
  const bytes = Number.isFinite(headerBytes) && headerBytes > 0
    ? headerBytes
    : buffer.byteLength;
  return {
    downloaded: true,
    bytes,
    destinationPath,
  };
}
