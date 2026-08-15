window.__ModuleLoader__.load({
	id: "dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;

		const inject = ["slots"];

		const css = ".mm_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}.mm_row{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}.mm_rowHead{display:flex;align-items:center;gap:8px}.mm_name{font-weight:600;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.mm_url{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}.mm_statusDot{background:var(--dsw-alias-label-tertiary);border-radius:999px;flex:none;width:7px;height:7px;display:inline-block}.mm_statusDot.connected{background:var(--dsw-alias-state-success-primary)}.mm_statusDot.needs-auth,.mm_statusDot.authorizing,.mm_statusDot.connecting{background:var(--dsw-alias-state-business-primary)}.mm_statusDot.error{background:var(--dsw-alias-state-error-primary)}.mm_badge{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);border-radius:5px;align-items:center;padding:1px 8px;font-size:11px;line-height:16px;display:inline-flex}.mm_badge.connected{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}.mm_badge.error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}.mm_badge.needs-auth,.mm_badge.authorizing,.mm_badge.connecting{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);color:var(--dsw-alias-state-business-primary)}.mm_badge.disabled{color:var(--dsw-alias-label-tertiary)}.mm_actions{margin-left:auto;display:flex;gap:6px}.mm_btn{cursor:pointer;font-size:12px;line-height:18px;padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}.mm_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.mm_btn:disabled{opacity:.5;cursor:default}.mm_btn.primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}.mm_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.mm_meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.mm_form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mm_form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}.mm_form input,.mm_form select{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.mm_form input::placeholder,.mm_form select::placeholder{color:var(--dsw-alias-label-tertiary)}.mm_form select option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}.mm_form .wide{grid-column:1 / -1}.mm_add{border-style:dashed}.mm_kv{display:flex;gap:6px;align-items:center}.mm_kv input{flex:1}.mm_kv .mm_btn{flex:none}.mm_catalogHeading{align-items:baseline;gap:7px;padding:0 2px;display:flex}.mm_catalogHeading h3{font-size:18px;font-weight:600;line-height:26px;margin:0}.mm_catalogHeading span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}.mm_cards{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;display:grid}.mm_cardContent{width:100%;align-items:center;gap:8px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;padding:0;display:flex;text-align:left}.mm_chevron{color:var(--dsw-alias-label-tertiary);flex:none;margin-left:auto;transition:transform .15s;display:inline-flex}.mm_chevron[data-open=true]{transform:rotate(180deg)}.mm_details{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding-top:10px;margin-top:10px;display:flex}.mm_cardTrailing{flex:none;align-items:center;gap:7px;display:inline-flex}.mm_addActions{margin-left:auto;display:inline-flex}.mm_addBtn{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0;display:inline-flex;align-items:center;justify-content:center}.mm_addBtn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.mm_overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000}.mm_dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv1);padding:20px;max-width:360px;width:100%;display:flex;flex-direction:column;gap:12px}.mm_dialogTitle{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}.mm_dialogBody{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.mm_dialogActions{display:flex;justify-content:flex-end;gap:8px}.mm_btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.mm_btn.danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}.mm_cardActions{display:flex;align-items:center;gap:8px}.mm_switchRow{align-items:center;gap:8px;display:inline-flex}.mm_switch{box-sizing:border-box;width:36px;height:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:999px;cursor:pointer;padding:0;position:relative;flex:none;transition:background-color .2s ease,border-color .2s ease}.mm_switch:disabled{cursor:default;opacity:.6}.mm_switch[data-on=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary)}.mm_switchThumb{box-sizing:border-box;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);position:absolute;top:2px;left:2px;transition:transform .22s cubic-bezier(.34,1.56,.64,1),background-color .18s ease}.mm_switch[data-on=true] .mm_switchThumb{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground)}.mm_switchText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.mm_actionBtns{margin-left:auto;display:flex;gap:6px}.mm_search{width:100%;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative}.mm_search>svg{pointer-events:none;position:absolute;left:12px}.mm_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 34px 0 36px;font-size:13px}.mm_search input::placeholder{color:var(--dsw-alias-label-tertiary)}.mm_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}body[data-ds-dark-theme] .mm_switchThumb{background:#fff}body[data-ds-dark-theme] .mm_switch[data-on=true] .mm_switchThumb{background:#fff}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-mcp-manager/section\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mcp-manager";
			tag.dataset.pluginCss = "dsh-mcp-manager/section";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const STATUS_LABEL = {
			connected: "已启用",
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

		function ServerRow({ server, onChanged, onEdit, open, onToggle }) {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const [confirming, setConfirming] = react.useState(false);

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
				setConfirming(false);
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}`, { method: "DELETE" });
					if (!r.ok) setError(r.body.error || `删除失败 (HTTP ${r.status})`);
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const askRemove = () => setConfirming(true);
			const toggleEnabled = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: server.enabled === false }) });
					if (!r.ok) setError(r.body.error || `${server.enabled === false ? "启用" : "禁用"}失败 (HTTP ${r.status})`);
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			return createElement("div", { className: "mm_row", key: server.id, "data-open": open ? "true" : undefined },
				createElement("button", { className: "mm_cardContent", type: "button", "aria-expanded": open, onClick: onToggle },
					createElement("span", { className: "mm_name" }, server.name),
					createElement("span", { className: "mm_cardTrailing" },
						createElement("span", { className: `mm_statusDot ${server.status}`, "aria-hidden": "true" }),
						createElement("span", { className: `mm_badge ${server.status}` }, STATUS_LABEL[server.status] ?? server.status),
						createElement("span", { className: "mm_chevron", "data-open": open ? "true" : undefined },
							createElement("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
								createElement("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }),
							),
						),
					),
				),
				open ? createElement("div", { className: "mm_details" },
					createElement("div", { className: "mm_url" }, server.type === "stdio"
						? `stdio · ${server.command} ${(server.args || []).join(" ")}`
						: `${server.authMode === "oauth" ? "OAuth" : "静态 Token"} · ${server.url}`),
					server.status === "connected" ? createElement("div", { className: "mm_meta" }, `${server.toolCount} 个工具`) : null,
					server.error ? createElement("div", { className: "mm_err" }, server.error) : null,
					error ? createElement("div", { className: "mm_err" }, error) : null,
					createElement("div", { className: "mm_cardActions" },
						createElement("span", { className: "mm_switchRow" },
							createElement("button", { className: "mm_switch", type: "button", role: "switch", "data-on": server.enabled !== false ? "true" : undefined, "aria-checked": server.enabled !== false, onClick: toggleEnabled, disabled: busy },
								createElement("span", { className: "mm_switchThumb" }),
							),
							createElement("span", { className: "mm_switchText" }, server.enabled !== false ? "停用" : "启用"),
						),
						createElement("span", { className: "mm_actionBtns" },
							server.enabled !== false && server.authMode === "oauth"
								? createElement("button", { className: "mm_btn", onClick: startAuth, disabled: busy }, busy ? "…" : server.status === "connected" ? "重新认证" : "去认证")
								: null,
							createElement("button", { className: "mm_btn", onClick: onEdit, disabled: busy }, "编辑"),
							createElement("button", { className: "mm_btn danger", onClick: askRemove, disabled: busy }, "删除"),
						),
					),
				) : null,
				confirming ? createElement("div", { className: "mm_overlay", onClick: () => setConfirming(false) },
					createElement("div", { className: "mm_dialog", onClick: (e) => e.stopPropagation() },
						createElement("div", { className: "mm_dialogTitle" }, "删除 MCP 服务器"),
						createElement("div", { className: "mm_dialogBody" }, `确定要删除「${server.name}」吗？此操作不可恢复。`),
						createElement("div", { className: "mm_dialogActions" },
							createElement("button", { className: "mm_btn", onClick: () => setConfirming(false), disabled: busy }, "取消"),
							createElement("button", { className: "mm_btn danger", onClick: remove, disabled: busy }, busy ? "…" : "删除"),
						),
					),
				) : null,
			);
		}

		function ServerForm({ initial, onDone, onCancel }) {
			const editing = initial != null;
			const [type, setType] = react.useState(initial?.type ?? "http");
			const [name, setName] = react.useState(initial?.name ?? "");
			const [url, setUrl] = react.useState(initial?.url ?? "");
			const [authMode, setAuthMode] = react.useState(initial?.authMode ?? "oauth");
			const [tokenEnv, setTokenEnv] = react.useState(initial?.tokenEnv ?? "");
			const [headersList, setHeadersList] = react.useState(initial?.headers ? Object.entries(initial.headers).map(([k, v]) => ({ key: k, value: String(v) })) : [{ key: "", value: "" }]);
			const [headerEnvList, setHeaderEnvList] = react.useState(initial?.headerEnv ? Object.entries(initial.headerEnv).map(([k, v]) => ({ key: k, value: String(v) })) : [{ key: "", value: "" }]);
			const [command, setCommand] = react.useState(initial?.command ?? "");
			const [argsList, setArgsList] = react.useState((initial?.args ?? []).length ? initial.args.map(String) : [""]);
			const [envList, setEnvList] = react.useState(initial?.env ? Object.entries(initial.env).map(([k, v]) => ({ key: k, value: String(v) })) : [{ key: "", value: "" }]);
			const [cwd, setCwd] = react.useState(initial?.cwd ?? "");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");

			const submit = async () => {
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
						};
					const r = editing
						? await api(`/servers/${initial.id}`, { method: "PUT", body: JSON.stringify(body) })
						: await api("/servers", { method: "POST", body: JSON.stringify(body) });
					if (r.ok) onDone();
					else setError(r.body.error || `${editing ? "保存" : "添加"}失败 (HTTP ${r.status})`);
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			return createElement("div", { className: "mm_row mm_add" },
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
							createElement("label", { className: "wide" }, "参数 arguments",
								...argsList.map((arg, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: arg, onChange: (e) => setArgsList(argsList.map((v, idx) => idx === i ? e.target.value : v)), placeholder: "参数值" }),
									createElement("button", { className: "mm_btn", onClick: () => setArgsList(argsList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setArgsList([...argsList, ""]), disabled: busy }, "＋ 添加参数"),
							),
							createElement("label", { className: "wide" }, "环境变量 environment variables",
								...envList.map((e, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: e.key, onChange: (ev) => setEnvList(envList.map((v, idx) => idx === i ? { ...v, key: ev.target.value } : v)), placeholder: "键 KEY" }),
									createElement("input", { value: e.value, onChange: (ev) => setEnvList(envList.map((v, idx) => idx === i ? { ...v, value: ev.target.value } : v)), placeholder: "值 VALUE" }),
									createElement("button", { className: "mm_btn", onClick: () => setEnvList(envList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setEnvList([...envList, { key: "", value: "" }]), disabled: busy }, "＋ 添加环境变量"),
							),
							createElement("label", { className: "wide" }, "工作目录 cwd（可选）",
								createElement("input", { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: "/path/to/project" })),
						]
						: [
							createElement("label", { className: "wide" }, "MCP 服务器 URL",
								createElement("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "https://mcp.example.com/mcp" })),
							createElement("label", { className: "wide" }, "认证方式",
								createElement("select", { value: authMode, onChange: (e) => setAuthMode(e.target.value) },
									createElement("option", { value: "oauth" }, "OAuth（浏览器跳转认证）"),
									createElement("option", { value: "static" }, "静态 Bearer Token"))),
							authMode === "static"
								? createElement("label", { className: "wide" }, "Bearer 令牌环境变量（填变量名，不填明文）",
									createElement("input", { value: tokenEnv, onChange: (e) => setTokenEnv(e.target.value), placeholder: "MCP_BEARER_TOKEN" }))
								: null,
							createElement("label", { className: "wide" }, "标头 Headers",
								...headersList.map((e, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: e.key, onChange: (ev) => setHeadersList(headersList.map((v, idx) => idx === i ? { ...v, key: ev.target.value } : v)), placeholder: "键 Key" }),
									createElement("input", { value: e.value, onChange: (ev) => setHeadersList(headersList.map((v, idx) => idx === i ? { ...v, value: ev.target.value } : v)), placeholder: "值 Value" }),
									createElement("button", { className: "mm_btn", onClick: () => setHeadersList(headersList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setHeadersList([...headersList, { key: "", value: "" }]), disabled: busy }, "＋ 添加标头"),
							),
							createElement("label", { className: "wide" }, "来自环境变量的标头（值填环境变量名）",
								...headerEnvList.map((e, i) => createElement("div", { className: "mm_kv", key: i },
									createElement("input", { value: e.key, onChange: (ev) => setHeaderEnvList(headerEnvList.map((v, idx) => idx === i ? { ...v, key: ev.target.value } : v)), placeholder: "键 Key" }),
									createElement("input", { value: e.value, onChange: (ev) => setHeaderEnvList(headerEnvList.map((v, idx) => idx === i ? { ...v, value: ev.target.value } : v)), placeholder: "环境变量名" }),
									createElement("button", { className: "mm_btn", onClick: () => setHeaderEnvList(headerEnvList.filter((_, idx) => idx !== i)), disabled: busy }, "✕"),
								)),
								createElement("button", { className: "mm_btn", onClick: () => setHeaderEnvList([...headerEnvList, { key: "", value: "" }]), disabled: busy }, "＋ 添加变量"),
							),
						],
				),
				error ? createElement("div", { className: "mm_err" }, error) : null,
				createElement("div", { className: "mm_actions" },
					createElement("button", { className: "mm_btn", onClick: submit, disabled: busy || !name || (type === "stdio" ? !command : !url) }, busy ? "…" : "保存"),
					createElement("button", { className: "mm_btn", onClick: onCancel, disabled: busy }, "取消"),
				),
			);
		}

		function McpSection() {
			const [servers, setServers] = react.useState([]);
			const [editingId, setEditingId] = react.useState(null);
			const [view, setView] = react.useState("list");
			const [query, setQuery] = react.useState("");
			const [expandedId, setExpandedId] = react.useState(null);
			const refresh = react.useCallback(() => {
				api("/servers").then((r) => { if (r.ok) setServers(r.body.servers ?? []); }).catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
				const t = setInterval(refresh, 3000);
				return () => clearInterval(t);
			}, [refresh]);
			const editingServer = view === "edit" ? (servers.find((s) => s.id === editingId) ?? null) : null;
			const normalizedQuery = query.trim().toLocaleLowerCase();
			const filteredServers = servers.filter((s) => s.name.toLocaleLowerCase().includes(normalizedQuery));
			if (view === "add") {
				return createElement("div", { className: "mm_section" },
					createElement("div", { className: "mm_catalogHeading" },
						createElement("h3", null, "添加 MCP 服务器"),
					),
					react.createElement(ServerForm, { onDone: () => { setView("list"); refresh(); }, onCancel: () => setView("list") }),
				);
			}
			if (view === "edit" && editingServer) {
				return createElement("div", { className: "mm_section" },
					createElement("div", { className: "mm_catalogHeading" },
						createElement("h3", null, "编辑 MCP 服务器"),
					),
					react.createElement(ServerForm, { initial: editingServer, onDone: () => { setView("list"); refresh(); }, onCancel: () => setView("list") }),
				);
			}
			return createElement("div", { className: "mm_section" },
				createElement("div", { className: "mm_catalogHeading" },
					createElement("h3", null, "MCP 服务器"),
					createElement("span", null, servers.length),
					createElement("span", { className: "mm_addActions" },
						createElement("button", { className: "mm_addBtn", type: "button", "aria-label": "添加 MCP 服务器", title: "添加 MCP 服务器", onClick: () => setView("add") },
							createElement("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
								createElement("path", { d: "M8 3.5v9", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
								createElement("path", { d: "M3.5 8h9", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
							),
						),
					),
				),
				createElement("label", { className: "mm_search" },
					createElement("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
						createElement("circle", { cx: "7", cy: "7", r: "5", stroke: "currentColor", strokeWidth: "1.5" }),
						createElement("path", { d: "M11 11l3 3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
					),
					createElement("input", { type: "search", value: query, placeholder: "搜索 MCP 服务器", "aria-label": "搜索 MCP 服务器", onChange: (e) => setQuery(e.target.value) }),
				),
				createElement("div", { className: "mm_cards" },
					filteredServers.map((s) => react.createElement(ServerRow, { server: s, onChanged: refresh, onEdit: () => { setEditingId(s.id); setView("edit"); }, open: expandedId === s.id, onToggle: () => setExpandedId(expandedId === s.id ? null : s.id), key: s.id })),
				),
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
