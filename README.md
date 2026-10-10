# dsh-personalization

在 DeepSeek Harness 的 **Settings** 面板里增加一个「个性化 / Personalization」设置页，目前用于编辑全局 `~/.dsh/AGENTS.md`。

## 它做了什么

| 项目 | 行为 |
|---|---|
| 设置页入口 | 通过 `settings.section` 插槽注册，导航标题「个性化 / Personalization」，`order: 25` |
| 目标文件 | `dshHomePath('AGENTS.md')`，即 `$DSH_HOME/AGENTS.md`，默认 `~/.dsh/AGENTS.md` |
| 读取 | `personalization/read` —— 文件不存在时返回空内容 + `exists: false`，不报错 |
| 保存 | `personalization/save` —— 覆盖前先复制为 `AGENTS.md.bak-YYYYMMDD-HHmmss`，再写入新内容 |
| 路径来源 | 完全由宿主解析。客户端只能提交文本、不能提交路径，因此这个页面永远只改这一个文件 |
| 读取失败 | 读取没成功就禁用编辑与保存，避免把文件清空成一个空文档 |

`AGENTS.md` 会被注入每个新会话的系统提示，所以写入通道走的是 DSH 自己的 Typert Remote Gateway（带会话校验），而不是裸 HTTP 路由。

## 结构

```
lib/index.js       宿主半区：TypertRemoteService('personalization') + ctx.typert.register(MANIFEST)
lib/agents-file.js 纯文件逻辑：读取 / 备份 / 写入（无 DSH 运行时依赖，可单独测试）
lib/client.js      浏览器半区：window.__ModuleLoader__.load 懒加载 CJS 束，注册 settings.section
cordis.patch.yml   Bundle patch：把裸包名插入为 Loader 行（客户端半区靠裸包名挂靠）
test/              agents-file 往返测试 + 客户端束契约测试
```

两端各持一份描述符清单（宿主 `MANIFEST.invocations` / 客户端 `CONTRIBUTION.descriptors`），字段必须一致。客户端束是手写的，不经构建；它只能 `require` 外壳种子词：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`。

## 依赖设计（关键，改之前先读）

这个插件以**软链接（linked root）**形式装进 profile：`<profile>/node_modules/dsh-personalization` 指向本目录。DSH 的运行时解析对 linked root 有一套专门的规则（`packages/boot/app-boot/src/profile-resolution/resolver.ts` 的 `routeLinked`）：

| 包的位置 | 解析结果 |
|---|---|
| 出现在插件 `peerDependencies` 里的名字 | 走拦截层，用**运行中 DSH 安装自己的那份** |
| 其它名字 | 走 Node 原生祖先链，即**插件目录自己的 `node_modules`** |

推论：
- `@deepseek-ai/dsh-typert-protocol` 同时写进 `dependencies`（本地有一份兜底）和 `peerDependencies`（有 entry 时优先用运行时那份，协议版本与运行时一致）。
- `.npmrc` / `pnpm-workspace.yaml` 里必须 `auto-install-peers=false`。否则 pnpm 会给 `dsh-typert-protocol` 装一份**本地 cordis**，那就是第二个 cordis 实例，`Service` 注册会坏。

`dsh-typert-protocol` 自己 import `@deepseek-ai/cordis`，而它自己的 `peerDependencies` 里就有 cordis，所以 linked root 的 peer 映射会把运行时的 cordis 交给它——不需要本插件再声明 cordis。

### 版本兼容闸门（很容易踩）

`evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`）会拿插件的 `peerDependencies` 去比 **DSH 运行时版本**（本机为 `0.2.0-rc.2`）：

- 只检查名字等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer。
- 比较是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` —— **不是**拿 range 去比那个包自己的版本。

所以 `"@deepseek-ai/dsh-typert-protocol": "^0.1.0-rc.6"` 会被读成「本插件要求 dsh 是 0.1.x」，在 0.2.0-rc.2 上被判为 `incompatible-version`，整条 bundle 被拒、`rows` 为空。正确写法是让范围覆盖运行时版本（如 `>=0.1.5-rc.0 <0.3.0-0`），或干脆把包放进 `dependencies`。

被拒时 `dsh-personalization` 会出现在插件管理器的 bundle 列表里，带 `error.code = "incompatible-version"` 且 `rows: []`。**不要**用 `set_version_exemption` 绕过——把范围改对才是正解。

## 远程调用契约（第二个容易踩的坑）

`ctx.remote.$mount(CONTRIBUTION)` **不是**把命名空间挂成 remote 对象上的属性。看源码 `@deepseek-ai/dsh-api-gateway/lib/client.js`：

```js
function remoteServiceKey(namespace) { return `remote.${namespace}`; }
```

命名空间是一个 **Cordis 服务**，键名 `remote.<namespace>`，且在 `$mount` 完成前不存在。正确写法：

```js
const mounted = ctx.remote.$mount(CONTRIBUTION);   // 先拿 promise
// 每次调用重新取，连接重置后不会拿到失效引用
const read = async () => { await mounted; return ctx.get("remote.personalization").read(); };
```

错误写法 `remote[namespace]` 恒为 `undefined`，界面只显示「远程服务未就绪」，而且**宿主侧没有任何报错**——因为 `$mount` 本身是成功的。`test/client-bundle.test.mjs` 有一条回归测试盯住这点：假 `ctx.get` 严格按 `remote.<namespace>` 实现，remote 对象上故意不挂同名属性。

方法返回值是 `RemoteResult`：`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`，调用方必须自己判 `ok`。

### 改动怎么生效

| 半区 | 生效方式 |
|---|---|
| 宿主 `lib/index.js` | 启动时组装，或由 `plugin_manager` 的 `set_bundle` 触发 reload。注意软链接插件**首次**加入时 resolver 路由表已在启动时冻结，那次 live reload 会报 `failed to import`；重启后同一调用即 `applied` |
| 客户端 `lib/client.js` | `@deepseek-ai/dsh-client-hmr` 每 500ms stat 轮询所有 client bundle，改动即调 `clientModules.rebuilt(id)` 并经 SSE 推送，浏览器热替换。保险起见刷新一次页面 |

服务端产物是否已带上改动，可以直接查：

```sh
curl -s --max-time 3 http://127.0.0.1:19387/plugins/events | head -c 300   # 取 graph 与各 bundle 的 rev
curl -s "http://127.0.0.1:19387/plugins/??dsh-personalization/client.js&rev=<rev>" | grep -c REMOTE_SERVICE_KEY
```

## 测试

```sh
cd ~/Documents/deepseek-harness/dsh-personalization
pnpm test          # 等价于 node --test test/agents-file.test.mjs test/client-bundle.test.mjs
```

- `test/agents-file.test.mjs`：把 `DSH_HOME` 指向临时目录，覆盖「首次写入不备份 / 二次写入先备份 / 备份内容等于上一版 / 超长被拒且不落盘 / 非字符串被拒」等 8 项。**不碰真实 `~/.dsh/AGENTS.md`。**
- `test/client-bundle.test.mjs`：6 项。用假 `window.__ModuleLoader__` 与假种子词求值客户端束，验证导出的 `apply` / `inject`、`settings.section` 注册参数、`read`/`save` 引用稳定性、`$mount` 失败时降级为页面内错误，以及命名空间必须走 `ctx.get("remote.<name>")` 的回归测试。

合计 14 项。

## 安装

```sh
# 1. 备份 profile 配置
cd ~/.dsh/profiles/desktop
STAMP=$(date +%Y%m%d-%H%M%S)
cp package.json "package.json.bak-$STAMP"
cp cordis.patch.yml "cordis.patch.yml.bak-$STAMP"
cp pnpm-lock.yaml "pnpm-lock.yaml.bak-$STAMP"

# 2. 以软链接装入（改源码即生效，只需重新安装依赖）
pnpm add "dsh-personalization@link:$HOME/Documents/deepseek-harness/dsh-personalization"

# 3. 在 package.json 的 dsh.profile.bundles 里追加 "dsh-personalization"
```

装完**重启 DeepSeek Harness**：宿主半区在启动时挂载，客户端束由宿主在扫描 Loader 行后提供给页面。客户端 HMR 不能代替这一步——新行不在启动时组装的树里。

## 验证

装好重启后：

1. 插件管理器的 bundle 列表里，`dsh-personalization` 的 `rows[0]` 应带上 `entryId`（形如 `include:personalization`）。`entryId` 只在**行已进入运行中的 Loader** 时才出现，没有它就说明还没重启。
2. 设置面板里应出现「个性化」，能读到 `~/.dsh/AGENTS.md` 现状（本机 1635 字节）。
3. 改一行保存，检查同目录出现 `AGENTS.md.bak-<YYYYMMDD-HHmmss>`，且其内容等于改动前那一版。

宿主半区的纯逻辑可以脱离 DSH 单独验证（用 `DSH_HOME` 指向临时目录，不碰真实文件）：

```sh
cd ~/Documents/deepseek-harness/dsh-personalization
DSH_HOME=/tmp/dsp-check node -e '
  const m = await import("./lib/agents-file.js");
  console.log(m.agentsFile());
  console.log(m.backupPathFor("/tmp/a/AGENTS.md", new Date(2026, 9, 10, 8, 53, 10)));
'
```

## 已知限制

- 只编辑全局 AGENTS.md；项目级 `<workspace>/AGENTS.md` 尚未接入。
- 页面只做「读取 / 编辑 / 保存 + 保存前备份」。恢复某个备份、另存为、字数统计等尚未提供。
- 保存没有并发保护：两个窗口同时编辑时，后保存的覆盖先保存的。
- `lib/client.js` 是手写束，没有 TS 类型检查，靠 `test/client-bundle.test.mjs` 与真实运行兜底。
