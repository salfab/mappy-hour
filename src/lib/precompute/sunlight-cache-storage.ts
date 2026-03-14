import fs from "node:fs/promises";
import path from "node:path";

export interface CacheStorage {
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, value: string): Promise<void>;
  readBuffer(filePath: string): Promise<Buffer>;
  writeBuffer(filePath: string, value: Buffer): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  listFiles(rootPath: string): Promise<string[]>;
  removePrefix(rootPath: string): Promise<void>;
}

class LocalCacheStorage implements CacheStorage {
  async readText(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf8");
  }

  async writeText(filePath: string, value: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value, "utf8");
  }

  async readBuffer(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async writeBuffer(filePath: string, value: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(rootPath: string): Promise<string[]> {
    const files: string[] = [];
    const stack = [rootPath];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    files.sort();
    return files;
  }

  async removePrefix(rootPath: string): Promise<void> {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

const localCacheStorage = new LocalCacheStorage();

export function getSunlightCacheStorage(): CacheStorage {
  return localCacheStorage;
}
