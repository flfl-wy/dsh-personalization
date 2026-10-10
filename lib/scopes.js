/**
 * 作用域（scope）的纯逻辑：把客户端提交的**不透明**作用域描述符解析成宿主侧的目标文件。
 *
 * 与 `./agents-file.js` 一样，这里不 import 任何 DSH 运行时包，因此可以脱离 DSH 单独测试。
 * 工作区注册表由调用方以最小接口传入（`{ get(id), list() }`），本模块不关心它来自
 * Cordis 服务还是测试替身。
 *
 * 安全边界：客户端**只能**提交 `{ kind: 'global' }` 或
 * `{ kind: 'workspace', workspaceId }`；路径永远由 `resolveScopeFile()` 从注册表重新查出，
 * 客户端无法把读写引到任意文件上。
 *
 * @module dsh-personalization/scopes
 */

import { agentsFile, agentsFileIn } from './agents-file.js'

/** 全局作用域：`$DSH_HOME/AGENTS.md`。 */
export const GLOBAL_KIND = 'global'

/** 工作区作用域：`<workspace.path>/AGENTS.md`。 */
export const WORKSPACE_KIND = 'workspace'

const KINDS = new Set([GLOBAL_KIND, WORKSPACE_KIND])

/**
 * 作用域的稳定字符串键，供界面做 `<select>` 的 value 与查找。
 * 客户端有一份同构实现（`lib/client.js` 是手写束，不能 import 宿主模块）。
 * @param scope - 作用域描述符。
 * @returns `global`，或 `workspace:<workspaceId>`。
 */
export function scopeKey(scope) {
  return scope.kind === GLOBAL_KIND ? GLOBAL_KIND : `${WORKSPACE_KIND}:${scope.workspaceId}`
}

/**
 * 校验并归一化一个作用域描述符。
 *
 * 它是网关 zod 校验之外的最后一道形状检查 —— 宿主自己的调用方（将来的 CLI、
 * 定时任务）也可能直接调进来，所以这里不做「反正网关已经验过了」的假设。
 * @param scope - 客户端提交的作用域。
 * @returns `{ kind, workspaceId }`；全局作用域的 `workspaceId` 为 `null`。
 * @throws {TypeError} 形状非法时。
 */
export function normalizeScope(scope) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError(`scopes: scope must be an object, got ${JSON.stringify(scope)}`)
  }
  if (!KINDS.has(scope.kind)) {
    throw new TypeError(`scopes: unknown scope kind ${JSON.stringify(scope.kind)}`)
  }
  if (scope.kind === GLOBAL_KIND) return { kind: GLOBAL_KIND, workspaceId: null }
  if (typeof scope.workspaceId !== 'string' || scope.workspaceId.length === 0) {
    throw new TypeError('scopes: a workspace scope needs a non-empty workspaceId')
  }
  return { kind: WORKSPACE_KIND, workspaceId: scope.workspaceId }
}

/**
 * 把作用域解析成宿主侧的绝对文件路径。
 *
 * 注册表不可用或 id 不存在时**抛错**，不退回默认路径 —— 静默退回会把用户的编辑写进
 * 别的文件，这是最坏的一种失败。
 *
 * @param scope - 作用域描述符。
 * @param registry - 工作区注册表（`{ get(id): { path } | undefined }`）；全局作用域不需要它。
 * @returns 目标文件的绝对路径。
 * @throws {TypeError} 作用域形状非法时。
 * @throws {Error} 注册表不可用，或该工作区不存在时。
 */
export function resolveScopeFile(scope, registry) {
  const normalized = normalizeScope(scope)
  if (normalized.kind === GLOBAL_KIND) return agentsFile()
  if (registry === undefined || registry === null || typeof registry.get !== 'function') {
    throw new Error('scopes: the workspace registry is unavailable, so a workspace scope cannot be resolved')
  }
  const workspace = registry.get(normalized.workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new Error(`scopes: unknown workspace ${JSON.stringify(normalized.workspaceId)}`)
  }
  return agentsFileIn(workspace.path)
}

/**
 * 列出可选作用域：全局在前，其后按注册表顺序是各工作区。
 *
 * 只做路径推导，**不碰文件系统** —— `exists` / `bytes` / `mtimeMs` 由宿主拿到路径后补，
 * 这样本模块保持纯函数、可以直接测。
 *
 * @param registry - 工作区注册表（`{ list(): Array<{ id, path, title }> }`）；
 *   缺失时只返回全局作用域（宿主侧据此优雅降级）。
 * @returns `[{ kind, workspaceId, title, path }]`，顺序稳定。
 */
export function scopeTargets(registry) {
  const targets = [{
    kind: GLOBAL_KIND,
    workspaceId: null,
    title: null,
    path: agentsFile(),
  }]
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return targets
  for (const workspace of registry.list()) {
    targets.push({
      kind: WORKSPACE_KIND,
      workspaceId: workspace.id,
      title: typeof workspace.title === 'string' ? workspace.title : null,
      path: agentsFileIn(workspace.path),
    })
  }
  return targets
}
