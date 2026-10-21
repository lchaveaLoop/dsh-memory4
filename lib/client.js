window.__ModuleLoader__.load({
  id: "dsh-memory4",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const inject = ["slots", "locale"];
    const NS = "memory4";
    const zh = { title: "记忆" };
    const en = { title: "Memory" };

    const KIND_LABELS = {
      working: "工作",
      episodic: "情景",
      semantic: "语义",
      procedural: "程序",
    };
    const KIND_OPTIONS = ["", "working", "episodic", "semantic", "procedural"];
    const KIND_NAMES = {
      "": "全部类型",
      working: "工作记忆",
      episodic: "情景记忆",
      semantic: "语义记忆",
      procedural: "程序记忆",
    };

    const styles = {
      root: { display: "grid", gap: 14, padding: "4px 0 32px", color: "inherit" },
      header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      title: { fontSize: 18, fontWeight: 600, margin: 0 },
      muted: { opacity: 0.62, fontSize: 12 },
      row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
      input: {
        flex: "1 1 240px",
        minWidth: 160,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-secondary, #d9d9d9)",
        background: "var(--dsw-alias-bg-base, transparent)",
        color: "inherit",
        fontSize: 13,
      },
      select: {
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-secondary, #d9d9d9)",
        background: "var(--dsw-alias-bg-base, transparent)",
        color: "inherit",
        fontSize: 13,
      },
      button: {
        padding: "7px 12px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-secondary, #d9d9d9)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: 13,
      },
      danger: { color: "var(--dsw-alias-label-error, #c62828)" },
      stats: { display: "flex", gap: 10, flexWrap: "wrap" },
      stat: {
        minWidth: 92,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--dsw-alias-border-secondary, #d9d9d9)",
        display: "grid",
        gap: 2,
      },
      statValue: { fontSize: 18, fontWeight: 600 },
      statLabel: { fontSize: 12, opacity: 0.62 },
      card: {
        border: "1px solid var(--dsw-alias-border-secondary, #d9d9d9)",
        borderRadius: 10,
        padding: "10px 12px",
        display: "grid",
        gap: 6,
        background: "var(--dsw-alias-bg-base, transparent)",
      },
      cardHead: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 },
      badge: {
        display: "inline-block",
        fontSize: 11,
        padding: "1px 7px",
        borderRadius: 999,
        border: "1px solid var(--dsw-alias-border-secondary, #d9d9d9)",
        opacity: 0.9,
      },
      body: { fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" },
      sectionTitle: { fontSize: 14, fontWeight: 600, marginTop: 8 },
      error: { color: "var(--dsw-alias-label-error, #c62828)", fontSize: 13, whiteSpace: "pre-wrap" },
      notice: { color: "var(--dsw-alias-label-success, #2e7d32)", fontSize: 13 },
      empty: { opacity: 0.62, fontSize: 13 },
    };

    async function api(path, options) {
      const init = options && options.body !== undefined
        ? {
            method: options.method || "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.body),
          }
        : { method: (options && options.method) || "GET" };
      const response = await fetch(path, init);
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const detail = payload && typeof payload.error === "string" ? payload.error : "HTTP " + response.status;
        throw new Error(detail);
      }
      return payload;
    }

    function formatTime(value) {
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    function MemorySection() {
      const [status, setStatus] = React.useState(null);
      const [records, setRecords] = React.useState([]);
      const [skills, setSkills] = React.useState([]);
      const [audit, setAudit] = React.useState([]);
      const [query, setQuery] = React.useState("");
      const [kind, setKind] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");

      const loadRecords = React.useCallback(async (nextQuery, nextKind) => {
        const params = new URLSearchParams();
        if (nextQuery) params.set("query", nextQuery);
        if (nextKind) params.set("kind", nextKind);
        params.set("limit", "50");
        const payload = await api("/api/memory4/records?" + params.toString());
        setRecords(Array.isArray(payload.records) ? payload.records : []);
      }, []);

      const reload = React.useCallback(async (nextQuery, nextKind) => {
        const [statusPayload, skillsPayload, logPayload] = await Promise.all([
          api("/api/memory4/status"),
          api("/api/memory4/skills"),
          api("/api/memory4/log?limit=12"),
        ]);
        setStatus(statusPayload);
        setSkills(Array.isArray(skillsPayload.skills) ? skillsPayload.skills : []);
        setAudit(Array.isArray(logPayload.entries) ? logPayload.entries : []);
        await loadRecords(nextQuery, nextKind);
      }, [loadRecords]);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            await reload("", "");
          } catch (cause) {
            if (alive) setError(String(cause && cause.message ? cause.message : cause));
          }
        })();
        return () => {
          alive = false;
        };
      }, [reload]);

      const search = async () => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          await loadRecords(query, kind);
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setBusy(false);
        }
      };

      const refresh = async () => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          await reload(query, kind);
          setNotice("已刷新");
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setBusy(false);
        }
      };

      const act = async (path, body) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const payload = await api(path, { method: "POST", body });
          setNotice(payload && payload.ok === false ? String(payload.reason || "操作未完成") : "操作完成");
          await reload(query, kind);
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setBusy(false);
        }
      };

      const forget = async (record) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (!window.confirm("删除这条记忆？此操作不可撤销。\n\n" + record.title)) return;
        }
        await act("/api/memory4/forget", { id: record.id });
      };

      const pin = async (record) => {
        await act("/api/memory4/pin", { text: record.body, scope: "user" });
      };

      const exportAll = async (format) => {
        setBusy(true);
        setError("");
        try {
          const suffix = format === "md" ? "?format=md" : "";
          const response = await fetch("/api/memory4/export" + suffix);
          if (!response.ok) throw new Error("HTTP " + response.status);
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "memory4-export-" + new Date().toISOString().replace(/[:.]/g, "-") + (format === "md" ? ".md" : ".json");
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
          setNotice(format === "md" ? "已导出 Markdown" : "已导出 JSON");
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setBusy(false);
        }
      };

      const reflect = async () => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const payload = await api("/api/memory4/reflect", { method: "POST", body: { days: 7 } });
          setNotice("反思完成：新增 " + (payload.created ?? 0) + " 条教训");
          await reload(query, kind);
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setBusy(false);
        }
      };

      const stat = (label, value) => React.createElement("div", { style: styles.stat, key: label },
        React.createElement("span", { style: styles.statValue }, String(value)),
        React.createElement("span", { style: styles.statLabel }, label),
      );

      const recordCard = (record) => React.createElement("div", { style: styles.card, key: record.id },
        React.createElement("div", { style: styles.cardHead },
          React.createElement("span", { style: styles.badge }, KIND_LABELS[record.kind] || record.kind),
          React.createElement("span", { style: styles.muted }, record.scope),
          React.createElement("span", { style: styles.muted }, "重要度 " + Number(record.importance).toFixed(2)),
          React.createElement("span", { style: styles.muted }, formatTime(record.updatedAt)),
        ),
        React.createElement("div", { style: styles.body }, record.body),
        React.createElement("div", { style: styles.row },
          React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: () => pin(record) }, "钉住（用户级）"),
          React.createElement("button", { type: "button", style: { ...styles.button, ...styles.danger }, disabled: busy, onClick: () => forget(record) }, "删除"),
          React.createElement("span", { style: styles.muted }, record.id),
        ),
      );

      const skillRow = (skill) => React.createElement("div", { style: styles.card, key: skill.name },
        React.createElement("div", { style: styles.cardHead },
          React.createElement("span", { style: styles.badge }, skill.status),
          React.createElement("strong", null, skill.name),
          React.createElement("span", { style: styles.muted }, "证据 " + skill.evidence),
        ),
        React.createElement("div", { style: styles.muted }, skill.description),
        React.createElement("div", { style: styles.muted }, "草稿：" + skill.draftPath),
        skill.status === "draft"
          ? React.createElement("div", { style: styles.row },
              React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: () => act("/api/memory4/skills/approve", { name: skill.name }) }, "批准"),
              React.createElement("button", { type: "button", style: { ...styles.button, ...styles.danger }, disabled: busy, onClick: () => act("/api/memory4/skills/reject", { name: skill.name }) }, "拒绝"),
            )
          : null,
      );

      const auditRow = (entry) => React.createElement("div", { style: styles.muted, key: String(entry.id) },
        formatTime(entry.createdAt) + "  " + entry.action + (entry.detail ? "  " + entry.detail : ""),
      );

      return React.createElement("div", { style: styles.root },
        React.createElement("div", { style: styles.header },
          React.createElement("h2", { style: styles.title }, "四相记忆"),
          React.createElement("span", { style: styles.muted }, busy ? "处理中…" : "本地 SQLite · 工作/情景/语义/程序"),
        ),
        status
          ? React.createElement("div", { style: styles.stats },
              stat("记忆", status.store.total),
              stat("归档", status.store.archived),
              stat("pins", status.store.pins),
              stat("技能草稿", status.skills.drafts),
              status.config.vectorEnabled ? stat("向量", status.store.vectors) : null,
            )
          : null,
        React.createElement("div", { style: styles.row },
          React.createElement("input", {
            style: styles.input,
            value: query,
            placeholder: "搜索记忆（关键词 / 中文子串）",
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") search(); },
          }),
          React.createElement("select", {
            style: styles.select,
            value: kind,
            onChange: (event) => setKind(event.target.value),
          }, KIND_OPTIONS.map((option) => React.createElement("option", { value: option, key: option }, KIND_NAMES[option]))),
          React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: search }, "搜索"),
          React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: refresh }, "刷新"),
          React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: () => exportAll("json") }, "导出 JSON"),
          React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: () => exportAll("md") }, "导出 Markdown"),
          React.createElement("button", { type: "button", style: styles.button, disabled: busy, onClick: reflect }, "反思"),
        ),
        error ? React.createElement("div", { style: styles.error }, error) : null,
        notice ? React.createElement("div", { style: styles.notice }, notice) : null,
        React.createElement("div", { style: styles.sectionTitle }, "记忆记录（" + records.length + "）"),
        records.length === 0
          ? React.createElement("div", { style: styles.empty }, "没有匹配的记忆。")
          : records.map(recordCard),
        React.createElement("div", { style: styles.sectionTitle }, "生成的技能"),
        skills.length === 0
          ? React.createElement("div", { style: styles.empty }, "暂无技能草稿；重复同一成功工具序列达到 minEvidence 后生成。")
          : skills.map(skillRow),
        React.createElement("div", { style: styles.sectionTitle }, "最近自动活动"),
        audit.length === 0
          ? React.createElement("div", { style: styles.empty }, "暂无记录。")
          : audit.map(auditRow),
        status
          ? React.createElement("div", { style: styles.muted },
              "数据目录：" + status.dataDir + " · recall " + status.config.injectTopK + " 条 / " + status.config.injectMaxTokens + " tokens"
                + " · vector " + (status.config.vectorEnabled ? "on (" + status.config.vectorModel + ")" : "off")
                + " · reflect " + (status.config.reflectEnabled ? "on" : "off"))
          : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memory4: settings locale");
      ctx.slots.inject("settings.section", () => {
        try {
          return ctx.slots.register({
            name: "settings.section",
            id: "memory4",
            order: 200,
            label: () => ctx.locale.bind(NS)("title"),
            locale: NS,
          }, MemorySection);
        } catch {
          return () => {};
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
