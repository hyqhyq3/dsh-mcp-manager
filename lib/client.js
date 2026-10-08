window.__ModuleLoader__.load({
	id: "dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;

		const inject = ["slots", "locale"];

		const css = ".mm_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}.mm_row{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}.mm_rowHead{display:flex;align-items:center;gap:8px}.mm_name{font-weight:600;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.mm_url{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}.mm_statusDot{background:var(--dsw-alias-label-tertiary);border-radius:999px;flex:none;width:7px;height:7px;display:inline-block}.mm_statusDot.connected{background:var(--dsw-alias-state-success-primary)}.mm_statusDot.needs-auth,.mm_statusDot.authorizing,.mm_statusDot.connecting{background:var(--dsw-alias-state-business-primary)}.mm_statusDot.error{background:var(--dsw-alias-state-error-primary)}.mm_badge{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);border-radius:5px;align-items:center;padding:1px 8px;font-size:11px;line-height:16px;display:inline-flex}.mm_badge.connected{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}.mm_badge.error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}.mm_badge.needs-auth,.mm_badge.authorizing,.mm_badge.connecting{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);color:var(--dsw-alias-state-business-primary)}.mm_badge.disabled{color:var(--dsw-alias-label-tertiary)}.mm_actions{margin-left:auto;display:flex;gap:6px}.mm_btn{cursor:pointer;font-size:12px;line-height:18px;padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.mm_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.mm_btn:disabled{opacity:.5;cursor:default}.mm_btn.primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}.mm_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.mm_meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.mm_form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mm_form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}.mm_form input,.mm_form select{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.mm_form input::placeholder,.mm_form select::placeholder{color:var(--dsw-alias-label-tertiary)}.mm_form select option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}.mm_form .wide{grid-column:1 / -1}.mm_add{border-style:dashed}.mm_kv{display:flex;gap:6px;align-items:center}.mm_kv input{flex:1}.mm_kv .mm_btn{flex:none}.mm_catalogHeading{align-items:baseline;gap:7px;padding:0 2px;display:flex}.mm_catalogHeading h3{font-size:18px;font-weight:600;line-height:26px;margin:0}.mm_catalogHeading span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}.mm_cards{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;display:grid}.mm_cardContent{width:100%;align-items:center;gap:8px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;padding:0;display:flex;text-align:left}.mm_chevron{color:var(--dsw-alias-label-tertiary);flex:none;margin-left:auto;transition:transform .15s;display:inline-flex}.mm_chevron[data-open=true]{transform:rotate(180deg)}.mm_details{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding-top:10px;margin-top:10px;display:flex}.mm_cardTrailing{flex:none;align-items:center;gap:7px;display:inline-flex}.mm_addActions{margin-left:auto;display:inline-flex}.mm_addBtn{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0;display:inline-flex;align-items:center;justify-content:center}.mm_addBtn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.mm_overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000}.mm_dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv1);padding:20px;max-width:360px;width:100%;display:flex;flex-direction:column;gap:12px}.mm_dialogTitle{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}.mm_dialogBody{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.mm_dialogActions{display:flex;justify-content:flex-end;gap:8px}.mm_btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.mm_btn.danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}.mm_cardActions{display:flex;align-items:center;gap:8px}.mm_switchRow{align-items:center;gap:8px;display:inline-flex}.mm_switch{box-sizing:border-box;width:36px;height:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:999px;cursor:pointer;padding:0;position:relative;flex:none;transition:background-color .2s ease,border-color .2s ease}.mm_switch:disabled{cursor:default;opacity:.6}.mm_switch[data-on=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary)}.mm_switchThumb{box-sizing:border-box;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);position:absolute;top:2px;left:2px;transition:transform .22s cubic-bezier(.34,1.56,.64,1),background-color .18s ease}.mm_switch[data-on=true] .mm_switchThumb{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground)}.mm_switchText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.mm_actionBtns{margin-left:auto;display:flex;gap:6px}.mm_collapsedErr{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mm_logHead{display:flex;align-items:center;gap:8px}.mm_logToggle{cursor:pointer;font-size:12px;line-height:18px;padding:0;border:none;background:none;color:var(--dsw-alias-state-business-primary);display:inline-flex;align-items:center;gap:4px}.mm_logBox{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}.mm_logCopy{margin-left:auto}.mm_search{width:100%;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative}.mm_search>svg{pointer-events:none;position:absolute;left:12px}.mm_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 34px 0 36px;font-size:13px}.mm_search input::placeholder{color:var(--dsw-alias-label-tertiary)}.mm_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}body[data-ds-dark-theme] .mm_switchThumb{background:#fff}body[data-ds-dark-theme] .mm_switch[data-on=true] .mm_switchThumb{background:#fff}.mm_wsList{display:flex;flex-direction:column;gap:10px}.mm_ws{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}.mm_wsPath{font-weight:600;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-all}.mm_wsServers{display:flex;flex-direction:column;gap:6px}.mm_wsServer{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}.mm_wsServer .mm_badge{flex:none}.mm_wsExclude{margin-top:6px;display:flex;flex-direction:column;gap:6px}.mm_wsExcludeTitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}.mm_wsCheck{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}.mm_wsCheck input{accent-color:var(--dsw-alias-state-business-primary)}.mm_statusDot.conflict{background:var(--dsw-alias-state-error-primary)}.mm_badge.conflict{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}.mm_wsBar{display:flex;align-items:center;gap:10px;padding:0 2px}.mm_wsSelect{font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);max-width:100%}.mm_wsSelect option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}.mm_wsPathHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all;padding:0 2px}.mm_groupTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);padding:0 2px;margin-top:4px}.mm_feature{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:10px 12px}.mm_featureText{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}.mm_featureTitle{font-size:13px;font-weight:600;line-height:20px}.mm_featureMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-mcp-manager/section\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mcp-manager";
			tag.dataset.pluginCss = "dsh-mcp-manager/section";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const zh = {
			"sectionLabel": "MCP",
			"namePlaceholder": "odin",
			"commandPlaceholder": "npx",
			"cwdPlaceholder": "/path/to/project",
			"urlPlaceholder": "https://mcp.example.com/mcp",
			"tokenEnvPlaceholder": "MCP_BEARER_TOKEN",
			"enableFailed": "启用失败 (HTTP {status})",
			"disableFailed": "禁用失败 (HTTP {status})",
			"addFailed": "添加失败 (HTTP {status})",
			"connected": "已启用",
			"needs-auth": "待认证",
			"authorizing": "认证中",
			"connecting": "连接中",
			"error": "错误",
			"disconnected": "未连接",
			"disabled": "已禁用",
			"conflict": "冲突",
			"configured": "已配置",
			"staticToken": "静态 Token",
			"disable": "停用",
			"enable": "启用",
			"reauth": "重新认证",
			"auth": "去认证",
			"edit": "编辑",
			"delete": "删除",
			"deleteServer": "删除 MCP 服务器",
			"cancel": "取消",
			"chooseWorkspaceError": "请选择工作区",
			"scope": "作用域 Scope",
			"userScope": "user（全局，所有工作区可用）",
			"workspaceScope": "workspace（仅指定工作区可用）",
			"workspace": "工作区",
			"chooseWorkspace": "选择工作区…",
			"type": "类型",
			"http": "HTTP（远程服务器）",
			"stdio": "stdio（本地进程）",
			"name": "名称",
			"command": "命令 command（可执行程序）",
			"arguments": "参数 arguments",
			"argumentValue": "参数值",
			"addArgument": "＋ 添加参数",
			"environment": "环境变量 environment variables",
			"keyUpper": "键 KEY",
			"valueUpper": "值 VALUE",
			"addEnvironment": "＋ 添加环境变量",
			"cwd": "工作目录 cwd（可选）",
			"url": "MCP 服务器 URL",
			"authMode": "认证方式",
			"oauth": "OAuth（浏览器跳转认证）",
			"bearer": "静态 Bearer Token",
			"noAuth": "无鉴权",
			"noAuthOption": "无鉴权（服务器无需认证）",
			"tokenEnv": "Bearer 令牌环境变量（填变量名，不填明文）",
			"clientId": "OAuth Client ID（可选，填了就不走动态注册）",
			"clientSecretEnv": "Client Secret 环境变量名（可选，公共客户端留空）",
			"oauthScope": "Scope（可选，空格分隔，如 repo read:org）",
			"headers": "标头 Headers",
			"key": "键 Key",
			"value": "值 Value",
			"addHeader": "＋ 添加标头",
			"headerEnv": "来自环境变量的标头（值填环境变量名）",
			"envName": "环境变量名",
			"addVariable": "＋ 添加变量",
			"save": "保存",
			"deleteWorkspaceServer": "删除工作区 MCP 服务器",
			"hide": "隐藏",
			"addServer": "添加 MCP 服务器",
			"editGlobal": "编辑 MCP 服务器（全局）",
			"editWorkspace": "编辑 MCP 服务器（工作区）",
			"servers": "MCP 服务器",
			"onDemand": "按需 MCP 工具调用",
			"onDemandHelp": "Native 模式下，MCP 仅暴露 search、describe、execute 三个 broker 工具",
			"on": "已开启",
			"off": "已关闭",
			"global": "全局（所有工作区）",
			"workspaceServers": "工作区服务器（仅此工作区可见）",
			"emptyWorkspace": "该工作区还没有专属 MCP 服务器，点右上角 ＋ 添加（写入 .dsh/dshmm/mcp.json）。",
			"globalServers": "全局服务器（在此工作区可用）",
			"emptyGlobal": "还没有全局服务器。切换到「全局」视图添加。",
			"search": "搜索 MCP 服务器",
			"authFailed": "认证启动失败 (HTTP {status})",
			"deleteFailed": "删除失败 (HTTP {status})",
			"toggleFailed": "切换失败 (HTTP {status})",
			"saveFailed": "保存失败 (HTTP {status})",
			"toolCount": "{count} 个工具",
			"confirmDelete": "确定要删除「{name}」吗？此操作不可恢复。",
			"confirmWorkspaceDelete": "确定要从该工作区删除「{name}」吗？",
			"logs": "日志",
			"hideLogs": "收起日志",
			"noLogs": "暂无日志记录",
			"copyLogs": "复制",
			"logsCopied": "已复制",
			"loadFailed": "加载失败 (HTTP {status})",
		};

		const en = {
			"sectionLabel": "MCP",
			"namePlaceholder": "odin",
			"commandPlaceholder": "npx",
			"cwdPlaceholder": "/path/to/project",
			"urlPlaceholder": "https://mcp.example.com/mcp",
			"tokenEnvPlaceholder": "MCP_BEARER_TOKEN",
			"enableFailed": "Enable failed (HTTP {status})",
			"disableFailed": "Disable failed (HTTP {status})",
			"addFailed": "Add failed (HTTP {status})",
			"connected": "Enabled",
			"needs-auth": "Authentication required",
			"authorizing": "Authenticating",
			"connecting": "Connecting",
			"error": "Error",
			"disconnected": "Disconnected",
			"disabled": "Disabled",
			"conflict": "Conflict",
			"configured": "Configured",
			"staticToken": "Static token",
			"disable": "Disable",
			"enable": "Enable",
			"reauth": "Reauthenticate",
			"auth": "Authenticate",
			"edit": "Edit",
			"delete": "Delete",
			"deleteServer": "Delete MCP server",
			"cancel": "Cancel",
			"chooseWorkspaceError": "Please select a workspace",
			"scope": "Scope",
			"userScope": "user (global, available in all workspaces)",
			"workspaceScope": "workspace (available only in the selected workspace)",
			"workspace": "Workspace",
			"chooseWorkspace": "Select a workspace…",
			"type": "Type",
			"http": "HTTP (remote server)",
			"stdio": "stdio (local process)",
			"name": "Name",
			"command": "Command (executable)",
			"arguments": "Arguments",
			"argumentValue": "Argument value",
			"addArgument": "＋ Add argument",
			"environment": "Environment variables",
			"keyUpper": "KEY",
			"valueUpper": "VALUE",
			"addEnvironment": "＋ Add environment variable",
			"cwd": "Working directory (optional)",
			"url": "MCP server URL",
			"authMode": "Authentication method",
			"oauth": "OAuth (authenticate in browser)",
			"bearer": "Static Bearer token",
			"noAuth": "No auth",
			"noAuthOption": "No auth (server needs no credentials)",
			"tokenEnv": "Bearer token environment variable (name, not the token itself)",
			"clientId": "OAuth Client ID (optional; skips dynamic registration)",
			"clientSecretEnv": "Client secret environment variable name (optional; leave empty for a public client)",
			"oauthScope": "Scope (optional, space separated, e.g. repo read:org)",
			"headers": "Headers",
			"key": "Key",
			"value": "Value",
			"addHeader": "＋ Add header",
			"headerEnv": "Headers from environment variables (enter variable names as values)",
			"envName": "Environment variable name",
			"addVariable": "＋ Add variable",
			"save": "Save",
			"deleteWorkspaceServer": "Delete workspace MCP server",
			"hide": "Hide",
			"addServer": "Add MCP server",
			"editGlobal": "Edit MCP server (global)",
			"editWorkspace": "Edit MCP server (workspace)",
			"servers": "MCP servers",
			"onDemand": "On-demand MCP tool calls",
			"onDemandHelp": "In Native mode, MCP exposes only the search, describe, and execute broker tools",
			"on": "On",
			"off": "Off",
			"global": "Global (all workspaces)",
			"workspaceServers": "Workspace servers (visible only in this workspace)",
			"emptyWorkspace": "No MCP servers in this workspace yet. Click ＋ above to add one (saved to .dsh/dshmm/mcp.json).",
			"globalServers": "Global servers (available in this workspace)",
			"emptyGlobal": "No global servers yet. Switch to the Global view to add one.",
			"search": "Search MCP servers",
			"authFailed": "Failed to start authentication (HTTP {status})",
			"deleteFailed": "Delete failed (HTTP {status})",
			"toggleFailed": "Toggle failed (HTTP {status})",
			"saveFailed": "Save failed (HTTP {status})",
			"toolCount": "Tools: {count}",
			"confirmDelete": "Delete “{name}”? This cannot be undone.",
			"confirmWorkspaceDelete": "Delete “{name}” from this workspace?",
			"logs": "Logs",
			"hideLogs": "Hide logs",
			"noLogs": "No log entries yet",
			"copyLogs": "Copy",
			"logsCopied": "Copied",
			"loadFailed": "Load failed (HTTP {status})",
		};


		function api(path, options) {
			return fetch("/mcp-manager/api" + path, {
				headers: { "Content-Type": "application/json" },
				...options,
			}).then(async (resp) => ({ ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) }));
		}

		function formatLogEntry(entry) {
			const at = new Date(entry.at).toISOString();
			const status = entry.status ? " " + entry.status : "";
			return `[${at}] ${entry.phase}${status} ${entry.url} — ${entry.detail}`;
		}

		function AttemptLog({ t, serverId }) {
			const [open, setOpen] = react.useState(false);
			const [entries, setEntries] = react.useState([]);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [copied, setCopied] = react.useState(false);
			const load = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${serverId}/logs`);
					if (r.ok) setEntries(Array.isArray(r.body.logs) ? r.body.logs : []);
					else setError(r.body.error || t("loadFailed", { status: r.status }));
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const toggle = () => {
				const next = !open;
				setOpen(next);
				if (next) load();
			};
			const copy = () => {
				const body = entries.map((entry) => formatLogEntry(entry)).join("\n");
				try {
					const area = document.createElement("textarea");
					area.value = body;
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					document.execCommand("copy");
					document.body.removeChild(area);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch (e) { setError(String(e)); }
			};
			return createElement("div", { className: "mm_logHead" },
				createElement("button", { className: "mm_logToggle", type: "button", "aria-expanded": open, onClick: toggle, disabled: busy }, busy ? "…" : open ? t("hideLogs") : t("logs")),
				open && entries.length > 0 ? createElement("button", { className: "mm_btn mm_logCopy", type: "button", onClick: copy }, copied ? t("logsCopied") : t("copyLogs")) : null,
				open ? createElement("div", { className: "mm_logBox" },
					entries.length === 0
						? t("noLogs")
						: entries.map((entry, i) => createElement("div", { key: i, className: `mm_logLine ${entry.phase}` }, formatLogEntry(entry))),
				) : null,
				error ? createElement("div", { className: "mm_err" }, error) : null,
			);
		}

		function ServerRow({ t, server, onChanged, onEdit, open, onToggle }) {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const [confirming, setConfirming] = react.useState(false);

			const startAuth = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/auth`, { method: "POST" });
					if (r.ok && r.body.authorizeUrl) { window.open(r.body.authorizeUrl, "_blank"); }
					else setError(r.body.error || t("authFailed", { status: r.status }));
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const remove = async () => {
				setConfirming(false);
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}`, { method: "DELETE" });
					if (!r.ok) setError(r.body.error || t("deleteFailed", { status: r.status }));
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const askRemove = () => setConfirming(true);
			const toggleEnabled = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: server.enabled === false }) });
					if (!r.ok) setError(r.body.error || t(server.enabled === false ? "enableFailed" : "disableFailed", { status: r.status }));
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			return createElement("div", { className: "mm_row", key: server.id, "data-open": open ? "true" : undefined },
				createElement("button", { className: "mm_cardContent", type: "button", "aria-expanded": open, onClick: onToggle },
					createElement("span", { className: "mm_name" }, server.name),
					createElement("span", { className: "mm_cardTrailing" },
						createElement("span", { className: `mm_statusDot ${server.status}`, "aria-hidden": "true" }),
						createElement("span", { className: `mm_badge ${server.status}` }, t(server.status)),
						createElement("span", { className: "mm_chevron", "data-open": open ? "true" : undefined },
							createElement("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
								createElement("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }),
							),
						),
					),
				),
				server.error && !open ? createElement("div", { className: "mm_collapsedErr", title: server.error }, server.error) : null,
				open ? createElement("div", { className: "mm_details" },
					createElement("div", { className: "mm_url" }, server.type === "stdio"
						? `stdio · ${server.command} ${(server.args || []).join(" ")}`
						: `${server.authMode === "oauth" ? "OAuth" : server.authMode === "none" ? t("noAuth") : t("staticToken")} · ${server.url}`),
					server.status === "connected" ? createElement("div", { className: "mm_meta" }, t("toolCount", { count: server.toolCount })) : null,
					server.error ? createElement("div", { className: "mm_err" }, server.error) : null,
					error ? createElement("div", { className: "mm_err" }, error) : null,
					createElement(AttemptLog, { t, serverId: server.id, key: "logs" }),
					createElement("div", { className: "mm_cardActions" },
						createElement("span", { className: "mm_switchRow" },
							createElement("button", { className: "mm_switch", type: "button", role: "switch", "data-on": server.enabled !== false ? "true" : undefined, "aria-checked": server.enabled !== false, onClick: toggleEnabled, disabled: busy },
								createElement("span", { className: "mm_switchThumb" }),
							),
							createElement("span", { className: "mm_switchText" }, server.enabled !== false ? t("disable") : t("enable")),
						),
						createElement("span", { className: "mm_actionBtns" },
							server.enabled !== false && server.authMode === "oauth"
								? createElement("button", { className: "mm_btn", onClick: startAuth, disabled: busy }, busy ? "…" : server.status === "connected" ? t("reauth") : t("auth"))
								: null,
							createElement("button", { className: "mm_btn", onClick: onEdit, disabled: busy }, t("edit")),
							createElement("button", { className: "mm_btn danger", onClick: askRemove, disabled: busy }, t("delete")),
						),
					),
				) : null,
				confirming ? createElement("div", { className: "mm_overlay", onClick: () => setConfirming(false) },
					createElement("div", { className: "mm_dialog", onClick: (e) => e.stopPropagation() },
						createElement("div", { className: "mm_dialogTitle" }, t("deleteServer")),
						createElement("div", { className: "mm_dialogBody" }, t("confirmDelete", { name: server.name })),
						createElement("div", { className: "mm_dialogActions" },
							createElement("button", { className: "mm_btn", onClick: () => setConfirming(false), disabled: busy }, t("cancel")),
							createElement("button", { className: "mm_btn danger", onClick: remove, disabled: busy }, busy ? "…" : t("delete")),
						),
					),
				) : null,
			);
		}

		function ServerForm({ t, initial, onDone, onCancel, scope, workspacePath, workspaces }) {
			const editing = initial != null;
			const [formScope, setFormScope] = react.useState(scope ?? "user");
			const [wsPath, setWsPath] = react.useState(workspacePath ?? "");
			const [type, setType] = react.useState(initial?.type ?? "http");
			const [name, setName] = react.useState(initial?.name ?? "");
			const [url, setUrl] = react.useState(initial?.url ?? "");
			const [authMode, setAuthMode] = react.useState(initial?.authMode ?? "oauth");
			const [tokenEnv, setTokenEnv] = react.useState(initial?.tokenEnv ?? "");
			const [clientId, setClientId] = react.useState(initial?.clientId ?? "");
			const [clientSecretEnv, setClientSecretEnv] = react.useState(initial?.clientSecretEnv ?? "");
			const [oauthScope, setOauthScope] = react.useState(initial?.scope ?? "");
			const [headersList, setHeadersList] = react.useState(initial?.headers ? Object.entries(initial.headers).map(([k, v]) => ({ key: k, value: String(v) })) : [{ key: "", value: "" }]);
			const [headerEnvList, setHeaderEnvList] = react.useState(initial?.headerEnv ? Object.entries(initial.headerEnv).map(([k, v]) => ({ key: k, value: String(v) })) : [{ key: "", value: "" }]);
			const [command, setCommand] = react.useState(initial?.command ?? "");
			const [argsList, setArgsList] = react.useState((initial?.args ?? []).length ? initial.args.map(String) : [""]);
			const [envList, setEnvList] = react.useState(initial?.env ? Object.entries(initial.env).map(([k, v]) => ({ key: k, value: String(v) })) : [{ key: "", value: "" }]);
			const [cwd, setCwd] = react.useState(initial?.cwd ?? "");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");

			const isWorkspace = formScope === "workspace";

			const submit = async () => {
				if (isWorkspace && !wsPath) { setError(t("chooseWorkspaceError")); return; }
				setBusy(true); setError("");
				try {
					const body = type === "stdio"
						? {
							name, type: "stdio", command, cwd,
							args: argsList.map((a) => a.trim()).filter(Boolean),
							env: envList.reduce((acc, e) => { const k = e.key.trim(); if (k) acc[k] = e.value; return acc; }, {}),
						}
						: {
							name, type: "http", url, authMode,
							headers: headersList.reduce((acc, e) => { const k = e.key.trim(); if (k) acc[k] = e.value; return acc; }, {}),
							headerEnv: headerEnvList.reduce((acc, e) => { const k = e.key.trim(); if (k) acc[k] = e.value; return acc; }, {}),
							...(authMode === "static" ? { tokenEnv } : {}),
							...(authMode === "oauth" ? { clientId, clientSecretEnv, scope: oauthScope } : {}),
						};
					let r;
					if (isWorkspace) {
						r = editing
							? await api("/workspaces/servers", { method: "PUT", body: JSON.stringify({ path: wsPath, oldName: initial.name, ...body }) })
							: await api("/workspaces/servers", { method: "POST", body: JSON.stringify({ path: wsPath, ...body }) });
					} else {
						r = editing
							? await api(`/servers/${initial.id}`, { method: "PUT", body: JSON.stringify(body) })
							: await api("/servers", { method: "POST", body: JSON.stringify(body) });
					}
					if (r.ok) onDone();
					else setError(r.body.error || t(editing ? "saveFailed" : "addFailed", { status: r.status }));
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			return createElement("div", { className: "mm_row mm_add" },
				createElement("div", { className: "mm_form" },
					createElement("label", { className: "wide" }, t("scope"),
						createElement("select", { value: formScope, disabled: editing, onChange: (e) => setFormScope(e.target.value) },
							createElement("option", { value: "user" }, t("userScope")),
							createElement("option", { value: "workspace" }, t("workspaceScope")),
						),
					),
					isWorkspace ? createElement("label", { className: "wide" }, t("workspace"),
						createElement("select", { value: wsPath, disabled: editing, onChange: (e) => setWsPath(e.target.value) },
							createElement("option", { value: "" }, t("chooseWorkspace")),
							(workspaces ?? []).map((w) => createElement("option", { value: w, key: w }, w)),
						),
					) : null,
					createElement("label", null, t("type"),
						createElement("select", { value: type, onChange: (e) => setType(e.target.value) },
							createElement("option", { value: "http" }, t("http")),
							createElement("option", { value: "stdio" }, t("stdio")))),
					createElement("label", null, t("name"),
						createElement("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: t("namePlaceholder") })),
					type === "stdio"
						? [
							createElement("label", { className: "wide" }, t("command"),
								createElement("input", { value: command, onChange: (e) => setCommand(e.target.value), placeholder: t("commandPlaceholder") })),
							createElement("label", { className: "wide" }, t("arguments"),
								...argsList.map((arg, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: arg, onChange: (e) => setArgsList(argsList.map((v, idx) => idx === i ? e.target.value : v)), placeholder: t("argumentValue") }),
									createElement("button", { className: "mm_btn", onClick: () => setArgsList(argsList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setArgsList([...argsList, ""]), disabled: busy }, t("addArgument")),
							),
							createElement("label", { className: "wide" }, t("environment"),
								...envList.map((e, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: e.key, onChange: (ev) => setEnvList(envList.map((v, idx) => idx === i ? { ...v, key: ev.target.value } : v)), placeholder: t("keyUpper") }),
									createElement("input", { value: e.value, onChange: (ev) => setEnvList(envList.map((v, idx) => idx === i ? { ...v, value: ev.target.value } : v)), placeholder: t("valueUpper") }),
									createElement("button", { className: "mm_btn", onClick: () => setEnvList(envList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setEnvList([...envList, { key: "", value: "" }]), disabled: busy }, t("addEnvironment")),
							),
							createElement("label", { className: "wide" }, t("cwd"),
								createElement("input", { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: t("cwdPlaceholder") })),
						]
						: [
							createElement("label", { className: "wide" }, t("url"),
								createElement("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: t("urlPlaceholder") })),
							createElement("label", { className: "wide" }, t("authMode"),
								createElement("select", { value: authMode, onChange: (e) => setAuthMode(e.target.value) },
									createElement("option", { value: "oauth" }, t("oauth")),
									createElement("option", { value: "static" }, t("bearer")),
									createElement("option", { value: "none" }, t("noAuthOption")))),
							authMode === "static"
								? createElement("label", { className: "wide" }, t("tokenEnv"),
									createElement("input", { value: tokenEnv, onChange: (e) => setTokenEnv(e.target.value), placeholder: t("tokenEnvPlaceholder") }))
								: null,
							authMode === "oauth"
								? [
									createElement("label", null, t("clientId"),
										createElement("input", { value: clientId, onChange: (e) => setClientId(e.target.value), placeholder: "Ov23li…" })),
									createElement("label", null, t("clientSecretEnv"),
										createElement("input", { value: clientSecretEnv, onChange: (e) => setClientSecretEnv(e.target.value), placeholder: "GITHUB_OAUTH_CLIENT_SECRET" })),
									createElement("label", { className: "wide" }, t("oauthScope"),
										createElement("input", { value: oauthScope, onChange: (e) => setOauthScope(e.target.value), placeholder: "repo read:org" })),
								]
								: null,
							createElement("label", { className: "wide" }, t("headers"),
								...headersList.map((e, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: e.key, onChange: (ev) => setHeadersList(headersList.map((v, idx) => idx === i ? { ...v, key: ev.target.value } : v)), placeholder: t("key") }),
									createElement("input", { value: e.value, onChange: (ev) => setHeadersList(headersList.map((v, idx) => idx === i ? { ...v, value: ev.target.value } : v)), placeholder: t("value") }),
									createElement("button", { className: "mm_btn", onClick: () => setHeadersList(headersList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setHeadersList([...headersList, { key: "", value: "" }]), disabled: busy }, t("addHeader")),
							),
							createElement("label", { className: "wide" }, t("headerEnv"),
								...headerEnvList.map((e, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: e.key, onChange: (ev) => setHeaderEnvList(headerEnvList.map((v, idx) => idx === i ? { ...v, key: ev.target.value } : v)), placeholder: t("key") }),
									createElement("input", { value: e.value, onChange: (ev) => setHeaderEnvList(headerEnvList.map((v, idx) => idx === i ? { ...v, value: ev.target.value } : v)), placeholder: t("envName") }),
									createElement("button", { className: "mm_btn", onClick: () => setHeaderEnvList(headerEnvList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setHeaderEnvList([...headerEnvList, { key: "", value: "" }]), disabled: busy }, t("addVariable")),
							),
						],
				),
				error ? createElement("div", { className: "mm_err" }, error) : null,
				createElement("div", { className: "mm_actions" },
					createElement("button", { className: "mm_btn", onClick: submit, disabled: busy || !name || (isWorkspace && !wsPath) || (type === "stdio" ? !command : !url) }, busy ? "…" : t("save")),
					createElement("button", { className: "mm_btn", onClick: onCancel, disabled: busy }, t("cancel")),
				),
			);
		}

		function WorkspaceServerRow({ t, server, workspacePath, onChanged, onEdit }) {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const [confirming, setConfirming] = react.useState(false);
			const startAuth = async () => {
				setBusy(true); setError("");
				try {
					const r = await api("/workspaces/auth", { method: "POST", body: JSON.stringify({ path: workspacePath, name: server.name }) });
					if (r.ok && r.body.authorizeUrl) window.open(r.body.authorizeUrl, "_blank");
					else setError(r.body.error || t("authFailed", { status: r.status }));
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const remove = async () => {
				setConfirming(false);
				setBusy(true); setError("");
				try {
					const r = await api("/workspaces/servers/delete", { method: "POST", body: JSON.stringify({ path: workspacePath, name: server.name }) });
					if (!r.ok) setError(r.body.error || t("deleteFailed", { status: r.status }));
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			return createElement("div", { className: "mm_row", key: server.name },
				createElement("div", { className: "mm_rowHead" },
					createElement("span", { className: "mm_name" }, server.name),
					createElement("span", { className: `mm_statusDot ${server.status}`, "aria-hidden": "true" }),
					createElement("span", { className: `mm_badge ${server.status}` }, t(server.status)),
					createElement("span", { className: "mm_actions" },
						server.authMode === "oauth" && (server.status === "needs-auth" || server.status === "error" || server.status === "connected")
							? createElement("button", { className: "mm_btn", onClick: startAuth, disabled: busy }, busy ? "…" : server.status === "connected" ? t("reauth") : t("auth"))
							: null,
						createElement("button", { className: "mm_btn", onClick: onEdit, disabled: busy }, t("edit")),
						createElement("button", { className: "mm_btn danger", onClick: () => setConfirming(true), disabled: busy }, t("delete")),
					),
				),
				createElement("div", { className: "mm_url" }, server.type === "stdio"
					? `stdio · ${server.command} ${(server.args || []).join(" ")}`
					: `${server.authMode === "oauth" ? "OAuth" : server.authMode === "none" ? t("noAuth") : t("staticToken")} · ${server.url}`),
				server.status === "connected" ? createElement("div", { className: "mm_meta" }, t("toolCount", { count: server.toolCount })) : null,
				server.error ? createElement("div", { className: "mm_err" }, server.error) : null,
				error ? createElement("div", { className: "mm_err" }, error) : null,
				createElement(AttemptLog, { t, serverId: server.id, key: "logs" }),
				confirming ? createElement("div", { className: "mm_overlay", onClick: () => setConfirming(false) },
					createElement("div", { className: "mm_dialog", onClick: (e) => e.stopPropagation() },
						createElement("div", { className: "mm_dialogTitle" }, t("deleteWorkspaceServer")),
						createElement("div", { className: "mm_dialogBody" }, t("confirmWorkspaceDelete", { name: server.name })),
						createElement("div", { className: "mm_dialogActions" },
							createElement("button", { className: "mm_btn", onClick: () => setConfirming(false), disabled: busy }, t("cancel")),
							createElement("button", { className: "mm_btn danger", onClick: remove, disabled: busy }, busy ? "…" : t("delete")),
						),
					),
				) : null,
			);
		}

		function GlobalMaskRow({ t, server, excluded, onToggleExclude, onEdit, busy }) {
			return createElement("div", { className: "mm_wsServer", key: server.id },
				createElement("span", { className: `mm_statusDot ${server.status}`, "aria-hidden": "true" }),
				createElement("span", { className: "mm_name" }, server.name),
				createElement("span", { className: `mm_badge ${server.status}` }, t(server.status)),
				createElement("label", { className: "mm_wsCheck" },
					createElement("input", { type: "checkbox", checked: excluded, disabled: busy, onChange: (e) => onToggleExclude(server.name, e.target.checked) }),
					createElement("span", null, t("hide")),
				),
				createElement("button", { className: "mm_btn", onClick: onEdit, disabled: busy }, t("edit")),
			);
		}

		function McpContent({ t }) {
			const [servers, setServers] = react.useState([]);
			const [workspaces, setWorkspaces] = react.useState([]);
			const [settings, setSettings] = react.useState({ onDemandToolInjection: false });
			const [selected, setSelected] = react.useState("");
			const [view, setView] = react.useState("list"); // list | add | edit-global | edit-ws
			const [editingId, setEditingId] = react.useState(null);
			const [editingName, setEditingName] = react.useState(null);
			const [query, setQuery] = react.useState("");
			const [expandedId, setExpandedId] = react.useState(null);
			const [excludeBusy, setExcludeBusy] = react.useState(false);
			const [settingsBusy, setSettingsBusy] = react.useState(false);
			const [settingsError, setSettingsError] = react.useState("");
			const refresh = react.useCallback(() => {
				Promise.all([api("/servers"), api("/workspaces"), api("/settings")]).then(([sr, wr, tr]) => {
					if (sr.ok) setServers(sr.body.servers ?? []);
					if (wr.ok) setWorkspaces(wr.body.workspaces ?? []);
					if (tr.ok) setSettings({ onDemandToolInjection: tr.body.onDemandToolInjection === true });
				}).catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
				const t = setInterval(refresh, 3000);
				return () => clearInterval(t);
			}, [refresh]);
			// Drop the selection if the workspace disappeared.
			react.useEffect(() => {
				if (selected && !workspaces.some((w) => w.path === selected)) setSelected("");
			}, [workspaces, selected]);

			const selectedWs = workspaces.find((w) => w.path === selected) ?? null;
			const wsServers = selectedWs?.servers ?? [];
			const excludeSet = new Set(selectedWs?.exclude ?? []);
			const normalizedQuery = query.trim().toLocaleLowerCase();
			const filteredServers = servers.filter((s) => s.name.toLocaleLowerCase().includes(normalizedQuery));

			const toggleExclude = async (serverName, exclude) => {
				if (!selected) return;
				setExcludeBusy(true);
				try {
					const r = await api("/workspaces/exclude", { method: "POST", body: JSON.stringify({ path: selected, server: serverName, exclude }) });
					if (r.ok) refresh();
				} catch (e) { /* transient */ }
				setExcludeBusy(false);
			};

			const toggleOnDemand = async () => {
				setSettingsBusy(true); setSettingsError("");
				try {
					const enabled = !settings.onDemandToolInjection;
					const r = await api("/settings/on-demand", { method: "POST", body: JSON.stringify({ enabled }) });
					if (r.ok) setSettings({ onDemandToolInjection: r.body.onDemandToolInjection === true });
					else setSettingsError(r.body.error || t("toggleFailed", { status: r.status }));
				} catch (e) { setSettingsError(String(e)); }
				setSettingsBusy(false);
			};

			const addBtn = createElement("button", { className: "mm_addBtn", type: "button", "aria-label": t("addServer"), title: t("addServer"), onClick: () => setView("add") },
				createElement("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					createElement("path", { d: "M8 3.5v9", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
					createElement("path", { d: "M3.5 8h9", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
				),
			);

			if (view === "add") {
				return createElement("div", { className: "mm_section" },
					createElement("div", { className: "mm_catalogHeading" }, createElement("h3", null, t("addServer"))),
					react.createElement(ServerForm, { t, scope: selected ? "workspace" : "user", workspacePath: selected || "", workspaces: workspaces.map((w) => w.path), onDone: () => { setView("list"); refresh(); }, onCancel: () => setView("list") }),
				);
			}
			const globalEditing = view === "edit-global" ? (servers.find((s) => s.id === editingId) ?? null) : null;
			if (view === "edit-global" && globalEditing) {
				return createElement("div", { className: "mm_section" },
					createElement("div", { className: "mm_catalogHeading" }, createElement("h3", null, t("editGlobal"))),
					react.createElement(ServerForm, { t, initial: globalEditing, scope: "user", onDone: () => { setView("list"); refresh(); }, onCancel: () => setView("list") }),
				);
			}
			const wsEditing = view === "edit-ws" && selectedWs ? (selectedWs.servers.find((s) => s.name === editingName) ?? null) : null;
			if (view === "edit-ws" && selected && wsEditing) {
				return createElement("div", { className: "mm_section" },
					createElement("div", { className: "mm_catalogHeading" }, createElement("h3", null, t("editWorkspace"))),
					createElement("div", { className: "mm_wsPathHint" }, selected),
					react.createElement(ServerForm, { t, initial: wsEditing, scope: "workspace", workspacePath: selected, onDone: () => { setView("list"); refresh(); }, onCancel: () => setView("list") }),
				);
			}

			return createElement("div", { className: "mm_section" },
				createElement("div", { className: "mm_catalogHeading" },
					createElement("h3", null, t("servers")),
					createElement("span", null, selected ? (servers.length + wsServers.length) : servers.length),
					createElement("span", { className: "mm_addActions" }, addBtn),
				),
				createElement("div", { className: "mm_feature" },
					createElement("span", { className: "mm_featureText" },
						createElement("span", { className: "mm_featureTitle" }, t("onDemand")),
						createElement("span", { className: "mm_featureMeta" }, t("onDemandHelp")),
					),
					createElement("span", { className: "mm_switchRow" },
						createElement("button", { className: "mm_switch", type: "button", role: "switch", "data-on": settings.onDemandToolInjection ? "true" : undefined, "aria-checked": settings.onDemandToolInjection, "aria-label": t("onDemand"), onClick: toggleOnDemand, disabled: settingsBusy },
							createElement("span", { className: "mm_switchThumb" }),
						),
						createElement("span", { className: "mm_switchText" }, settings.onDemandToolInjection ? t("on") : t("off")),
					),
				),
				settingsError ? createElement("div", { className: "mm_err" }, settingsError) : null,
				createElement("div", { className: "mm_wsBar" },
					createElement("select", { className: "mm_wsSelect", value: selected, onChange: (e) => { setSelected(e.target.value); setExpandedId(null); setQuery(""); } },
						createElement("option", { value: "" }, t("global")),
						workspaces.map((w) => createElement("option", { value: w.path, key: w.path }, w.path.split("/").filter(Boolean).pop() || w.path)),
					),
				),
				selected ? createElement("div", { className: "mm_wsPathHint" }, selected) : null,
				selectedWs?.error ? createElement("div", { className: "mm_err" }, selectedWs.error) : null,
				selected
					? [
						createElement("div", { className: "mm_groupTitle" }, t("workspaceServers")),
						wsServers.length > 0
							? createElement("div", { className: "mm_wsList" },
								wsServers.map((s) => react.createElement(WorkspaceServerRow, { t, server: s, workspacePath: selected, onChanged: refresh, onEdit: () => { setEditingName(s.name); setView("edit-ws"); }, key: s.name })),
							)
							: createElement("div", { className: "mm_meta" }, t("emptyWorkspace")),
						createElement("div", { className: "mm_groupTitle" }, t("globalServers")),
						servers.length > 0
							? createElement("div", { className: "mm_wsList" },
								servers.map((g) => react.createElement(GlobalMaskRow, { t, server: g, excluded: excludeSet.has(g.name), onToggleExclude: toggleExclude, onEdit: () => { setEditingId(g.id); setView("edit-global"); }, busy: excludeBusy, key: g.id })),
							)
							: createElement("div", { className: "mm_meta" }, t("emptyGlobal")),
					]
					: [
						createElement("label", { className: "mm_search" },
							createElement("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
								createElement("circle", { cx: "7", cy: "7", r: "5", stroke: "currentColor", strokeWidth: "1.5" }),
								createElement("path", { d: "M11 11l3 3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
							),
							createElement("input", { type: "search", value: query, placeholder: t("search"), "aria-label": t("search"), onChange: (e) => setQuery(e.target.value) }),
						),
						createElement("div", { className: "mm_cards" },
							filteredServers.map((s) => react.createElement(ServerRow, { t, server: s, onChanged: refresh, onEdit: () => { setEditingId(s.id); setView("edit-global"); }, open: expandedId === s.id, onToggle: () => setExpandedId(expandedId === s.id ? null : s.id), key: s.id })),
						),
					],
			);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("mcp", { zh, en }), "dsh-mcp-manager: dictionaries");
			const t = ctx.locale.bind("mcp");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mcp-manager",
				order: 50,
				label: () => t("sectionLabel"),
				locale: "mcp",
			}, McpContent));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
