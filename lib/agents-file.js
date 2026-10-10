/**
 * 全局 AGENTS.md 的纯文件操作，以及历史版本（时间戳备份）的枚举 / 读取 / 回滚 / 删除。
 *
 * 不 import 任何 DSH 运行时包（除了纯路径工具），因此可以在 Node 里直接跑
 * 往返测试：`DSH_HOME=/tmp/x node -e "import('./lib/agents-file.js')..."`。
 *
 * 版本用**不透明 id**（`YYYYMMDD-HHmmss`）寻址：客户端只能提交 id，路径由这里重新拼，
 * 因此客户端无法借 id 越出 `$DSH_HOME` 去读或删别的文件。
 *
 * @module dsh-personalization/agents-file
 */

import { copyFile, lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 拒绝保存超过此长度的内容（UTF-16 码元数）。 */
export const MAX_CONTENT_LENGTH = 1024 * 1024

/**
 * 版本 id 的形态：`YYYYMMDD-HHmmss`；同一秒内产生的第 2、3… 个版本追加 `-2`、`-3`。
 * 只允许数字与连字符，因此 id 里不可能出现路径分隔符或 `..`。
 */
export const VERSION_ID_PATTERN = /^\d{8}-\d{6}(?:-\d+)?$/

/** 主文件名与其备份之间的固定分隔串。 */
const BACKUP_INFIX = '.bak-'

/** 同一秒内最多尝试的备份名数量，防止病态情况下无限循环。 */
const MAX_BACKUP_ATTEMPTS = 1000

/**
 * 全局 AGENTS.md 的绝对路径。
 * 由宿主解析（遵循 `$DSH_HOME`，默认 `~/.dsh`），客户端不参与路径决定。
 * @returns 绝对路径。
 */
export function agentsFile() {
  return dshHomePath('AGENTS.md')
}

/**
 * 生成同目录下的时间戳备份路径。纯函数、不查文件系统，所以同一秒内会重复。
 * 真正落盘请用 `writeAgentsFile`（它会用 `nextBackupPath` 避开已占用的名字）。
 * @param file - 被备份的文件。
 * @param at - 用于本地时间戳的时刻。
 * @returns 形如 `<file>.bak-YYYYMMDD-HHmmss` 的路径。
 */
export function backupPathFor(file, at) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
  ].join('') + '-' + [pad(at.getHours()), pad(at.getMinutes()), pad(at.getSeconds())].join('')
  return `${file}.bak-${stamp}`
}

/**
 * 从路径（或裸文件名）解析版本 id。
 * @param path - 备份路径或文件名。
 * @returns 合法 id；不是本文件的备份则返回 null。
 */
export function versionIdOf(path) {
  const name = basename(String(path))
  const prefix = `${basename(agentsFile())}${BACKUP_INFIX}`
  if (!name.startsWith(prefix)) return null
  const id = name.slice(prefix.length)
  return VERSION_ID_PATTERN.test(id) ? id : null
}

/**
 * 把版本 id 解析回绝对路径。**这是唯一的 id → 路径入口**，非法 id 一律拒绝，
 * 因此 id 无法指向 `$DSH_HOME` 之外。
 * @param id - 版本 id。
 * @returns 该版本的绝对路径。
 * @throws {RangeError} id 形态非法时。
 */
export function versionPathFor(id) {
  if (typeof id !== 'string' || !VERSION_ID_PATTERN.test(id)) {
    throw new RangeError(`agents-file: invalid version id ${JSON.stringify(id)}`)
  }
  const file = agentsFile()
  return join(dirname(file), `${basename(file)}${BACKUP_INFIX}${id}`)
}

/**
 * 从版本 id 还原本地时刻，用于界面排序展示。
 * @param id - 版本 id。
 * @returns epoch 毫秒；前缀不是合法时间戳时返回 0。
 */
export function versionTimeOf(id) {
  if (typeof id !== 'string') return 0
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)
  if (match === null) return 0
  return new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  ).getTime()
}

/**
 * 找出这一秒里第一个未被占用的备份路径。
 * 没有它，同一秒内的第二次保存会覆盖掉上一份备份，历史版本就被静默吞掉了。
 * @param file - 被备份的文件。
 * @param at - 用于时间戳的时刻。
 * @returns 尚未存在的备份路径。
 */
async function nextBackupPath(file, at) {
  const base = backupPathFor(file, at)
  for (let suffix = 1; suffix <= MAX_BACKUP_ATTEMPTS; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`
    try {
      await lstat(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error(`agents-file: too many backups share the same second for ${base}`)
}

/**
 * 读取全局 AGENTS.md。文件不存在算成功读取空内容，让首次使用者直接看到可编辑的空文档，
 * 而不是一个错误页。
 * @returns `{ path, exists, content, bytes, mtimeMs }`。
 */
export async function readAgentsFile() {
  const path = agentsFile()
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { path, exists: true, content, bytes: Buffer.byteLength(content, 'utf8'), mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { path, exists: false, content: '', bytes: 0, mtimeMs: 0 }
  }
}

/**
 * 写入全局 AGENTS.md，写入前先把上一版复制为时间戳备份。
 * 备份先落盘再写新内容，所以写失败时原文仍可从 backupPath 恢复。
 * @param content - 新的完整内容。
 * @returns `{ path, bytes, mtimeMs, backupPath, backupId }`；文件此前不存在时两者为 null。
 */
export async function writeAgentsFile(content) {
  if (typeof content !== 'string') throw new TypeError('agents-file: content must be a string')
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new RangeError(`agents-file: content exceeds ${MAX_CONTENT_LENGTH} characters`)
  }

  const path = agentsFile()
  let backupPath = null
  try {
    await stat(path)
    backupPath = await nextBackupPath(path, new Date())
    await copyFile(path, backupPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    backupPath = null
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  const info = await stat(path)
  return {
    path,
    bytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs: info.mtimeMs,
    backupPath,
    backupId: backupPath === null ? null : versionIdOf(backupPath),
  }
}

/**
 * 列出全部历史版本，新的在前。只返回元数据，不返回内容 —— 列表可能很长，
 * 内容按需由 `readVersion` 单独取。
 *
 * 非普通文件（符号链接、目录）一律跳过：它们可能指向 `$DSH_HOME` 之外，
 * 不该被列出来供客户端读取或删除。
 * @returns `{ dir, versions }`，每个版本为 `{ id, path, bytes, mtimeMs, at }`。
 */
export async function listVersions() {
  const dir = dirname(agentsFile())
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { dir, versions: [] }
  }

  const versions = []
  for (const name of names) {
    const id = versionIdOf(name)
    if (id === null) continue
    const path = join(dir, name)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue // 枚举期间被并发删除
      throw error
    }
    if (!info.isFile()) continue
    versions.push({ id, path, bytes: info.size, mtimeMs: info.mtimeMs, at: versionTimeOf(id) })
  }

  // id 前缀即时间戳，字典序倒排等于「新 -> 旧」；同一秒的 `-2` 排在无后缀的那份之前。
  versions.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
  return { dir, versions }
}

/**
 * 读取某个历史版本的内容。
 * @param id - 版本 id。
 * @returns `{ id, path, content, bytes, mtimeMs, at }`。
 * @throws 版本不存在、不是普通文件、或超过 `MAX_CONTENT_LENGTH` 时。
 */
export async function readVersion(id) {
  const path = versionPathFor(id)
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`agents-file: version ${id} does not exist`)
    throw error
  })
  if (!info.isFile()) throw new Error(`agents-file: version ${id} is not a regular file`)
  if (info.size > MAX_CONTENT_LENGTH) {
    throw new RangeError(`agents-file: version ${id} exceeds ${MAX_CONTENT_LENGTH} bytes`)
  }
  const content = await readFile(path, 'utf8')
  return {
    id,
    path,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs: info.mtimeMs,
    at: versionTimeOf(id),
  }
}

/**
 * 回滚到某个历史版本：把它的内容写回主文件。
 *
 * 走的是 `writeAgentsFile`，所以**回滚本身也可回滚**：替换前的当前内容会先被存成一份
 * 新的历史版本。源版本不删除，历史链条保持完整。
 * @param id - 目标版本 id。
 * @returns `{ path, bytes, mtimeMs, backupPath, backupId, restoredFrom, versionPath }`。
 */
export async function restoreVersion(id) {
  const version = await readVersion(id)
  const saved = await writeAgentsFile(version.content)
  return { ...saved, restoredFrom: version.id, versionPath: version.path }
}

/**
 * 删除某个历史版本。只能删备份，不能碰主文件 —— 主文件名不匹配版本 id 形态。
 * @param id - 版本 id。
 * @returns `{ id, path }`。
 * @throws 版本不存在或不是普通文件时。
 */
export async function removeVersion(id) {
  const path = versionPathFor(id)
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`agents-file: version ${id} does not exist`)
    throw error
  })
  if (!info.isFile()) throw new Error(`agents-file: version ${id} is not a regular file`)
  await unlink(path)
  return { id, path }
}
