import path from "node:path"

export function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

export function resolveInside(root: string, relativePath: string): string {
  if (!relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error("作品路径必须是非空相对路径")
  }

  const absoluteRoot = path.resolve(root)
  const absolutePath = path.resolve(absoluteRoot, relativePath)
  const relative = path.relative(absoluteRoot, absolutePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径超出作品目录：${relativePath}`)
  }
  return absolutePath
}

