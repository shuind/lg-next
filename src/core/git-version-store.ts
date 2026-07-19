import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const execFileAsync = promisify(execFile)

export interface CheckpointResult {
  created: boolean
  commit?: string
}

export interface VersionCheckpoint {
  commit: string
  createdAt: string
  label: string
  files: Array<{ status: string; path: string }>
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  return result.stdout.trim()
}

export class GitVersionStore {
  constructor(private readonly root: string) {}

  async ensureRepository(): Promise<void> {
    try {
      const repositoryRoot = await git(this.root, ["rev-parse", "--show-toplevel"])
      if (path.resolve(repositoryRoot) !== path.resolve(this.root)) await git(this.root, ["init", "-b", "main"])
    } catch {
      await git(this.root, ["init", "-b", "main"])
    }
  }

  async checkpoint(label: string): Promise<CheckpointResult> {
    await this.ensureRepository()
    await git(this.root, ["add", "-A"])
    try {
      await git(this.root, ["rev-parse", "--verify", "HEAD"])
      await git(this.root, ["reset", "-q", "HEAD", "--", ".lg"])
    } catch {
      await git(this.root, ["rm", "--cached", "-r", "--ignore-unmatch", ".lg"]).catch(() => "")
    }
    const status = (await git(this.root, ["status", "--porcelain"]))
      .split(/\r?\n/)
      .filter((line) => line && !line.slice(3).replaceAll("\\", "/").startsWith(".lg/"))
      .join("\n")
    if (!status) return { created: false }

    await git(this.root, [
      "-c",
      "user.name=LG",
      "-c",
      "user.email=local@lg.invalid",
      "commit",
      "-m",
      label.trim() || "LG checkpoint",
    ])
    return {
      created: true,
      commit: await git(this.root, ["rev-parse", "HEAD"]),
    }
  }

  async ensureBaseline(): Promise<CheckpointResult> {
    await this.ensureRepository()
    try {
      await git(this.root, ["rev-parse", "--verify", "HEAD"])
      return { created: false }
    } catch {
      return this.checkpoint("初始版本")
    }
  }

  async list(limit = 40): Promise<VersionCheckpoint[]> {
    await this.ensureRepository()
    try {
      await git(this.root, ["rev-parse", "--verify", "HEAD"])
    } catch {
      return []
    }
    const output = await git(this.root, ["log", `-n${Math.max(1, Math.min(limit, 100))}`, "--pretty=format:%H%x1f%aI%x1f%s%x1e"])
    if (!output) return []
    const commits = output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [commit, createdAt, ...label] = record.split("\x1f")
      return { commit, createdAt, label: label.join("\x1f") }
    })
    return Promise.all(commits.map(async (commit) => {
      const ancestry = await git(this.root, ["rev-list", "--parents", "-n1", commit.commit])
      const isRoot = ancestry.trim().split(/\s+/).length === 1
      const changed = await git(this.root, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", commit.commit])
      const files = changed.split(/\r?\n/).filter(Boolean).map((line) => {
        const [status, ...fileParts] = line.split("\t")
        return { status, path: fileParts.at(-1) ?? "" }
      }).filter((file) => file.path && file.path !== ".gitignore" && !file.path.startsWith(".lg/"))
      return { ...commit, label: isRoot ? "初始版本" : commit.label, files }
    }))
  }

  async diff(commit: string): Promise<string> {
    await this.validateCommit(commit)
    return git(this.root, ["show", "--root", "--format=", "--no-ext-diff", "--unified=3", commit, "--", ".", ":(exclude).lg/**", ":(exclude).gitignore"])
  }

  private async validateCommit(commit: string): Promise<void> {
    if (!/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error("版本标识无效")
    await git(this.root, ["cat-file", "-e", `${commit}^{commit}`])
    try {
      await git(this.root, ["merge-base", "--is-ancestor", commit, "HEAD"])
    } catch {
      throw new Error("只能恢复当前作品历史中的版本")
    }
  }

  async restore(commit: string, label: string): Promise<CheckpointResult> {
    await this.validateCommit(commit)
    await this.checkpoint("恢复版本前自动保存")
    await git(this.root, ["restore", `--source=${commit}`, "--staged", "--worktree", "--", ".", ":(exclude).lg/**", ":(exclude).gitignore"])
    return this.checkpoint(`恢复到：${label || commit.slice(0, 8)}`)
  }
}
