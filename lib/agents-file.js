/**
 * 全局 AGENTS.md 的纯文件操作。
 *
 * 不 import 任何 DSH 运行时包（除了纯路径工具），因此可以在 Node 里直接跑
 * 往返测试：`DSH_HOME=/tmp/x node -e "import('./lib/agents-file.js')..."`。
 *
 * @module dsh-personalization/agents-file
 */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 拒绝保存超过此长度的内容（UTF-16 码元数）。 */
export const MAX_CONTENT_LENGTH = 1024 * 1024

/**
 * 全局 AGENTS.md 的绝对路径。
 * 由宿主解析（遵循 `$DSH_HOME`，默认 `~/.dsh`），客户端不参与路径决定。
 * @returns 绝对路径。
 */
export function agentsFile() {
  return dshHomePath('AGENTS.md')
}

/**
 * 生成同目录下的时间戳备份路径。
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
 * @returns `{ path, bytes, mtimeMs, backupPath }`；文件此前不存在时 backupPath 为 null。
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
    backupPath = backupPathFor(path, new Date())
    await copyFile(path, backupPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    backupPath = null
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  const info = await stat(path)
  return { path, bytes: Buffer.byteLength(content, 'utf8'), mtimeMs: info.mtimeMs, backupPath }
}
