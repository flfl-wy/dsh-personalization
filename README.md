# dsh-personalization

在 DeepSeek Harness 的 **Settings** 面板里增加一个「个性化 / Personalization」设置页，目前用于编辑全局 `~/.dsh/AGENTS.md`。

## 它做了什么

| 项目 | 行为 |
|---|---|
| 设置页入口 | 通过 `settings.section` 插槽注册，导航标题「个性化 / Personalization」，`order: 25` |
| 目标文件 | `dshHomePath('AGENTS.md')`，即 `$DSH_HOME/AGENTS.md`，默认 `~/.dsh/AGENTS.md` |
| 读取 | `personalization/read` —— 文件不存在时返回空内容 + `exists: false`，不报错 |
| 保存 | `personalization/save` —— 覆盖前先复制为 `AGENTS.md.bak-YYYYMMDD-HHmmss`，再写入新内容 |
| 历史版本 | `personalization/listVersions` —— 枚举同目录全部 `.bak-*`，新的在前，只返回元数据 |
| 查看版本 | `personalization/readVersion` —— 按 id 取某个备份的完整内容 |
| 回滚 | `personalization/restoreVersion` —— 把某版本写回主文件；**替换前先把当前内容另存为新版本** |
| 删除版本 | `personalization/deleteVersion` —— 只删 `.bak-*`，主文件不受影响 |
| 路径来源 | 完全由宿主解析。客户端只能提交文本或不透明版本 id，两者都不携带路径 |
| 读取失败 | 读取没成功就禁用编辑与保存，避免把文件清空成一个空文档 |

`AGENTS.md` 会被注入每个新会话的系统提示，所以写入通道走的是 DSH 自己的 Typert Remote Gateway（带会话校验），而不是裸 HTTP 路由。

## 历史版本

版本就是保存时留下的时间戳备份，没有额外的索引文件 —— 目录里有什么就是什么，用外部工具删掉也不会让插件错乱。

| 关注点 | 做法 |
|---|---|
| 版本 id | `YYYYMMDD-HHmmss`；同一秒内的第 2、3… 个版本追加 `-2`、`-3` |
| 为什么需要后缀 | 没有它，同一秒内的第二次保存会覆盖上一份备份，历史版本被静默吞掉（`nextBackupPath` 专门规避） |
| id → 路径 | 只经 `versionPathFor()` 一个入口，正则 `^\d{8}-\d{6}(?:-\d+)?$` 保证 id 里不可能出现 `/` 或 `..`，因此客户端无法越出 `$DSH_HOME` |
| 回滚可逆 | 回滚走的是同一条写入路径，所以「回滚前的当前内容」也会被存成一份新版本；回滚动作本身可以再回滚 |
| 删源版本 | 回滚不删除源版本，历史链条保持完整 |
| 符号链接 | `listVersions` 用 `lstat` 只认普通文件；符号链接既不列出，也不能被 `readVersion` / `removeVersion` 操作 |
| 体积上限 | 单个版本超过 `MAX_CONTENT_LENGTH`（1 MiB）时拒绝读取，不把大文件读进内存 |
| 未保存改动 | 编辑器 dirty 时禁用「回滚」——回滚会重新读取主文件，否则会冲掉编辑中的内容（查看与删除不受影响） |
| 二次确认 | 回滚与删除都要行内二次确认；不使用原生 `confirm()`（宿主窗口可能禁用它，且它阻塞） |

投放顺序上也做了取舍：`list` 只返回元数据、内容按 id 单独取，所以几百个版本也不会让列表请求变重。


## 结构

```
lib/index.js       宿主半区：TypertRemoteService('personalization') + ctx.typert.register(MANIFEST)
lib/agents-file.js 纯文件逻辑：读取 / 备份 / 写入 + 历史版本枚举·读取·回滚·删除（无 DSH 运行时依赖，可单独测试）
lib/client.js      浏览器半区：window.__ModuleLoader__.load 懒加载 CJS 束，注册 settings.section
cordis.patch.yml   Bundle patch：把裸包名插入为 Loader 行（客户端半区靠裸包名挂靠）
test/helpers/      客户端束 vm 装载体（含微型 React 运行时）+ 保留名快照与 asar/token 工具
test/fixtures/     dsh-typert-protocol 测试替身（见 manifest-parity 测试的说明）
test/              agents-file 往返测试 + 客户端束契约测试 + 设置页渲染测试 + 跨半区契约测试
```

两端各持一份描述符清单（宿主 `MANIFEST.invocations` / 客户端 `CONTRIBUTION.descriptors`），字段必须一致。客户端束是手写的，不经构建；它只能 `require` 外壳种子词：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`。

这份「必须一致」以前只靠人工纪律维持，现在由 `test/manifest-parity.test.mjs` 断言：两半区的端点集合与每个端点的 `id` / `service` / `namespace` / `method` / receiver kind / 参数 `name`·`wire`·`source` / codec `mode`·`typeSymbol` 必须逐字段相同。它同时按 `dsh-typert-loader` 的 `requireInvocation` 规则校验 `MANIFEST`（端点与 id 不得重复 —— 重复会被整批拒绝），并用真实的 `lib/agents-file.js` 返回值去 parse 每个结果 schema。

## 界面风格（第四个坑：token 名写错不会报错）

设置页的外观按 DSH 原生设置页的规范做，依据全部取自运行时自带源码，不是凭印象调的。要改样式前请看下表，它记录了「为什么是这个值」：

| 项 | 取值 | 依据 |
|---|---|---|
| 页宽 / 纵向节奏 | `max-width:720px` + `gap:12px` + 纵向 flex | `dsh-client-ui-agent-preset` 的 `.section`；外壳的 `.Dws9Sa_options` 已给 `padding:0 24px 24px` 和自己的滚动，所以**束不能再加宽度、居中或左右内边距**，否则会变成 48px |
| 页标题 | 18px / 600 | 同上的 `.title`（外壳 header 只放 `settings.action` 与关闭按钮，标题必须由 section 自绘） |
| 说明文字 | 13px + `--dsw-alias-label-tertiary` | 同上的 `.intro` |
| 输入控件 | `border:.5px` + `radius-md`(12px) + `bg-layer-1`，聚焦改边框色 | `@deepseek-ai/dsh-client-ui-primitives/lib/Input.module.css` 的 `.wrap` / `.wrap:focus-within` |
| 卡片（版本行） | `border:.5px` + `radius-md` + `settings-card-fill/stroke` | 原生 `.card` 用 `settings-card-stroke`（= `border-l4`）；发丝边比 1px 更接近原生 |
| 悬停 / 破坏性 | `interactive-bg-hover` / `state-error-primary` + `interactive-bg-hover-danger` | 前者是原生交互填充；原生 `Button` **没有** danger 变体，破坏性靠颜色而非变体 |
| 排版 / 圆角 / 代码字体 | `--dsw-font-*` 复合值、`--dsw-radius-*`、`--ds-font-family-code` | `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 的 `base_css_default`（共 408 个 token）。`--dsw-font-xs-13` 这类复合值可直接写在 `font:` 上（原生自己也这么用） |
| 相对时间 | `relativeTime()` 只给 `{unit,n}` 分桶，措辞留在本插件的字典 | 原生把「数据分桶」与「文案归属」分开；绝对时间仍由 `formatTime()` 提供给「最后修改」 |
| 体积 | `fileSizeText()` | 原生字节文案（`1.6KB` 这一族） |

**踩过的坑**：CSS 里写错 token 名（例如 `--dsw-alias-label-quaternary`）**不会报错**，`var()` 静默失效、退回继承值 —— 界面照样能渲染，只是不对。所以 `test/client-render.test.mjs` 有一条测试从 asar 里的主题包**重新提取权威 token 名单**，断言束用到的每个 `var(--dsw-*)` / `var(--ds-*)` 都真实存在。

同理，原语（`Button` / `Tag` / `PathLabel` / `relativeTime` / `fileSizeText` / 图标）一个都不能直接 `primitives.X`：束只能拿到种子词导出的名字，名字缺失就是整页白屏。全部经 `pick(name, fallback)` 取，并有一条测试在**原语整个缺席**（`primitives:'none'`）时仍要求整页正常渲染。

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

### 入参与出参的校验边界（`packages/.../dsh-api-gateway/lib/index.js`）

| 环节 | 实际行为 |
|---|---|
| 入参字段集合 | `assertExactArguments()`：`args` 必须是 plain object，字段必须与 descriptor 的 `parameters` **完全一致**；多字段、少字段都报 `gateway/arguments-invalid` |
| 入参取值 | `decode()` 调 `codec.create().parse(value)` —— **zod 真的会跑**，类型不符报 `gateway/input-invalid` |
| 出参 | `encodeRpcResult()` 是 `codec.encode?.(value) ?? value`：本插件的 codec 没定义 `encode`，所以**结果完全不被校验**，只是原样过网 |
| 宿主抛错 | `rpcFailure()` 包成 `{ ok: false, error: { code: 'gateway/internal', message } }`，`message` 直接进界面 |

推论：报错文案来自宿主抛出的 `Error.message`（见 `agents-file.js` 的 `does not exist` 等），所以那里要写人话；而结果形状没有任何运行时兜底，只能靠 `test/manifest-parity.test.mjs` 拿真实返回值去 parse schema。

注意 zod v4 的 `z.object` 默认**剥离**未知字段而不是报错 —— 多字段是被上表的 `assertExactArguments` 挡住的，不是 schema。

### 方法名不能与命名空间服务自身成员重名（第三个坑，真踩过）

`$mount` 会对**每个**方法调 `RemoteNamespaceService.assertMethodAvailable()`：

```js
const REMOTE_NAMESPACE_FIELDS = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace']);

static assertMethodAvailable(namespace, method) {
    if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype) {
        throw new Error(`client api: method ... conflicts with its namespace service`);
    }
}
```

`RemoteNamespaceService` 原型上自带 `assertMethodAvailable` / `empty` / `has` / `installDirect` / `installScoped` / `install` / **`remove`**；它又 `extends Service`（cordis），继承了 `ctx` / `name` / `init` / `check` / `config` / `invoke` / `extend` / `tracker` / `resolveConfig`。

| 要点 | 说明 |
|---|---|
| 后果是**整组回滚** | `installMethods()` 捕获异常后回滚整组，所以一个名字撞车不是只废掉那一个方法，而是**六个方法全部装不上**，设置页只剩一行「远程服务未就绪」 |
| 宿主侧不报错 | 宿主 registry（`dsh-typert-registry`）只拒绝重复端点 / 重复 id / 重复包，**没有**保留名校验，所以它照样注册成功。现象是「宿主正常但界面全废」，很难往命名上想 |
| 因此的命名 | 历史版本的四个方法统一带 `Version(s)` 前缀：`listVersions` / `readVersion` / `restoreVersion` / `deleteVersion`。删除**不能**叫 `remove` |
| 守护 | `test/helpers/gateway-reserved-names.mjs` 保存保留名快照，假网关按真实规则拒绝撞名方法；`test/manifest-parity.test.mjs` 另有一条测试在本机装了 DSH 时**直接从 asar 源码重新推导保留名**并比对快照，避免框架升级后快照悄悄过期 |


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
pnpm test          # node --test test/agents-file.test.mjs test/client-bundle.test.mjs test/client-render.test.mjs test/manifest-parity.test.mjs
```

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `test/agents-file.test.mjs` | 24 | 把 `DSH_HOME` 指向临时目录：主文件往返、同上不覆盖、同一秒冲突改名、id 解析与越界拒绝、`listVersions` 排序与跳过符号链接、`readVersion` 超限拒绝、回滚可逆、删除只动备份。**不碰真实 `~/.dsh/AGENTS.md`。** |
| `test/client-bundle.test.mjs` | 8 | 用假 `window.__ModuleLoader__` 与假种子词求值客户端束：导出的 `apply` / `inject`、`settings.section` 注册参数、六端点描述符形状、locale 字典与 `t()` 双向覆盖、六个方法引用稳定性与载荷透传、`$mount` 失败降级、命名空间必须走 `ctx.get("remote.<name>")` 的回归测试 |
| `test/client-render.test.mjs` | 10 | 用装载体里的**微型 React 运行时**把设置页真正渲染出来：标题/说明/编辑器/状态行的原生结构、时间走 `relativeTime`、体积走 `fileSizeText`、id 走 `Tag`、三个操作按钮带原生图标、**原语整个缺席时仍能渲染**（兜底文案与 `<button>`）、dirty 时回滚禁用而保存可用、破坏性操作的行内二次确认（取消可退回、确认前不发远程调用）、远程未就绪时全按钮禁用、**样式引用的 token 在主题包里真实存在**、不写死颜色与字体栈且不重复外壳内边距、类名与样式双向一致（无死样式） |
| `test/manifest-parity.test.mjs` | 5 | 宿主 `MANIFEST` 满足 `dsh-typert-loader` 规则、方法名不撞命名空间服务保留名、保留名快照与 DSH 自带源码一致、两半区描述符逐字段一致、结果 schema 能 parse `agents-file.js` 的真实返回值 |

合计 47 项。

两个 helper 支撑上面这些用例：

| helper | 作用 |
|---|---|
| `test/helpers/client-bundle-harness.mjs` | 在隔离 vm 里求值客户端束，并提供**按真实规则校验**的假 `$mount`（保留名、strict codec、端点不重复），任何一条不过都像真网关那样拒绝挂载 |
| `test/helpers/gateway-reserved-names.mjs` | 命名空间服务保留名快照 + `assertMethodAvailable`，以及从 DSH 的 `app.asar` **重新推导**保留名的函数 |
| `test/helpers/asar.mjs` | 读 `app.asar` 内单文件的最小工具（`openAsar` / `DSH_ASAR_PATH`），上面两个 helper 共用 |
| `test/helpers/theme-tokens.mjs` | 从主题包**重新提取**权威设计 token 名单（`themeTokenNames()`）。主题包的 CSS 是 JS 字符串字面量且字体名带转义引号，必须按 JS 字符串规则扫描，简单的 `"[^"]*"` 正则会静默漏掉大量 token |

`manifest-parity` 需要一个 `@deepseek-ai/dsh-typert-protocol` 替身才能 import 宿主半区（真实包 import 了本插件故意不装的 cordis），用 `node:module` 的 `registerHooks` 把该 specifier 重定向到 `test/fixtures/typert-protocol-stub.mjs`。本机没装 DSH 时，「保留名快照与源码一致」与「token 真实存在」这两条会自动 skip。

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
2. 设置面板里应出现「个性化」，能读到 `~/.dsh/AGENTS.md` 现状，下方能看到「历史版本」列表（本机当时 4 份备份，最新一份 1635 字节）。
3. 改一行保存，检查同目录出现 `AGENTS.md.bak-<YYYYMMDD-HHmmss>`，且其内容等于改动前那一版；历史列表应立刻多出一行。
4. 点某行的「查看」应展开该版本内容；「删除」应经过二次确认后只删掉 `.bak-*`。

宿主半区的纯逻辑可以脱离 DSH 单独验证（用 `DSH_HOME` 指向临时目录，不碰真实文件）：

```sh
cd ~/Documents/deepseek-harness/dsh-personalization
DSH_HOME=/tmp/dsp-check node -e '
  const m = await import("./lib/agents-file.js");
  console.log(m.agentsFile());
  console.log(m.backupPathFor("/tmp/a/AGENTS.md", new Date(2026, 9, 10, 8, 53, 10)));
'
```

只读地看一眼真实环境的历史版本（`listVersions` 只做 `readdir` / `lstat`，不改任何文件）：

```sh
cd ~/Documents/deepseek-harness/dsh-personalization
node -e '
  const m = await import("./lib/agents-file.js");
  console.log(JSON.stringify(await m.listVersions(), null, 2));
'
```

## 已知限制

- 只编辑全局 AGENTS.md；项目级 `<workspace>/AGENTS.md` 尚未接入。
- 页面只做「读取 / 编辑 / 保存 + 历史版本（查看 / 回滚 / 删除）」。版本间 diff、另存为、字数统计、清空全部历史尚未提供。
- 历史版本**没有自动上限**，也不会自动清理；长期使用请用「删除」手动收拾。
- 回滚没有 diff 预览：确认框只给出时间与 id，用户看不到内容差异（可以先「查看」再决定）。
- 保存与回滚都没有并发保护：两个窗口同时操作时，后写入的覆盖先写入的。`nextBackupPath` 的「查名字 → 复制」之间也有极窄的竞态窗口，理论上同一秒内两个进程可能撞名。
- `lib/client.js` 是手写束，没有 TS 类型检查，靠三个测试文件与真实运行兜底。
