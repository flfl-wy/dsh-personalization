/**
 * dsh-personalization —— 宿主半区。
 *
 * 一个 Typert 远程服务（`personalization`），把全局 AGENTS.md 的读写暴露给设置页：
 *
 *   read()            -> { path, exists, content, bytes, mtimeMs }
 *   save({ content }) -> { path, bytes, mtimeMs, backupPath }
 *
 * 实际文件操作用 `./agents-file.js`（纯函数、可单独测试）。目标路径完全由宿主解析，
 * 客户端只能提交文本、不能提交路径，因此这个设置页永远只改这一个文件。
 *
 * @module dsh-personalization
 */

import { z } from 'zod'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MAX_CONTENT_LENGTH, readAgentsFile, writeAgentsFile } from './agents-file.js'

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
})

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
  ],
  model: { services: [], events: [], objects: [] },
}

/**
 * 个性化设置页的远程半区：读取并替换全局 AGENTS.md，每次替换都留一份时间戳副本。
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
   * @returns 绝对路径、字节数、mtime，以及备份路径（原文件不存在时为 null）。
   */
  async save(payload) {
    return writeAgentsFile(payload.content)
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
