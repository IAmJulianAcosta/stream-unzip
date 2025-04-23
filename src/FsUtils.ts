/**
 * Recursively create a subdirectory path within a given directory handle.
 */
export async function createDirRecursive(
    rootDir: FileSystemDirectoryHandle,
    path: string
): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let currentDir = rootDir;
    for (const seg of segments) {
        currentDir = await currentDir.getDirectoryHandle(seg, {create: true});
    }
}

/**
 * Ensures that the parent directories for the given file path exist,
 * then returns the FileSystemFileHandle.
 */
export async function createFileWithDirs(
    rootDir: FileSystemDirectoryHandle,
    filePath: string
): Promise<FileSystemFileHandle> {
    const segments = filePath.split("/").filter(Boolean);
    const fileName = segments.pop()!;
    if (segments.length > 0) {
        await createDirRecursive(rootDir, segments.join("/"));
    }
    return rootDir.getFileHandle(fileName, {create: true});
}

export async function getNestedFileHandle(
    root: FileSystemDirectoryHandle,
    path: string
): Promise<FileSystemFileHandle> {
    const parts = path.split("/");
    const filename = parts.pop()!;
    let dir = root;
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return await dir.getFileHandle(filename, { create: true });
}