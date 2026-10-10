/**
 * dsh-personalization —— 宿主半区。
 *
 * 一个 Typert 远程服务（`personalization`），把全局 AGENTS.md 的读写与历史版本管理
 * 暴露给设置页：
 *
 *   read()               -> { path, exists, content, bytes, mtimeMs }
 *   save({ content })    -> { path, bytes, mtimeMs, backupPath, backupId }
 *   list()               -> { dir, versions: [{ id, path, bytes, mtimeMs, at }] }
 *   readVersion({ id })  -> { id, path, content, bytes, mtimeMs, at }
 *   restore({ id })      -> { path, bytes, mtimeMs, backupPath, backupId, restoredFrom, versionPath }
 *   remove({ id })       -> { id, path }
 *
 * 实际文件操作用 `./agents-file.js`（纯函数、可单独测试）。目标路径完全由宿主解析：
 * 客户端只能提交**文本**或**不透明版本 id**，两者都不携带路径，因此这个设置页永远只动
 * `$DSH_HOME/AGENTS.md` 及其同目录的 `.bak-*` 备份。
 *
 * 注意 `id` 的语义校验在 `agents-file.js` 里做（非法 id 给出可读的报错），这里只做类型
 * 校验 —— 边界上的 `codec.create().parse()` 会把非字符串挡在业务代码之前。
 *
 * @module dsh-personalization
 */

import { z } from 'zod'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  MAX_CONTENT_LENGTH,
  listVersions,
  readAgentsFile,
  readVersion,
  removeVersion,
  restoreVersion,
  writeAgentsFile,
} from './agents-file.js'

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

const readResultSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  content: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
})

const savePayloadSchema = z.object({
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
const versionPayloadSchema = z.object({ id: z.string() })

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

/** 收一个 `{ id }` 载荷的 invocation 描述符；四个版本操作方法共用同一形状。 */
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
    {
      id: `${PACKAGE}#personalization/read`,
      service: SERVICE_KEY,
      namespace: SERVICE_KEY,
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${PACKAGE}#ReadResult`, readResultSchema),
    },
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
    {
      id: `${PACKAGE}#personalization/list`,
      service: SERVICE_KEY,
      namespace: SERVICE_KEY,
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec(`${PACKAGE}#ListResult`, listResultSchema),
    },
    versionInvocation('readVersion', 'VersionDetail', versionDetailSchema),
    versionInvocation('restore', 'RestoreResult', restoreResultSchema),
    versionInvocation('remove', 'RemoveResult', removeResultSchema),
  ],
  model: { services: [], events: [], objects: [] },
}

/**
 * 个性化设置页的远程半区：读写全局 AGENTS.md，并管理同目录下的时间戳备份
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
   * 读取全局 AGENTS.md；文件缺失时返回空内容而不是报错。
   * @returns 绝对路径、是否存在、内容、字节数与 mtime。
   */
  async read() {
    return readAgentsFile()
  }

  /**
   * 替换全局 AGENTS.md，覆盖前备份上一版。
   * @param payload - 新内容。
   * @returns 绝对路径、字节数、mtime，以及备份路径与备份 id（原文件不存在时为 null）。
   */
  async save(payload) {
    return writeAgentsFile(payload.content)
  }

  /**
   * 列出全部历史版本（新 → 旧），只含元数据。
   * @returns 备份目录与版本摘要数组。
   */
  async list() {
    return listVersions()
  }

  /**
   * 读取某个历史版本的完整内容。
   * @param payload - 版本 id。
   * @returns 该版本的路径、内容、字节数、mtime 与解析出的时刻。
   */
  async readVersion(payload) {
    return readVersion(payload.id)
  }

  /**
   * 回滚到某个历史版本；替换前的当前内容会先被存成一份新的历史版本。
   * @param payload - 目标版本 id。
   * @returns 与 `save` 相同的写入结果，外加来源版本 id 与路径。
   */
  async restore(payload) {
    return restoreVersion(payload.id)
  }

  /**
   * 删除某个历史版本。只会删 `.bak-*`，主文件不受影响。
   * @param payload - 版本 id。
   * @returns 被删除版本的 id 与路径。
   */
  async remove(payload) {
    return removeVersion(payload.id)
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
