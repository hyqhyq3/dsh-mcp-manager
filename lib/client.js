window.__ModuleLoader__.load({
	id: "dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;

		const inject = ["slots"];

		const css = ".mm_section{display:flex;flex-direction:column;gap:16px;padding:0 24px 24px}.mm_row{display:flex;flex-direction:column;gap:10px;border:1px solid rgba(128,128,128,.3);border-radius:12px;padding:14px 16px}.mm_rowHead{display:flex;align-items:center;gap:10px}.mm_name{font-weight:600;font-size:14px}.mm_url{color:var(--dsw-alias-label-secondary, #888);font-size:12px;word-break:break-all}.mm_badge{font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4)}.mm_badge.connected{color:#2e7d32;border-color:#2e7d32}.mm_badge.needs-auth{color:#ed6c02;border-color:#ed6c02}.mm_badge.error{color:#c62828;border-color:#c62828}.mm_badge.connecting,.mm_badge.authorizing,.mm_badge.disabled{color:#888}.mm_actions{margin-left:auto;display:flex;gap:8px}.mm_btn{cursor:pointer;font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}.mm_btn:hover{background:rgba(128,128,128,.12)}.mm_btn:disabled{opacity:.5;cursor:default}.mm_btn.primary{border-color:transparent;background:var(--dsw-alias-interactive-bg-active,#2563eb);color:#fff}.mm_err{color:#c62828;font-size:12px}.mm_meta{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}.mm_form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mm_form label{display:flex;flex-direction:column;gap:4px;font-size:12px}.mm_form input,.mm_form select{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}.mm_form .wide{grid-column:1 / -1}.mm_add{border-style:dashed}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-mcp-manager/section\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mcp-manager";
			tag.dataset.pluginCss = "dsh-mcp-manager/section";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const STATUS_LABEL = {
			connected: "已连接",
			"needs-auth": "待认证",
			authorizing: "认证中",
			connecting: "连接中",
			error: "错误",
			disconnected: "未连接",
			disabled: "已禁用",
		};

		function api(path, options) {
			return fetch("/mcp-manager/api" + path, {
				headers: { "Content-Type": "application/json" },
				...options,
			}).then(async (resp) => ({ ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) }));
		}

		function ServerRow({ server, onChanged, onEdit }) {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");

			const startAuth = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/auth`, { method: "POST" });
					if (r.ok && r.body.authorizeUrl) { window.open(r.body.authorizeUrl, "_blank"); }
					else setError(r.body.error || `认证启动失败 (HTTP ${r.status})`);
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const remove = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}`, { method: "DELETE" });
					if (!r.ok) setError(r.body.error || `删除失败 (HTTP ${r.status})`);
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const toggleEnabled = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: server.enabled === false }) });
					if (!r.ok) setError(r.body.error || `${server.enabled === false ? "启用" : "禁用"}失败 (HTTP ${r.status})`);
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			return createElement("div", { className: "mm_row", key: server.id },
				createElement("div", { className: "mm_rowHead" },
					createElement("span", { className: "mm_name" }, server.name),
					createElement("span", { className: `mm_badge ${server.status}` }, STATUS_LABEL[server.status] ?? server.status),
					server.status === "connected" ? createElement("span", { className: "mm_meta" }, `${server.toolCount} 个工具`) : null,
					createElement("span", { className: "mm_actions" },
						server.enabled !== false && server.authMode === "oauth"
							? createElement("button", { className: "mm_btn primary", onClick: startAuth, disabled: busy }, busy ? "…" : server.status === "connected" ? "重新认证" : "去认证")
							: null,
						createElement("button", { className: "mm_btn", onClick: toggleEnabled, disabled: busy }, busy ? "…" : server.enabled === false ? "启用" : "禁用"),
						createElement("button", { className: "mm_btn", onClick: onEdit, disabled: busy }, "编辑"),
						createElement("button", { className: "mm_btn", onClick: remove, disabled: busy }, "删除"),
					),
				),
				createElement("div", { className: "mm_url" }, server.type === "stdio"
					? `stdio · ${server.command} ${(server.args || []).join(" ")}`
					: `${server.authMode === "oauth" ? "OAuth" : "静态 Token"} · ${server.url}`),
				server.error ? createElement("div", { className: "mm_err" }, server.error) : null,
				error ? createElement("div", { className: "mm_err" }, error) : null,
			);
		}

		function ServerForm({ initial, onDone, onCancel }) {
			const editing = initial != null;
			const [open, setOpen] = react.useState(false);
			const [type, setType] = react.useState(initial?.type ?? "http");
			const [name, setName] = react.useState(initial?.name ?? "");
			const [url, setUrl] = react.useState(initial?.url ?? "");
			const [authMode, setAuthMode] = react.useState(initial?.authMode ?? "oauth");
			const [token, setToken] = react.useState("");
			const [command, setCommand] = react.useState(initial?.command ?? "");
			const [args, setArgs] = react.useState((initial?.args ?? []).join(" "));
			const [env, setEnv] = react.useState(initial?.env ? JSON.stringify(initial.env) : "");
			const [cwd, setCwd] = react.useState(initial?.cwd ?? "");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");

			const submit = async () => {
				setBusy(true); setError("");
				try {
					const body = type === "stdio"
						? { name, type: "stdio", command, args, env, cwd }
						: { name, type: "http", url, authMode, token };
					const r = editing
						? await api(`/servers/${initial.id}`, { method: "PUT", body: JSON.stringify(body) })
						: await api("/servers", { method: "POST", body: JSON.stringify(body) });
					if (r.ok) {
						if (editing) onDone();
						else { setName(""); setUrl(""); setToken(""); setCommand(""); setArgs(""); setEnv(""); setCwd(""); setOpen(false); onDone(); }
					} else setError(r.body.error || `${editing ? "保存" : "添加"}失败 (HTTP ${r.status})`);
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			if (!editing && !open) return createElement("button", { className: "mm_btn", onClick: () => setOpen(true) }, "＋ 添加 MCP 服务器");
			return createElement("div", { className: "mm_row mm_add" },
				editing ? createElement("div", { className: "mm_meta" }, `编辑 · ${initial.name}`) : null,
				createElement("div", { className: "mm_form" },
					createElement("label", null, "类型",
						createElement("select", { value: type, onChange: (e) => setType(e.target.value) },
							createElement("option", { value: "http" }, "HTTP（远程服务器）"),
							createElement("option", { value: "stdio" }, "stdio（本地进程）"))),
					createElement("label", null, "名称",
						createElement("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "odin" })),
					type === "stdio"
						? [
							createElement("label", { className: "wide" }, "命令 command（可执行程序）",
								createElement("input", { value: command, onChange: (e) => setCommand(e.target.value), placeholder: "npx" })),
							createElement("label", { className: "wide" }, "参数 args（用空格分隔，可用引号包住含空格的参数）",
								createElement("input", { value: args, onChange: (e) => setArgs(e.target.value), placeholder: "-y @modelcontextprotocol/server-filesystem /path" })),
							createElement("label", { className: "wide" }, "环境变量 env（可选，JSON 对象）",
								createElement("input", { value: env, onChange: (e) => setEnv(e.target.value), placeholder: '{"API_KEY":"..."}' })),
							createElement("label", { className: "wide" }, "工作目录 cwd（可选）",
								createElement("input", { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: "/path/to/project" })),
						]
						: [
							createElement("label", { className: "wide" }, "认证方式",
								createElement("select", { value: authMode, onChange: (e) => setAuthMode(e.target.value) },
									createElement("option", { value: "oauth" }, "OAuth（浏览器跳转认证）"),
									createElement("option", { value: "static" }, "静态 Bearer Token"))),
							createElement("label", { className: "wide" }, "MCP 服务器 URL",
								createElement("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "https://example.com/mcp" })),
							authMode === "static"
								? createElement("label", { className: "wide" }, "Bearer Token",
									createElement("input", { value: token, onChange: (e) => setToken(e.target.value), placeholder: "粘贴 token" }))
								: null,
						],
				),
				error ? createElement("div", { className: "mm_err" }, error) : null,
				createElement("div", { className: "mm_actions" },
					createElement("button", { className: "mm_btn", onClick: submit, disabled: busy || !name || (type === "stdio" ? !command : !url) }, busy ? "…" : "保存"),
					createElement("button", { className: "mm_btn", onClick: () => (editing ? onCancel() : setOpen(false)), disabled: busy }, "取消"),
				),
			);
		}

		function McpSection() {
			const [servers, setServers] = react.useState([]);
			const [editingId, setEditingId] = react.useState(null);
			const refresh = react.useCallback(() => {
				api("/servers").then((r) => { if (r.ok) setServers(r.body.servers ?? []); }).catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
				const t = setInterval(refresh, 3000);
				return () => clearInterval(t);
			}, [refresh]);
			return createElement("div", { className: "mm_section" },
				createElement("div", null,
					createElement("p", { className: "mm_meta" }, "管理 MCP 服务器：HTTP 服务器（OAuth 点「去认证」登录 / 静态 Token）与 stdio 本地进程（如 npx / uvx）均可；连接后自动注册 mcp__前缀__ 工具。"),
				),
				servers.map((s) => editingId === s.id
					? react.createElement(ServerForm, { initial: s, onDone: () => { setEditingId(null); refresh(); }, onCancel: () => setEditingId(null), key: s.id })
					: react.createElement(ServerRow, { server: s, onChanged: refresh, onEdit: () => setEditingId(s.id), key: s.id })),
				editingId == null ? react.createElement(ServerForm, { onDone: refresh, onCancel: () => {} }) : null,
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mcp-manager",
				order: 50,
				label: "MCP",
			}, McpSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
