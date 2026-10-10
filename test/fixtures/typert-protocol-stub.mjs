/**
 * `@deepseek-ai/dsh-typert-protocol` 的最小替身，只给测试用。
 *
 * 为什么需要它：本插件**故意不装** cordis（`.npmrc` / `pnpm-workspace.yaml` 里
 * `autoInstallPeers=false`，装了就会出现第二个 cordis 实例，Service 注册会坏），
 * 而真实的 dsh-typert-protocol import 了 `@deepseek-ai/cordis`，因此在纯 Node 下
 * 直接 `import('../lib/index.js')` 会报 `Cannot find package '@deepseek-ai/cordis'`。
 *
 * `test/manifest-parity.test.mjs` 用 `module.registerHooks` 把该包重定向到这里，
 * 只为取出真实的 `MANIFEST` 做契约校验 —— 宿主半区实际依赖的只有
 * `TypertRemoteService` 这个基类，所以替身只需要它。
 */

/** 与真实基类签名一致的占位实现：宿主半区只用它做 `extends`。 */
export class TypertRemoteService {
  /**
   * @param ctx - 所属 Host 上下文（测试里不会被用到）。
   * @param key - Cordis 服务键。
   */
  constructor(ctx, key) {
    this.ctx = ctx
    this.key = key
  }
}
