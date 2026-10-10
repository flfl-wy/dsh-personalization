/**
 * 远程方法名的**保留名**规则 —— 这条规则来自真实网关源码，不是我们的约定。
 *
 * `@deepseek-ai/dsh-api-gateway/lib/client.js`：
 *
 *   const REMOTE_NAMESPACE_FIELDS = new Set(['ctx','empty','invokeRemote','methods','name','namespace'])
 *
 *   class RemoteNamespaceService extends Service {
 *     static assertMethodAvailable(namespace, method) {
 *       if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype) {
 *         throw new Error(`client api: method ... conflicts with its namespace service`)
 *       }
 *     }
 *     install(method, kind, value) { this.assertMethodAvailable(method); ... }
 *   }
 *
 * 也就是说：远程方法名不得与**命名空间服务自己已有的成员**同名。`RemoteNamespaceService`
 * 原型上自带 `assertMethodAvailable` / `empty` / `has` / `installDirect` / `installScoped`
 * / `install` / `remove`，并且它 `extends Service`（`@deepseek-ai/cordis`），又继承
 * `ctx` / `name` / `init` / `check` / `config` / `invoke` / `extend` / `tracker`
 * / `resolveConfig`。
 *
 * 后果特别难看：`installMethods()` 捕获异常后**整组回滚**，所以一个名字撞车不是只废掉
 * 那一个方法，而是整个命名空间的六个方法都装不上，界面上只剩一行「远程服务未就绪」。
 *
 * 这个坑真踩过：删除历史版本的方法曾命名为 `remove`，与原型上的 `remove(kind, method,
 * token)` 冲突，把 `read` / `save` 一起带崩。
 */

import { DSH_ASAR_PATH, openAsar } from './asar.mjs'

/**
 * 保留名快照。取值方式见 `deriveReservedNamesFromAsar` —— 本机可以从 DSH 自带的真实源码
 * 重新推导，`test/manifest-parity.test.mjs` 里有一条测试负责比对两者是否仍然一致，
 * 这样框架升级新增成员时快照不会悄悄过期。
 */
export const RESERVED_NAMESPACE_METHODS = new Set([
    // REMOTE_NAMESPACE_FIELDS
    'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
    // RemoteNamespaceService.prototype
    'constructor', 'assertMethodAvailable', 'has', 'installDirect', 'installScoped', 'install', 'remove',
    // cordis Service
    'init', 'check', 'config', 'invoke', 'extend', 'tracker', 'resolveConfig',
])

/** DSH 的安装位置；不存在时「快照是否过期」那条测试会跳过。 */
export { DSH_ASAR_PATH }

/**
 * 照抄真实网关的 `assertMethodAvailable`。
 * @param namespace - 远程命名空间名。
 * @param method - 声明的方法名。
 */
export function assertMethodAvailable(namespace, method) {
    if (RESERVED_NAMESPACE_METHODS.has(method)) {
        throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`)
    }
}

/** 取一个类体的源码片段（到下一个顶层 class/var 为止）。 */
function sliceClass(source, marker) {
    const start = source.indexOf(marker)
    if (start === -1) throw new Error(`在源码里找不到 ${marker}`)
    const next = source.indexOf('\nclass ', start + marker.length)
    return source.slice(start, next === -1 ? undefined : next)
}

/** 按正则取出成员名。 */
const membersOf = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1])

/**
 * 从 DSH 自带源码重新推导保留名，用来检查上面的快照有没有因框架升级而过期。
 *
 * 注意这里是**近似解析**（正则扫类体），`catch` / `if` / `for` 这类方法体内的关键字会被
 * 误当成成员名。多出来只会让判定更保守，不影响「快照是否覆盖了真实保留名」的结论，
 * 所以比对时只检查推导集是否被快照包含。
 *
 * @param archive - `app.asar` 路径。
 * @returns 推导出的保留名集合。
 */
export function deriveReservedNamesFromAsar(archive) {
    const asar = openAsar(archive)
    try {
        const gateway = asar.read('dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js')
        const cordis = asar.read('dsh/node_modules/@deepseek-ai/cordis/lib/index.js')

        const fields = gateway.match(/const REMOTE_NAMESPACE_FIELDS = new Set\(\[([^\]]*)\]\)/)
        if (fields === null) throw new Error('在网关源码里找不到 REMOTE_NAMESPACE_FIELDS')

        return new Set([
            ...fields[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
            'constructor',
            ...membersOf(sliceClass(gateway, 'class RemoteNamespaceService'), /^ {4}(?:get |set |async )?(?:static )?([A-Za-z_$][\w$]*)\s*\(/gm),
            ...membersOf(sliceClass(cordis, 'var Service = class Service'), /^\t(?:static )?([A-Za-z_$][\w$]*)\s*[=;(]/gm),
            ...membersOf(sliceClass(cordis, 'var Service = class Service'), /^\t(?:async )?(?:static )?(?:get |set )?([A-Za-z_$][\w$]*)\s*\(/gm),
        ])
    } finally {
        asar.close()
    }
}
