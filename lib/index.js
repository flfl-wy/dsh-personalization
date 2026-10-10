/**
 * dsh-personalization —— 宿主半区。
 *
 * 一个 Typert 远程服务（`personalization`），把 **AGENTS.md** 的读写与历史版本管理
 * 暴露给设置页。目标文件由**作用域**决定：
 *
 *   { kind: 'global' }                          -> $DSH_HOME/AGENTS.md
 *   { kind: 'workspace', workspaceId }          -> <workspace.path>/AGENTS.md
 *
 *   read({ scope })               -> { path, exists, content, bytes, mtimeMs }
 *   save({ scope, content })      -> { path, bytes, mtimeMs, backupPath, backupId }
 *   listVersions({ scope })       -> { dir, versions: [{ id, path, bytes, mtimeMs, at }] }
 *   readVersion({ scope, id })    -> { id, path, content, bytes, mtimeMs, at }
 *   restoreVersion({ scope, id }) -> { path, bytes, mtimeMs, backupPath, backupId, restoredFrom, versionPath }
 *   deleteVersion({ scope, id })  -> { id, path }
 *   listScopes()                  -> { scopes: [{ kind, workspaceId, title, path, exists, bytes, mtimeMs }] }
 *
 * 路径完全由宿主解析（`./scopes.js`）：客户端只能提交**不透明工作区 id**、文本或不透明
 * 版本 id，三者都不携带路径，因此这个设置页永远只动全局 AGENTS.md 与已注册工作区自己的
 * AGENTS.md（含其同目录 `.bak-*`）。
 *
 * 后四个方法名统一带 `Version(s)` 前缀是有原因的，不是风格问题：网关禁止远程方法与
 * 命名空间服务自身成员同名，而那个原型上有 `remove` / `install` / `has` / `empty` 等
 * 通用名。详见 `PersonalizationGateway.listVersions` 的说明。
 *
 * 实际文件操作用 `./agents-file.js`（纯函数、可单独测试）。`id` 的语义校验在
 * `agents-file.js` 里做（非法 id 给出可读的报错），这里只做类型校验 —— 边界上的
 * `codec.create().parse()` 会把非字符串挡在业务代码之前。
 *
 * @module dsh-personalization
 */

import { z } from 'zod'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  MAX_CONTENT_LENGTH,
  describeAgentsFile,
  listVersions,
  readAgentsFile,
  readVersion,
  removeVersion,
  restoreVersion,
  writeAgentsFile,
} from './agents-file.js'
import { GLOBAL_KIND, WORKSPACE_KIND, resolveScopeFile, scopeTargets } from './scopes.js'

/** Loader 行名；客户端半区挂在这条行上。 */
export const name = 'dsh-personalization'

/** 必须先有 Gateway 服务，才能注册 manifest。 */
export const inject = ['typert']

const PACKAGE = 'dsh-personalization'
const SERVICE_KEY = 'personalization'

/**
 * 一个同时携带两代契约的 strict codec：`schema` 给 0.1.6-alpha.1 及更早，
 * `create()` 给 0.1.6-alpha.2 及更晚。两代都只检查 `typeof`，所以同一个对象两边都能过，
 * 不需要探测版本。
 * @param typeSymbol - 稳定生成的类型标识。
 * @param schema - 校验该边界的 zod schema。
 * @returns 双契约 strict codec。
 */
function strictCodec(typeSymbol, schema) {
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

/**
 * 作用域描述符。客户端只能在这两个分支里选，路径由宿主从注册表重新查出。
 */
const scopeSchema = z.union([
  z.object({ kind: z.literal(GLOBAL_KIND) }),
  z.object({ kind: z.literal(WORKSPACE_KIND), workspaceId: z.string().min(1) }),
])

const scopePayloadSchema = z.object({ scope: scopeSchema })

const readResultSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  content: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
})

const savePayloadSchema = z.object({
  scope: scopeSchema,
  content: z.string().max(MAX_CONTENT_LENGTH, { message: `内容超过 ${MAX_CONTENT_LENGTH} 字符上限` }),
})

const saveResultSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
  backupPath: z.string().nullable(),
  backupId: z.string().nullable(),
})

/** 历史版本列表里的一项：只有元数据，内容要另外按 id 取。 */
const versionSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
  at: z.number(),
})

const listResultSchema = z.object({
  dir: z.string(),
  versions: z.array(versionSummarySchema),
})

/** 所有按版本操作的方法共用同一个入参形状。id 的形态校验在 agents-file.js 里。 */
const versionPayloadSchema = z.object({ scope: scopeSchema, id: z.string() })

const versionDetailSchema = z.object({
  id: z.string(),
  path: z.string(),
  content: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
  at: z.number(),
})

const restoreResultSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
  backupPath: z.string().nullable(),
  backupId: z.string().nullable(),
  restoredFrom: z.string(),
  versionPath: z.string(),
})

const removeResultSchema = z.object({
  id: z.string(),
  path: z.string(),
})

/** 一个可选作用域：全局的 `workspaceId` / `title` 为 null。 */
const scopeSummarySchema = z.object({
  kind: z.enum([GLOBAL_KIND, WORKSPACE_KIND]),
  workspaceId: z.string().nullable(),
  title: z.string().nullable(),
  path: z.string(),
  exists: z.boolean(),
  bytes: z.number(),
  mtimeMs: z.number(),
})

const listScopesResultSchema = z.object({ scopes: z.array(scopeSummarySchema) })

/** 收一个 `{ scope }` 载荷的描述符；`read` / `listVersions` 共用同一形状。 */
function scopeInvocation(method, resultName, resultSchema) {
  return {
    id: `${PACKAGE}#personalization/${method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'payload',
        wire: 'payload',
        source: 'json',
        codec: strictCodec(`${PACKAGE}#ScopePayload`, scopePayloadSchema),
      },
    ],
    result: strictCodec(`${PACKAGE}#${resultName}`, resultSchema),
  }
}

/** 收一个 `{ scope, id }` 载荷的描述符；三个版本操作方法共用同一形状。 */
function versionInvocation(method, resultName, resultSchema) {
  return {
    id: `${PACKAGE}#personalization/${method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'payload',
        wire: 'payload',
        source: 'json',
        codec: strictCodec(`${PACKAGE}#VersionPayload`, versionPayloadSchema),
      },
    ],
    result: strictCodec(`${PACKAGE}#${resultName}`, resultSchema),
  }
}

/** 浏览器半区 $mount 时用的消费者贡献必须与之逐字段一致。 */
export const MANIFEST = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    scopeInvocation('read', 'ReadResult', readResultSchema),
    {
      id: `${PACKAGE}#personalization/save`,
      service: SERVICE_KEY,
      namespace: SERVICE_KEY,
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'payload',
          wire: 'payload',
          source: 'json',
          codec: strictCodec(`${PACKAGE}#SavePayload`, savePayloadSchema),
        },
      ],
      result: strictCodec(`${PACKAGE}#SaveResult`, saveResultSchema),
    },
    scopeInvocation('listVersions', 'ListResult', listResultSchema),
    versionInvocation('readVersion', 'VersionDetail', versionDetailSchema),
    versionInvocation('restoreVersion', 'RestoreResult', restoreResultSchema),
    versionInvocation('deleteVersion', 'RemoveResult', removeResultSchema),
    {
      id: `${PACKAGE}#personalization/listScopes`,
      service: SERVICE_KEY,
      namespace: SERVICE_KEY,
      method: 'listScopes',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${PACKAGE}#ScopeListResult`, listScopesResultSchema),
    },
  ],
  model: { services: [], events: [], objects: [] },
}

/**
 * 取宿主的工作区注册表服务。
 *
 * 用 `ctx.get` 惰性取而不是写进 `inject`：精简组合里可能没有这个服务，写进 inject 会让
 * 整个插件加载不了，而这里只该影响「工作区作用域」这一项能力。取不到时返回 `undefined`，
 * 由 `./scopes.js` 决定是报可读错误（解析路径）还是只列出全局（枚举作用域）。
 * @param ctx - 宿主上下文。
 * @returns 注册表服务，或 undefined。
 */
function workspaceRegistryOf(ctx) {
  try {
    return ctx?.get?.('workspaceRegistry')
  } catch {
    return undefined
  }
}

/**
 * 作用域 -> 目标文件。路径永远由宿主解析，客户端提交的只是不透明 id。
 * @param ctx - 宿主上下文。
 * @param scope - 客户端提交的作用域。
 * @returns 目标文件的绝对路径。
 */
function fileFor(ctx, scope) {
  return resolveScopeFile(scope, workspaceRegistryOf(ctx))
}

/**
 * 个性化设置页的远程半区：按作用域读写 AGENTS.md，并管理同目录下的时间戳备份
 * （枚举 / 查看 / 回滚 / 删除）。
 *
 * 每个方法都直通 `./agents-file.js`，自身不含业务逻辑 —— 抛出的错误由 Gateway 包成
 * `{ ok: false, error: { code: 'gateway/internal', message } }` 交给客户端显示。
 */
export class PersonalizationGateway extends TypertRemoteService {
  /**
   * @param ctx - 所属 Host 上下文。
   */
  constructor(ctx) {
    super(ctx, SERVICE_KEY)
  }

  /**
   * 列出可选作用域：全局在前，其后是各已注册工作区。
   *
   * 注册表缺失或尚未启动时退化为「只有全局」，而不是让整个设置页报错 —— 读取全局
   * AGENTS.md 不依赖注册表。
   * @returns 每个作用域的路径与文件状态。
   */
  async listScopes() {
    let targets
    try {
      targets = scopeTargets(workspaceRegistryOf(this.ctx))
    } catch (cause) {
      this.ctx?.logger?.warn?.(`personalization: listing workspaces failed: ${String(cause)}`)
      targets = scopeTargets(undefined)
    }
    const scopes = []
    for (const target of targets) {
      scopes.push({ ...target, ...(await describeAgentsFile(target.path)) })
    }
    return { scopes }
  }

  /**
   * 读取作用域内的 AGENTS.md；文件缺失时返回空内容而不是报错。
   * @param payload - 作用域。
   * @returns 绝对路径、是否存在、内容、字节数与 mtime。
   */
  async read(payload) {
    return readAgentsFile(fileFor(this.ctx, payload.scope))
  }

  /**
   * 替换作用域内的 AGENTS.md，覆盖前备份上一版。
   * @param payload - 作用域与新内容。
   * @returns 绝对路径、字节数、mtime，以及备份路径与备份 id（原文件不存在时为 null）。
   */
  async save(payload) {
    return writeAgentsFile(payload.content, fileFor(this.ctx, payload.scope))
  }

  /**
   * 列出该作用域的全部历史版本（新 → 旧），只含元数据。
   *
   * 方法名刻意带上 `Versions` 前缀：网关会拒绝任何与命名空间服务自身成员同名的远程
   * 方法（`assertMethodAvailable` 判定 `method in RemoteNamespaceService.prototype`），
   * 而那个原型上有 `remove` / `install` / `has` / `empty` 等通用名。撞上任何一个，
   * `$mount` 会整组回滚，连 `read` / `save` 一起失效。`lib/client.js` 里同名的描述符
   * 必须逐字段对应，`test/client-bundle.test.mjs` 的假网关也照此规则拒绝。
   *
   * @param payload - 作用域。
   * @returns 备份目录与版本摘要数组。
   */
  async listVersions(payload) {
    return listVersions(fileFor(this.ctx, payload.scope))
  }

  /**
   * 读取某个历史版本的完整内容。
   * @param payload - 作用域与版本 id。
   * @returns 该版本的路径、内容、字节数、mtime 与解析出的时刻。
   */
  async readVersion(payload) {
    return readVersion(payload.id, fileFor(this.ctx, payload.scope))
  }

  /**
   * 回滚到某个历史版本；替换前的当前内容会先被存成一份新的历史版本。
   * @param payload - 作用域与目标版本 id。
   * @returns 与 `save` 相同的写入结果，外加来源版本 id 与路径。
   */
  async restoreVersion(payload) {
    return restoreVersion(payload.id, fileFor(this.ctx, payload.scope))
  }

  /**
   * 删除某个历史版本。只会删 `.bak-*`，主文件不受影响。
   *
   * 不能叫 `remove`：这个名字被命名空间服务原型占用（见 `listVersions` 的说明）。
   *
   * @param payload - 作用域与版本 id。
   * @returns 被删除版本的 id 与路径。
   */
  async deleteVersion(payload) {
    return removeVersion(payload.id, fileFor(this.ctx, payload.scope))
  }
}

/**
 * 注册远程服务与 Gateway manifest。
 * @param ctx - 所属 Host 上下文，已注入 `typert`。
 */
export function apply(ctx) {
  new PersonalizationGateway(ctx)
  ctx.effect(() => ctx.typert.register(MANIFEST), 'dsh-personalization: typert manifest')
}
