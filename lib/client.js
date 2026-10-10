/**
 * dsh-personalization —— 浏览器半区（客户端束）。
 *
 * 这份文件是宿主直接提供的模块：宿主以 `/plugins/dsh-personalization/client.js`
 * 提供它。它在 Settings 面板注册「个性化」设置页，通过 Typert Remote 命名空间
 * `personalization` 读写全局 AGENTS.md，并管理历史版本（查看 / 回滚 / 删除）。
 *
 * **只 require `react`。** 不要 require `@deepseek-ai/dsh-client-ui-primitives` 或任何
 * 其它 Harness Client 包 —— DSH 自带的插件开发指南明确禁止
 * （`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` 的 UI 段）：
 * 那些包会无预警变更，纯 JS 插件没有类型检查，一个抛错的组件会让整个 slot 条目变空白。
 * 正确做法是把原语的 markup 与 CSS 抄进插件、类名改到自己的前缀下、只保留
 * `--dsw-alias-*` token 引用 —— 本文件里的 `Button` / `Toast` 就是这么来的。
 *
 * 所有可见文案都走宿主 locale 服务（`NS` 命名空间），样式只用 `--dsw-*` / `--ds-*` token。
 */
window.__ModuleLoader__.load({
    id: "dsh-personalization",
    factory: (require) => {
        const bundleModule = { exports: {} };
        Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: "Module" });

        const React = require("react");
        const h = React.createElement;

        const NS = "dsh-personalization";
        const SECTION_ID = "personalization";
        const SERVICE_KEY = "personalization";
        /** api-gateway 把命名空间注册成名为 `remote.<namespace>` 的 Cordis 服务，不是 remote 上的属性。 */
        const REMOTE_SERVICE_KEY = "remote." + SERVICE_KEY;
        const inject = ["slots", "locale", "remote"];

        /** 设置页文案。key 为宿主 locale 的语言 id。 */
        const zh = {
            nav: "个性化",
            title: "个性化",
            intro: "这里编辑全局 AGENTS.md。它作为个人偏好，在每个新会话开始时注入系统提示，对所有工作区生效。",
            editorLabel: "全局 AGENTS.md 内容",
            fileLabel: "文件",
            charsLabel: "字符",
            modifiedLabel: "最后修改",
            reload: "重新加载",
            save: "保存",
            saving: "保存中…",
            loading: "正在读取…",
            dirty: "有未保存的改动",
            clean: "已是最新",
            missing: "文件不存在，保存后会创建",
            savedPlain: "已保存。",
            savedWithBackup: "已保存。上一版已备份为：",
            lastBackup: "上一版备份：",
            loadFailed: "读取失败：",
            saveFailed: "保存失败：",
            unavailable: "远程服务未就绪，无法读写 AGENTS.md。",
            historyTitle: "历史版本",
            historyCountLabel: "个版本",
            historyReload: "刷新列表",
            historyLoading: "正在读取历史版本…",
            historyEmpty: "还没有历史版本。每次保存都会自动留下一份。",
            historyHint: "回滚会把当前内容替换成该版本，并先把当前内容另存为一份新版本，所以回滚本身也可以再回滚。",
            historyDirtyBlock: "编辑器里有未保存的改动，此时不能回滚 —— 回滚会重新读取文件，把编辑中的内容冲掉。请先保存或重新加载。",
            historyLoadFailed: "历史版本读取失败：",
            historyActionFailed: "历史版本操作失败：",
            historyView: "查看",
            historyHide: "收起",
            historyRestore: "回滚",
            historyRemove: "删除",
            historyConfirmRestore: "确认回滚",
            historyConfirmRemove: "确认删除",
            historyCancel: "取消",
            historyRestoreDone: "已回滚到这个版本：",
            historyRemoveDone: "已删除这个版本：",
        };
        const en = {
            nav: "Personalization",
            title: "Personalization",
            intro: "Edit the global AGENTS.md here. It is injected into the system prompt of every new session as your personal preferences, and applies to all workspaces.",
            editorLabel: "Global AGENTS.md contents",
            fileLabel: "File",
            charsLabel: "characters",
            modifiedLabel: "Last modified",
            reload: "Reload",
            save: "Save",
            saving: "Saving…",
            loading: "Reading…",
            dirty: "Unsaved changes",
            clean: "Up to date",
            missing: "File does not exist yet; saving creates it",
            savedPlain: "Saved.",
            savedWithBackup: "Saved. Previous revision backed up to: ",
            lastBackup: "Previous revision backed up to: ",
            loadFailed: "Could not read the file: ",
            saveFailed: "Could not save the file: ",
            unavailable: "The remote service is not ready, so AGENTS.md cannot be read or written.",
            historyTitle: "History",
            historyCountLabel: "version(s)",
            historyReload: "Refresh list",
            historyLoading: "Reading the version history…",
            historyEmpty: "No history yet. Every save leaves one behind.",
            historyHint: "Rolling back replaces the current contents with that version and first saves the current contents as a new version, so a rollback can itself be rolled back.",
            historyDirtyBlock: "There are unsaved edits in the editor, so rolling back is disabled — it re-reads the file and would discard them. Save or reload first.",
            historyLoadFailed: "Could not read the version history: ",
            historyActionFailed: "The history action failed: ",
            historyView: "View",
            historyHide: "Hide",
            historyRestore: "Roll back",
            historyRemove: "Delete",
            historyConfirmRestore: "Confirm rollback",
            historyConfirmRemove: "Confirm delete",
            historyCancel: "Cancel",
            historyRestoreDone: "Rolled back to version: ",
            historyRemoveDone: "Deleted version: ",
        };

        /**
         * 客户端 strict codec：校验由宿主 manifest 承担，这里只做直通。
         * 同一对象同时携带两代契约（`schema` / `create`），与宿主侧保持一致。
         */
        const identitySchema = { parse: (value) => value };
        const codec = (typeSymbol) => ({
            mode: "strict",
            typeSymbol,
            schema: identitySchema,
            create: () => identitySchema,
        });

        /**
         * 收一个 `{ id }` 载荷的方法描述符；与宿主 `versionInvocation` 逐字段对应。
         *
         * `method` 只能取 `readVersion` / `restoreVersion` / `deleteVersion` 这一类带
         * `Version` 前缀的名字：`$mount` 会对每个方法调 `assertMethodAvailable`，凡是与
         * 命名空间服务自身成员（`remove` / `install` / `has` / `empty` …）同名的都直接抛错，
         * 而且 `installMethods` 是整组回滚 —— 一个名字撞车，六个方法全装不上，页面只剩
         * 「远程服务未就绪」。删除历史版本因此叫 `deleteVersion` 而不是 `remove`。
         */
        const versionDescriptor = (method, resultName) => ({
            id: `${NS}#personalization/${method}`,
            service: SERVICE_KEY,
            namespace: SERVICE_KEY,
            method,
            invocation: { kind: "direct" },
            parameters: [
                {
                    name: "payload",
                    wire: "payload",
                    source: "json",
                    codec: codec(`${NS}#VersionPayload`),
                },
            ],
            result: codec(`${NS}#${resultName}`),
        });

        /** 消费者侧描述符，必须与宿主 `lib/index.js` 的 MANIFEST.invocations 逐字段一致。 */
        const CONTRIBUTION = {
            package: NS,
            descriptors: [
                {
                    id: `${NS}#personalization/read`,
                    service: SERVICE_KEY,
                    namespace: SERVICE_KEY,
                    method: "read",
                    invocation: { kind: "direct" },
                    parameters: [],
                    result: codec(`${NS}#ReadResult`),
                },
                {
                    id: `${NS}#personalization/save`,
                    service: SERVICE_KEY,
                    namespace: SERVICE_KEY,
                    method: "save",
                    invocation: { kind: "direct" },
                    parameters: [
                        {
                            name: "payload",
                            wire: "payload",
                            source: "json",
                            codec: codec(`${NS}#SavePayload`),
                        },
                    ],
                    result: codec(`${NS}#SaveResult`),
                },
                {
                    id: `${NS}#personalization/listVersions`,
                    service: SERVICE_KEY,
                    namespace: SERVICE_KEY,
                    method: "listVersions",
                    invocation: { kind: "direct" },
                    parameters: [],
                    result: codec(`${NS}#ListResult`),
                },
                versionDescriptor("readVersion", "VersionDetail"),
                versionDescriptor("restoreVersion", "RestoreResult"),
                versionDescriptor("deleteVersion", "RemoveResult"),
            ],
        };

        const STYLE = [
            ".dsp-root{box-sizing:border-box;min-width:0;width:min(100%,760px);margin:0 auto;padding:0 0 32px;color:var(--dsw-alias-label-primary)}",
            ".dsp-header{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}",
            ".dsp-title{margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px}",
            ".dsp-intro{margin:0;max-width:46em;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}",
            ".dsp-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
            ".dsp-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}",
            ".dsp-editor{box-sizing:border-box;display:block;width:100%;min-height:360px;padding:12px 14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:20px;tab-size:2;resize:vertical}",
            ".dsp-editor:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
            ".dsp-editor:disabled{opacity:.6}",
            ".dsp-footer{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:12px}",
            ".dsp-status{flex:1 1 200px;min-width:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}",
            ".dsp-actions{display:flex;align-items:center;gap:8px;margin-left:auto}",
            ".dsp-muted{color:var(--dsw-alias-label-secondary)}",
            ".dsp-error{color:var(--dsw-alias-state-error-primary)}",
            ".dsp-ok{color:var(--dsw-alias-state-success-primary)}",
            ".dsp-dirty{color:var(--dsw-alias-state-warn-primary)}",
            ".dsp-history{margin-top:28px;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2)}",
            ".dsp-history-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:8px}",
            ".dsp-history-title{margin:0;font-size:15px;line-height:22px;font-weight:600}",
            ".dsp-history-head-actions{display:flex;align-items:center;gap:8px;margin-left:auto}",
            ".dsp-history-hint{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}",
            ".dsp-history-note{margin:0 0 12px;font-size:12px;line-height:18px;overflow-wrap:anywhere}",
            ".dsp-versions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
            ".dsp-version{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}",
            ".dsp-version-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}",
            ".dsp-version-time{font-size:13px;line-height:20px}",
            ".dsp-version-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}",
            ".dsp-version-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto}",
            ".dsp-version-content{margin:8px 0 0;padding:10px 12px;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}",
                    // ---- 以下按钮 / 提示样式抄自 @deepseek-ai/dsh-client-ui-primitives 的
            // Button.module.css 与 Toast.module.css（官方指南要求：类名改到自己的
            // 前缀下、只保留 --dsw-* token、行为保持一致），不是 require 那个包。----
            ".dsp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}",
            ".dsp-btn:disabled{cursor:not-allowed;opacity:.4}",
            ".dsp-btn--md{height:36px}",
            ".dsp-btn--sm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}",
            ".dsp-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
            ".dsp-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
            ".dsp-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
            ".dsp-btn--ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}",
            ".dsp-btn--outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}",
            ".dsp-btn--outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
            ".dsp-btn--toolbar{background:var(--dsw-alias-button-tool-bar-fill)}",
            ".dsp-btn--toolbar:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover)}",
            // 破坏性：设计系统只给了这三个 alias token，不自己发明颜色。
            // 必须排在 `.dsp-btn` 基础规则**之后** —— 同为单类选择器，靠后者胜出；
            // 放前面会被 `.dsp-btn{color/background}` 静默覆盖掉（踩过）。
            ".dsp-btn--danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}",
            ".dsp-btn--danger:hover:not(:disabled){background:var(--dsw-alias-state-error-secondary)}",
            ".dsp-danger{color:var(--dsw-alias-state-error-primary)}",
            ".dsp-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
            ".dsp-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);transform:translateX(-50%);animation:dsp-toast-in 160ms ease-out,dsp-toast-fade 1000ms ease var(--dsp-toast-hold,3000ms) forwards}",
            "@keyframes dsp-toast-in{from{opacity:0;transform:translateX(-50%) translateY(-6px)}to{opacity:1;transform:translateX(-50%)}}",
            "@keyframes dsp-toast-fade{to{opacity:0}}",
].join("");

        /** 把束自带样式挂进文档；返回移除函数。重复 apply 不会叠加第二份。 */
        function insertStyles() {
            const tagId = `${NS}/personalization.css`;
            const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`);
            if (existing !== null) return () => {};
            const tag = document.createElement("style");
            tag.dataset.plugin = NS;
            tag.dataset.pluginCss = tagId;
            tag.textContent = STYLE;
            document.head.appendChild(tag);
            return () => { tag.remove(); };
        }

        /** 时间戳 -> 本地可读文本；0 或非法值显示占位符。 */
        function formatTime(ms) {
            if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
            try {
                return new Date(ms).toLocaleString();
            } catch {
                return String(ms);
            }
        }

        /** 把 RemoteResult 的失败或异常统一成一行可读文本。 */
        function messageOf(result, cause) {
            if (result !== undefined && result !== null && result.ok === false) {
                return result.error === undefined || result.error === null ? "unknown error" : String(result.error.message);
            }
            return cause instanceof Error ? cause.message : String(cause);
        }

        /**
         * 按钮：**抄自** `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`，不是 require 它。
         *
         * 类名从原生的 `.button` / `.md` / `.outline` … 改到 `dsp-btn` 前缀（官方指南要求），
         * 取值、变体、hover/disabled 行为与原生逐一对应，因此外观与原生产出一致：
         *   - 不传 size -> `dsp-btn--md`：36px 高、`radius-md` 12px、14px/22px、padding 0 14px
         *   - `size="sm"` -> `dsp-btn--sm`：28px 高、`radius-sm` 8px、12px/18px
         * 类名写成字面量常量，好让「样式类名与渲染代码双向一致」那条测试仍能覆盖它们。
         */
        const BUTTON_TONE_CLASS = {
            ghost: "dsp-btn--ghost",
            outline: "dsp-btn--outline",
            primary: "dsp-btn--primary",
            toolbar: "dsp-btn--toolbar",
            // 设计系统没有 danger 按钮的填充/hover 配对，只有这三个 alias token，
            // 所以破坏性按钮就建立在它们之上（不自己发明颜色）。
            danger: "dsp-btn--danger",
        };
        const BUTTON_SIZE_CLASS = { md: "dsp-btn--md", sm: "dsp-btn--sm" };

        function Button({ variant = "ghost", size = "md", className, children, ...rest }) {
            const classes = ["dsp-btn", BUTTON_TONE_CLASS[variant] ?? BUTTON_TONE_CLASS.ghost, BUTTON_SIZE_CLASS[size] ?? BUTTON_SIZE_CLASS.md];
            if (className !== undefined && className !== null && className !== "") classes.push(className);
            return h("button", { type: "button", className: classes.join(" "), ...rest }, children);
        }

        /** Toast 的停留与淡出时长；两者相加才是卸载时刻（同原生）。 */
        const TOAST_HOLD_MS = 3000;
        const TOAST_FADE_MS = 1000;

        /**
         * 一次性的顶部提示：**抄自**原语 `Toast` 的表面与生命周期，不走 portal
         * （官方指南禁止往 `document.body` 之外写 DOM；`position:fixed` 已足够）。
         * 动画时长由 `--dsp-toast-hold` 驱动，和上面的卸载计时同源。
         */
        function Toast({ text, tone = "info", holdMs = TOAST_HOLD_MS, onDone }) {
            React.useEffect(() => {
                const timer = setTimeout(() => { onDone(); }, holdMs + TOAST_FADE_MS);
                return () => { clearTimeout(timer); };
            }, [holdMs]);
            return h("div", {
                className: "dsp-toast",
                role: "alert",
                "data-toast": tone,
                style: { "--dsp-toast-hold": `${holdMs}ms` },
            }, text);
        }

        /**
         * 「个性化」设置页：加载 / 编辑 / 保存全局 AGENTS.md，并管理历史版本。
         * props 来自 registration 的 inject 面（以及 settings.section 的 owner 数据，忽略）。
         */
        function PersonalizationSection(props) {
            const { t, read, save, listVersions, readVersion, restoreVersion, deleteVersion, remoteError } = props;
            const [content, setContent] = React.useState("");
            const [baseline, setBaseline] = React.useState("");
            const [info, setInfo] = React.useState({ path: "", exists: false, mtimeMs: 0 });
            /** 只有读取成功后才认为 content 具有权威性 —— 否则保存会把文件清空。 */
            const [loaded, setLoaded] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState(remoteError === null ? null : { kind: "load", message: remoteError });
            const [lastBackup, setLastBackup] = React.useState(null);
            const [toast, setToast] = React.useState(null);

            /** 历史版本：列表只含元数据，内容在「查看」时按 id 单独取。 */
            const [versions, setVersions] = React.useState([]);
            const [versionsBusy, setVersionsBusy] = React.useState(false);
            const [versionsError, setVersionsError] = React.useState(null);
            /** `{ id, content }`；content 为 null 表示正在读取。 */
            const [viewing, setViewing] = React.useState(null);
            /** 待二次确认的破坏性操作：`{ id, action }`。 */
            const [confirming, setConfirming] = React.useState(null);
            /** 正在执行行内操作的版本 id。 */
            const [rowBusy, setRowBusy] = React.useState(null);

            const load = React.useCallback(() => {
                setBusy(true);
                setLoaded(false);
                setError(null);
                setLastBackup(null);
                read().then((result) => {
                    if (!result.ok) {
                        setBusy(false);
                        setError({ kind: "load", message: result.error.message });
                        return;
                    }
                    setContent(result.value.content);
                    setBaseline(result.value.content);
                    setInfo({ path: result.value.path, exists: result.value.exists, mtimeMs: result.value.mtimeMs });
                    setLoaded(true);
                    setBusy(false);
                }).catch((cause) => {
                    setBusy(false);
                    setError({ kind: "load", message: cause instanceof Error ? cause.message : String(cause) });
                });
            }, [read]);

            const loadVersions = React.useCallback(() => {
                setVersionsBusy(true);
                setVersionsError(null);
                listVersions().then((result) => {
                    setVersionsBusy(false);
                    if (!result.ok) {
                        setVersionsError({ kind: "list", message: result.error.message });
                        return;
                    }
                    setVersions(result.value.versions);
                }).catch((cause) => {
                    setVersionsBusy(false);
                    setVersionsError({ kind: "list", message: cause instanceof Error ? cause.message : String(cause) });
                });
            }, [listVersions]);

            React.useEffect(() => {
                if (remoteError !== null) return;
                load();
                loadVersions();
            }, [load, loadVersions, remoteError]);

            const dirty = loaded && content !== baseline;
            const canSave = loaded && dirty && !busy;

            const submit = () => {
                if (!canSave) return;
                setBusy(true);
                setError(null);
                save({ content }).then((result) => {
                    if (!result.ok) {
                        setBusy(false);
                        setError({ kind: "save", message: result.error.message });
                        return;
                    }
                    setBaseline(content);
                    setInfo((prev) => ({ ...prev, path: result.value.path, exists: true, mtimeMs: result.value.mtimeMs }));
                    setLastBackup(result.value.backupPath);
                    setBusy(false);
                    setToast({
                        seq: Date.now(),
                        text: result.value.backupPath === null
                            ? t("savedPlain")
                            : t("savedWithBackup") + result.value.backupPath,
                    });
                    // 这次保存本身可能刚生成一份新备份，列表要跟上。
                    loadVersions();
                }).catch((cause) => {
                    setBusy(false);
                    setError({ kind: "save", message: cause instanceof Error ? cause.message : String(cause) });
                });
            };

            /** 展开/收起某个版本的内容。再点一次同一版本即收起。 */
            const toggleView = (version) => {
                if (viewing !== null && viewing.id === version.id) {
                    setViewing(null);
                    return;
                }
                setViewing({ id: version.id, content: null });
                setVersionsError(null);
                readVersion({ id: version.id }).then((result) => {
                    if (!result.ok) {
                        setViewing(null);
                        setVersionsError({ kind: "list", message: result.error.message });
                        return;
                    }
                    setViewing({ id: result.value.id, content: result.value.content });
                }).catch((cause) => {
                    setViewing(null);
                    setVersionsError({ kind: "list", message: cause instanceof Error ? cause.message : String(cause) });
                });
            };

            /** 回滚：主文件与历史列表都会变，两个都要重读。 */
            const doRestore = (version) => {
                setConfirming(null);
                setRowBusy(version.id);
                setVersionsError(null);
                restoreVersion({ id: version.id }).then((result) => {
                    setRowBusy(null);
                    if (!result.ok) {
                        setVersionsError({ kind: "action", message: messageOf(result) });
                        return;
                    }
                    setToast({ seq: Date.now(), text: t("historyRestoreDone") + result.value.restoredFrom });
                    load();
                    loadVersions();
                }).catch((cause) => {
                    setRowBusy(null);
                    setVersionsError({ kind: "action", message: messageOf(undefined, cause) });
                });
            };

            /** 删除单个版本；若它正被展开则同时收起。 */
            const doRemove = (version) => {
                setConfirming(null);
                setRowBusy(version.id);
                setVersionsError(null);
                deleteVersion({ id: version.id }).then((result) => {
                    setRowBusy(null);
                    if (!result.ok) {
                        setVersionsError({ kind: "action", message: messageOf(result) });
                        return;
                    }
                    if (viewing !== null && viewing.id === version.id) setViewing(null);
                    setToast({ seq: Date.now(), text: t("historyRemoveDone") + result.value.id });
                    loadVersions();
                }).catch((cause) => {
                    setRowBusy(null);
                    setVersionsError({ kind: "action", message: messageOf(undefined, cause) });
                });
            };

            /** 状态行文本：错误 > 进行中 > 未保存 > 就绪。 */
            const statusText = () => {
                if (remoteError !== null) return t("unavailable");
                if (error !== null) {
                    return (error.kind === "load" ? t("loadFailed") : t("saveFailed")) + error.message;
                }
                if (busy && !loaded) return t("loading");
                if (busy) return t("saving");
                if (dirty) return t("dirty");
                if (!info.exists) return t("missing");
                if (lastBackup !== null) return t("clean") + " " + t("lastBackup") + lastBackup;
                return t("clean");
            };
            const statusClass = error !== null || remoteError !== null
                ? "dsp-status dsp-error"
                : dirty ? "dsp-status dsp-dirty" : "dsp-status dsp-ok";

            /**
             * 一行版本：时间 / id / 大小 + 查看·回滚·删除。
             * 回滚与删除都要求行内二次确认 —— 它们会改动或销毁用户数据，
             * 而这里不能依赖原生 confirm()（宿主窗口可能禁用它，且它阻塞）。
             */
            const renderVersion = (version) => {
                const expanded = viewing !== null && viewing.id === version.id;
                const pendingRestore = confirming !== null && confirming.id === version.id && confirming.action === "restore";
                const pendingRemove = confirming !== null && confirming.id === version.id && confirming.action === "remove";
                // 有任一行在跑就锁住所有行，避免并发发起两次破坏性操作。
                const disabled = rowBusy !== null || versionsBusy;
                /**
                 * 回滚会覆盖主文件并触发重新读取，从而冲掉编辑器里未保存的改动，
                 * 所以有 dirty 时单独禁用它（查看与删除不动主文件，不受影响）。
                 */
                const restoreDisabled = disabled || dirty;

                const actionButtons = pendingRestore
                    ? [
                        h(Button, {
                            key: "confirm-restore",
                            variant: "primary",
                            disabled: restoreDisabled,
                            onClick: () => { doRestore(version); },
                        }, t("historyConfirmRestore")),
                        h(Button, {
                            key: "cancel-restore",
                            variant: "outline",
                            disabled: disabled,
                            onClick: () => { setConfirming(null); },
                        }, t("historyCancel")),
                    ]
                    : pendingRemove
                        ? [
                            h(Button, {
                                key: "confirm-remove",
                                // 实心红：破坏性操作要一眼看见（用户要求）
                                variant: "danger",
                                disabled: disabled,
                                onClick: () => { doRemove(version); },
                            }, t("historyConfirmRemove")),
                            h(Button, {
                                key: "cancel-remove",
                                variant: "outline",
                                disabled: disabled,
                                onClick: () => { setConfirming(null); },
                            }, t("historyCancel")),
                        ]
                        : [
                            h(Button, {
                                key: "view",
                                variant: "outline",
                                disabled: disabled,
                                onClick: () => { toggleView(version); },
                            }, expanded ? t("historyHide") : t("historyView")),
                            h(Button, {
                                key: "restore",
                                variant: "outline",
                                disabled: restoreDisabled,
                                onClick: () => { setConfirming({ id: version.id, action: "restore" }); },
                            }, t("historyRestore")),
                            h(Button, {
                                key: "remove",
                                variant: "outline",
                                className: "dsp-danger",
                                disabled: disabled,
                                onClick: () => { setConfirming({ id: version.id, action: "remove" }); },
                            }, t("historyRemove")),
                        ];

                return h("li", { className: "dsp-version", key: version.id }, [
                    h("div", { className: "dsp-version-row", key: "row" }, [
                        h("span", { className: "dsp-version-time", key: "time" }, formatTime(version.at || version.mtimeMs)),
                        h("code", { className: "dsp-version-id", key: "id" }, version.id),
                        h("span", { className: "dsp-muted", key: "bytes" }, `${version.bytes} B`),
                        h("div", { className: "dsp-version-actions", key: "actions" }, actionButtons),
                    ]),
                    expanded
                        ? h("pre", { className: "dsp-version-content", key: "content" },
                            viewing.content === null ? t("historyLoading") : viewing.content)
                        : null,
                ]);
            };

            // 区分「列表读不出来」与「某一行的操作失败」——两者的处置方式不同。
            const historyNote = versionsError !== null
                ? h("p", { className: "dsp-history-note dsp-error", key: "note", role: "status" },
                    (versionsError.kind === "action" ? t("historyActionFailed") : t("historyLoadFailed")) + versionsError.message)
                : versionsBusy && versions.length === 0
                    ? h("p", { className: "dsp-history-note dsp-muted", key: "note" }, t("historyLoading"))
                    : versions.length === 0
                        ? h("p", { className: "dsp-history-note dsp-muted", key: "note" }, t("historyEmpty"))
                        : null;

            return h("div", { className: "dsp-root" }, [
                h("header", { className: "dsp-header", key: "header" }, [
                    h("h2", { className: "dsp-title", key: "title" }, t("title")),
                    h("p", { className: "dsp-intro", key: "intro" }, t("intro")),
                    h("div", { className: "dsp-meta", key: "meta" }, [
                        h("span", { className: "dsp-muted", key: "file-label" }, `${t("fileLabel")}:`),
                        h("code", { className: "dsp-path", key: "path" }, info.path),
                        h("span", { className: "dsp-muted", key: "chars" }, `${content.length} ${t("charsLabel")}`),
                        h("span", { className: "dsp-muted", key: "mtime" }, `${t("modifiedLabel")}: ${formatTime(info.mtimeMs)}`),
                    ]),
                ]),
                h("textarea", {
                    key: "editor",
                    className: "dsp-editor",
                    "aria-label": t("editorLabel"),
                    spellCheck: false,
                    disabled: busy || !loaded,
                    value: content,
                    onChange: (event) => { setContent(event.target.value); },
                }),
                h("footer", { className: "dsp-footer", key: "footer" }, [
                    h("div", { className: statusClass, key: "status", role: "status" }, statusText()),
                    h("div", { className: "dsp-actions", key: "actions" }, [
                        h(Button, {
                            key: "reload",
                            variant: "outline",
                            disabled: busy || remoteError !== null,
                            onClick: load,
                        }, t("reload")),
                        h(Button, {
                            key: "save",
                            variant: "primary",
                            disabled: !canSave,
                            onClick: submit,
                        }, t("save")),
                    ]),
                ]),
                h("section", { className: "dsp-history", key: "history" }, [
                    h("div", { className: "dsp-history-head", key: "head" }, [
                        h("h3", { className: "dsp-history-title", key: "title" }, t("historyTitle")),
                        h("span", { className: "dsp-muted", key: "count" }, `${versions.length} ${t("historyCountLabel")}`),
                        h("div", { className: "dsp-history-head-actions", key: "actions" }, [
                            h(Button, {
                                key: "reload",
                                variant: "outline",
                                disabled: versionsBusy || remoteError !== null,
                                onClick: loadVersions,
                            }, t("historyReload")),
                        ]),
                    ]),
                    h("p", { className: "dsp-history-hint", key: "hint" },
                        dirty ? `${t("historyHint")} ${t("historyDirtyBlock")}` : t("historyHint")),
                    historyNote,
                    h("ul", { className: "dsp-versions", key: "list" }, versions.map(renderVersion)),
                ]),
                toast !== null
                    ? h(Toast, {
                        key: `toast-${toast.seq}`,
                        text: toast.text,
                        tone: "success",
                        onDone: () => { setToast(null); },
                    })
                    : null,
            ]);
        }

        /**
         * 注册字典、挂载远程贡献、把设置页注册进 `settings.section`。
         * @param ctx - 客户端 Cordis 上下文（inject 已声明 slots / locale / remote）。
         * @returns 卸载函数。
         */
        async function apply(ctx) {
            const disposeStyles = insertStyles();
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-personalization: dictionaries");
            ctx.effect(() => disposeStyles, "dsh-personalization: styles");
            const t = ctx.locale.bind(NS);

            // 挂载远程贡献。命名空间服务叫 `remote.personalization`，挂载完成后才存在，
            // 因此每次调用都重新取一次，避免连接重置后拿到失效引用。
            let remoteError = null;
            let mounted = Promise.resolve();
            let disposeRemote = () => {};
            try {
                const remote = ctx.get("remote");
                if (remote === undefined) throw new Error("remote service is not available");
                mounted = Promise.resolve(remote.$mount(CONTRIBUTION));
                disposeRemote = await mounted;
                if (ctx.get(REMOTE_SERVICE_KEY) === undefined) {
                    throw new Error(`remote namespace ${SERVICE_KEY} was not mounted`);
                }
            } catch (cause) {
                remoteError = cause instanceof Error ? cause.message : String(cause);
                mounted = Promise.resolve();
                console.error(`dsh-personalization: mounting the remote contribution failed: ${remoteError}`);
            }

            /** 取命名空间服务；未挂载或已失效时抛出，由调用方转成界面上的错误行。 */
            const namespace = () => {
                const service = ctx.get(REMOTE_SERVICE_KEY);
                if (service === undefined) throw new Error(t("unavailable"));
                return service;
            };

            // read / save / list / readVersion / restore / remove 在 apply 里创建一次，
            // 引用恒定。若放进 inject 面里新建，组件每次渲染都会换身份，
            // load 的 useCallback 依赖会失效。
            const read = async () => {
                await mounted;
                return namespace().read();
            };
            const save = async (payload) => {
                await mounted;
                return namespace().save(payload);
            };
            const listVersions = async () => {
                await mounted;
                return namespace().listVersions();
            };
            const readVersion = async (payload) => {
                await mounted;
                return namespace().readVersion(payload);
            };
            const restoreVersion = async (payload) => {
                await mounted;
                return namespace().restoreVersion(payload);
            };
            const deleteVersion = async (payload) => {
                await mounted;
                return namespace().deleteVersion(payload);
            };

            ctx.slots.inject("settings.section", () => ctx.slots.register({
                name: "settings.section",
                id: SECTION_ID,
                order: 25,
                label: () => t("nav"),
                locale: NS,
                inject: () => ({ t, read, save, listVersions, readVersion, restoreVersion, deleteVersion, remoteError }),
            }, PersonalizationSection));

            return () => { disposeRemote(); };
        }

        bundleModule.exports.apply = apply;
        bundleModule.exports.inject = inject;
        return bundleModule.exports;
    },
});
