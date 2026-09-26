import { parseChain } from "./chain.js";
// Authentication must never be a static dependency of the initial workbench.
// A stale/blocked auth module should fail inside bootCloud's try/finally,
// not prevent this module from evaluating and rendering shell().
let authDiagnostic = "";
let authDiagnosticStage = "解析链接";
let authDiagnosticType = "无登录参数";
function showAuthDiagnostic(stage, result = "进行中") {
  authDiagnosticStage = stage;
  authDiagnostic = `回跳类型：${authDiagnosticType}；认证阶段：${stage}；${result}`;
  updateSyncStatus();
}
let authModulePromise;
function loadAuthModule() {
  if (!authModulePromise) {
    let timer;
    authModulePromise = Promise.race([
      import("./supabase-sync.js?auth-diagnostics=1"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("登录未完成，请重新发送登录邮件")),
          15000,
        );
      }),
    ])
      .catch((error) => {
        authModulePromise = null;
        throw error;
      })
      .finally(() => clearTimeout(timer));
  }
  return authModulePromise;
}
const sendEmailCode = async (...args) =>
  (await loadAuthModule()).sendEmailCode(...args);
const verifyEmailCode = async (...args) =>
  (await loadAuthModule()).verifyEmailCode(...args);
const signOut = async (...args) => (await loadAuthModule()).signOut(...args);
const readCloudWorkspace = async (...args) =>
  (await loadAuthModule()).readCloudWorkspace(...args);
const saveCloudWorkspace = async (...args) =>
  (await loadAuthModule()).saveCloudWorkspace(...args);
import { WorkspaceSync } from "./workspace-sync.js";
import {
  DEFAULTS,
  uid,
  newRow,
  amounts,
  batchCheck,
  validateRow,
  importRows,
  csvCell,
  productUrl,
  round,
} from "./core.js";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const h = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") n.className = v;
    else if (k === "checked" || k === "disabled") n[k] = v;
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity))
    if (c != null)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const btn = (text, fn, cls = "", attrs = {}) =>
  h("button", { type: "button", class: cls, onClick: fn, ...attrs }, text);
const money = (n) =>
  Number(n).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const yen = (n) =>
  Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
let state = {
    version: 1,
    settings: { ...DEFAULTS },
    rows: [],
    batches: [],
    revision: 0,
  },
  selected = new Set(),
  tab = "details",
  query = "",
  filter = "all",
  page = 1,
  undo = null,
  db,
  writeQueue = Promise.resolve(),
  conflict = false;
const emptyWorkspace = () => ({
  version: 1,
  settings: { ...DEFAULTS },
  rows: [],
  batches: [],
  revision: 0,
});
let authUser = null,
  workspaceSync = null,
  authLoading = false,
  authEpoch = 0,
  authSubscription = null,
  bootPromise = null,
  syncTimer,
  syncMessage = "已保存在此浏览器",
  authBusy = false;
let channel;
try {
  channel = new BroadcastChannel("shidan-v1");
  channel.onmessage = (event) => {
    if (event.data?.scope && event.data.scope !== (authUser?.id || "local"))
      return;
    conflict = true;
    $("#save-state").textContent = "另一窗口已修改，请刷新后继续";
    $("#conflict").classList.remove("hidden");
    document.querySelectorAll("input,select,textarea,button").forEach((el) => {
      if (el.textContent !== "导出备份") el.disabled = true;
    });
  };
} catch {}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.add("hidden"), 4500);
}
function persist() {
  if (!db) {
    toast("本地存储不可用，请导出备份");
    return;
  }
  if (conflict) {
    toast("检测到另一窗口修改，请先导出备份，再刷新页面");
    return;
  }
  const snapshot = structuredClone(state);
  snapshot.revision = ++state.revision;
  if (workspaceSync) {
    const engine = workspaceSync;
    writeQueue = engine
      .save(snapshot)
      .then(() => {
        channel?.postMessage({ scope: engine.userId });
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => syncNow(), 500);
      })
      .catch((error) => {
        setSyncMessage(error.message || "本地保存失败，请导出备份");
      });
    return;
  }
  $("#save-state").textContent = "正在保存…";
  writeQueue = writeQueue
    .then(
      () =>
        new Promise((resolve, reject) => {
          const tx = db.transaction("draft", "readwrite");
          tx.objectStore("draft").put(snapshot, "current");
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        }),
    )
    .then(() => {
      setSyncMessage("已保存在此浏览器");
      channel?.postMessage({ scope: "local" });
    })
    .catch(() => {
      $("#save-state").textContent = "保存失败，请导出备份";
      toast("本地保存失败，建议立即导出备份");
    });
}
function download(name, data, type = "application/json") {
  const u = URL.createObjectURL(
    new Blob(
      [typeof data === "string" ? data : JSON.stringify(data, null, 2)],
      { type },
    ),
  );
  const a = h("a", { href: u, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function modal(title, body, actions = []) {
  const dialog = $("#dialog");
  dialog.replaceChildren(
    h(
      "div",
      { class: "dialog-head" },
      h("h2", { id: "dialog-title" }, title),
      btn("×", () => dialog.close(), "ghost", { "aria-label": "关闭" }),
    ),
    h("div", { class: "dialog-body" }, body),
    h("div", { class: "dialog-foot" }, ...actions),
  );
  dialog.showModal();
  dialog.querySelector("button")?.focus();
  return dialog;
}
function errorBox() {
  return h("p", { class: "error", id: "form-error", role: "alert" });
}
function selectRows() {
  return state.rows.filter((r) => selected.has(r.id));
}
function imageNode(row) {
  if (row.image)
    return h("img", {
      class: "thumb",
      src: row.image,
      alt: row.name || "商品参考图",
      loading: "lazy",
      referrerpolicy: "no-referrer",
      onError: (e) => {
        e.target.alt = "图片加载失败";
      },
    });
  return h(
    "span",
    {
      class: "thumb",
      style: "display:grid;place-items:center;color:var(--muted)",
    },
    "＋",
  );
}
function safeImage(v) {
  return (
    typeof v === "string" &&
    (/^(https:\/\/)/.test(v) || /^data:image\/(png|jpeg|webp);base64,/.test(v))
  );
}
function field(label, id, value, type = "text", attrs = {}) {
  return h(
    "label",
    { for: id },
    label,
    h("input", { id, type, value, ...attrs }),
  );
}
function settingInput(key, value) {
  state.settings[key] = value;
  persist();
  renderContent();
  renderSide();
}
function shell() {
  $("#app").replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "mark" }, "拾"),
        h("strong", {}, "拾单"),
        h("span", {}, "采购工作台"),
      ),
      h(
        "div",
        { class: "top-actions" },
        btn("使用说明", showHelp, "ghost"),
        btn("导出备份", () => download("拾单-完整备份.json", state), "backup"),
        btn("恢复备份", restoreBackup, "ghost"),
      ),
    ),
    h(
      "main",
      {},
      h(
        "div",
        { class: "page-heading" },
        h(
          "div",
          {},
          h("h1", {}, "把每一件，核对清楚"),
          h("p", {}, "整理明细 · 手动选单 · 核对后购买"),
        ),
        h(
          "span",
          {
            id: "save-state",
            class: "save",
            "aria-live": "polite",
            role: "button",
            tabindex: "0",
            title: "邮箱登录与云端同步",
            onClick: showAccount,
            onKeydown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                showAccount();
              }
            },
          },
          "正在读取…",
        ),
      ),
      h(
        "div",
        { id: "conflict", class: "alert-banner hidden", role: "alert" },
        "另一窗口保存了新内容。请先导出当前备份，再刷新页面，避免覆盖。",
      ),
      h(
        "section",
        { class: "settings", "aria-label": "本批计价设置" },
        field("商家网址", "merchant", state.settings.merchant, "url", {
          onChange: (e) => settingInput("merchant", e.target.value.trim()),
        }),
        h(
          "label",
          { for: "discount" },
          "核算折扣",
          h("input", {
            id: "discount",
            type: "number",
            min: 0.01,
            max: 1,
            step: 0.01,
            value: state.settings.discount,
            onChange: (e) => {
              const v = Number(e.target.value);
              if (v <= 0 || v > 1 || !Number.isFinite(v)) {
                e.target.setAttribute("aria-invalid", "true");
                renderSide();
                toast("折扣请填写 0–1 之间的数，例如 0.7");
                return;
              }
              e.target.removeAttribute("aria-invalid");
              settingInput("discount", v);
            },
          }),
          h("small", {}, "0.7 = 七折 · 明细可单独设置"),
        ),
        h(
          "label",
          { for: "rate" },
          "汇率 · 日元 → 人民币",
          h("input", {
            id: "rate",
            type: "number",
            min: 0.000001,
            step: 0.001,
            value: state.settings.rate,
            onChange: (e) => {
              const v = Number(e.target.value);
              if (v <= 0 || !Number.isFinite(v)) {
                e.target.setAttribute("aria-invalid", "true");
                renderSide();
                toast("汇率须大于 0");
                return;
              }
              e.target.removeAttribute("aria-invalid");
              settingInput("rate", v);
            },
          }),
          h("small", {}, "1 日元对应的人民币金额"),
        ),
        h(
          "div",
          { class: "setting-note" },
          h("strong", {}, "你的核算，独立于网站结算"),
          h("small", {}, "网页当前售价 × 核算折扣 × 数量 × 汇率 + 行运费"),
        ),
      ),
      h(
        "div",
        { class: "workspace" },
        h(
          "section",
          { class: "sheet", "aria-label": "采购明细" },
          h(
            "div",
            { class: "sheet-top" },
            h(
              "nav",
              { class: "nav desktop-nav", "aria-label": "工作台视图" },
              ...["details", "billing", "summary", "batches"].map((t, i) =>
                btn(
                  ["下单表", "账单表", "客户汇总", "批次记录"][i],
                  () => {
                    tab = t;
                    page = 1;
                    renderContent();
                  },
                  "",
                  { "data-tab": t },
                ),
              ),
            ),
            h(
              "div",
              { class: "tools" },
              btn("粘贴接龙", showChainImport),
              btn("Excel / CSV", showImport),
              btn("＋ 新增明细", () => editRow(), "primary"),
            ),
          ),
          h(
            "div",
            { class: "mobile-only mobile-context" },
            h("strong", { id: "mobile-view-title" }, "下单表"),
            btn(
              "批次记录",
              () => {
                tab = "batches";
                renderContent();
              },
              "ghost",
            ),
          ),
          h("div", { id: "content" }),
        ),
        h(
          "aside",
          {},
          h("section", { id: "selection", class: "side-card" }),
          h(
            "section",
            { class: "side-card" },
            h("h2", {}, "你来决定何时下单"),
            ...[
              "勾选本次商品|数量合计最多 20 件",
              "助手核对并加购|先确认款式、颜色和尺码",
              "前往商家手动下单|可修改，付款由你完成",
            ].map((x, i) => {
              const [a, b] = x.split("|");
              return h(
                "div",
                { class: "step" },
                h("b", {}, i + 1),
                h("div", {}, a, h("small", {}, b)),
              );
            }),
            btn("安装加购助手 ↗", showHelp, "ghost"),
          ),
        ),
      ),
      h(
        "footer",
        { class: "page-note" },
        h(
          "span",
          { id: "storage-note" },
          "未登录时数据仅保存在当前浏览器 · 点击保存状态登录",
        ),
        h("span", {}, "当前适配：Petit Bateau 日本官网"),
      ),
    ),
    h(
      "nav",
      {
        class: "mobile-only mobile-bottom-nav",
        "aria-label": "手机工作台视图",
      },
      ...[
        ["details", "下单表"],
        ["billing", "账单表"],
        ["summary", "客户"],
      ].map(([key, label]) =>
        btn(
          label,
          () => {
            tab = key;
            renderContent();
          },
          "",
          { "data-tab": key, "data-mobile-tab": key },
        ),
      ),
    ),
    h("dialog", { id: "dialog", "aria-labelledby": "dialog-title" }),
    h("div", {
      id: "toast",
      class: "toast hidden",
      role: "status",
      "aria-live": "polite",
    }),
  );
  renderContent();
  renderSide();
  updateSyncStatus();
}
function filtered() {
  return state.rows.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      [r.customer, r.sku, r.name, r.seq].some((v) =>
        String(v).toLowerCase().includes(query.toLowerCase()),
      ),
  );
}
function renderContent() {
  document.title =
    {
      details: "下单表",
      billing: "账单表",
      summary: "客户汇总",
      batches: "批次记录",
    }[tab] + " · 拾单";
  $$("[data-tab]").forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-current", active ? "page" : "false");
  });
  $("#mobile-view-title").textContent = {
    details: "下单表",
    billing: "账单表",
    summary: "客户",
    batches: "批次记录",
  }[tab];
  if (tab === "summary") return renderSummary();
  if (tab === "batches") return renderBatches();
  const list = filtered();
  page = Math.max(1, Math.min(page, Math.ceil(list.length / 20) || 1));
  const visible = list.slice((page - 1) * 20, page * 20);
  const search = h("input", {
    type: "search",
    value: query,
    placeholder: "搜索昵称、货号、商品",
    "aria-label": "搜索明细",
    onInput: (e) => {
      if (e.isComposing) return;
      query = e.target.value;
      page = 1;
      renderRowsOnly();
    },
    onCompositionend: (e) => {
      query = e.target.value;
      page = 1;
      renderRowsOnly();
    },
  });
  const select = h(
    "select",
    {
      "aria-label": "按处理状态筛选",
      onChange: (e) => {
        filter = e.target.value;
        page = 1;
        renderContent();
      },
    },
    ...Object.entries({
      all: "全部状态",
      draft: "待处理",
      handoff: "已交接",
      ordered: "已下单",
    }).map(([v, l]) => h("option", { value: v }, l)),
  );
  select.value = filter;
  $("#content").replaceChildren(
    h(
      "div",
      { class: "filterbar" },
      h(
        "div",
        { class: "search" },
        search,
        btn(
          "×",
          () => {
            query = "";
            renderContent();
            $("#content input[type=search]").focus();
          },
          "ghost",
          { "aria-label": "清除搜索" },
        ),
      ),
      select,
      btn("导出 CSV", exportCSV, "ghost"),
    ),
    h("div", { id: "table-area" }),
  );
  renderRowsOnly();
}
function renderRowsOnly() {
  if (tab === "billing") return renderBillingRows();
  const list = filtered();
  page = Math.max(1, Math.min(page, Math.ceil(list.length / 20) || 1));
  const visible = list.slice((page - 1) * 20, page * 20);
  const eligible = visible.filter((r) => r.status === "draft");
  const all = h("input", {
    type: "checkbox",
    "aria-label": "选择本页待处理明细",
    checked: eligible.length > 0 && eligible.every((r) => selected.has(r.id)),
    disabled: !eligible.length,
    onChange: (e) => {
      eligible.forEach((r) =>
        e.target.checked ? selected.add(r.id) : selected.delete(r.id),
      );
      renderRowsOnly();
      renderSide();
    },
  });
  all.indeterminate =
    eligible.some((r) => selected.has(r.id)) &&
    !eligible.every((r) => selected.has(r.id));
  const headers = [
    all,
    "序号",
    "客户昵称",
    "商品 / 图片",
    "货号",
    "尺码",
    "数量",
    "网页原价",
    "网页当前售价",
    "币种",
    "状态",
    "操作",
  ];
  const empty = h(
    "tr",
    {},
    h(
      "td",
      { colspan: headers.length, class: "empty" },
      h(
        "strong",
        {},
        state.rows.length ? "没有符合条件的明细" : "从第一件商品开始",
      ),
      h(
        "p",
        {},
        state.rows.length
          ? "换个关键词或清除筛选再试试。"
          : "可以新增商品，也可以直接粘贴 Excel 表格。",
      ),
      state.rows.length
        ? btn("清除筛选", () => {
            query = "";
            filter = "all";
            renderContent();
          })
        : btn("载入已验证示例", loadSample, "primary"),
    ),
  );
  const table = h(
    "table",
    {},
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        headers.map((x) => h("th", { scope: "col" }, x)),
      ),
    ),
    h("tbody", {}, visible.length ? visible.map(rowNode) : empty),
  );
  const footer = h(
    "div",
    { class: "table-footer" },
    h("span", {}, `共 ${list.length} 条 · 本页 ${visible.length} 条`),
    h(
      "div",
      { class: "row-actions" },
      btn(
        "上一页",
        () => {
          page--;
          renderRowsOnly();
        },
        "",
        { disabled: page <= 1 },
      ),
      h("span", {}, `${page} / ${Math.ceil(list.length / 20) || 1}`),
      btn(
        "下一页",
        () => {
          page++;
          renderRowsOnly();
        },
        "",
        { disabled: page * 20 >= list.length },
      ),
    ),
  );
  $("#table-area").replaceChildren(
    h(
      "div",
      {
        class: "table-wrap desktop-table",
        tabindex: "0",
        "aria-label": "商品明细表，可横向滚动",
      },
      table,
    ),
    mobileRecords(visible, eligible),
    footer,
  );
}
function inline(r, key, label, cls = "", type = "text") {
  const a = amounts(r, state.settings);
  let value = ["discount", "rate"].includes(key)
    ? a[key]
    : key === "currency"
      ? r.currency || "JPY"
      : (r[key] ?? "");
  return h("input", {
    value,
    type,
    class: cls,
    "aria-label": `${r.seq} ${label}`,
    title: ["discount", "rate"].includes(key)
      ? r[key] === ""
        ? "跟随顶部设置；填写后单独设置"
        : "单独设置；清空可恢复跟随"
      : "",
    disabled: r.status !== "draft" || conflict,
    onChange: (e) => {
      const old = r[key];
      const v = e.target.value;
      r[key] = [
        "quantity",
        "price",
        "originalPrice",
        "shipping",
        "discount",
        "rate",
      ].includes(key)
        ? v === "" && ["discount", "rate", "originalPrice"].includes(key)
          ? ""
          : Number(v)
        : key === "currency"
          ? v.trim().toUpperCase()
          : v;
      const err = validateRow({
        ...r,
        customer: r.customer || "临时",
        sku: r.sku || "临时",
        size: r.size || "临时",
      });
      if (err) {
        r[key] = old;
        e.target.value = old ?? (key === "currency" ? "JPY" : "");
        toast(err);
        return;
      }
      persist();
      renderRowsOnly();
      renderSide();
    },
  });
}
function renderBillingRows() {
  const groups = new Map();
  for (const row of filtered()) {
    const customer = row.customer || "未填客户";
    if (!groups.has(customer)) groups.set(customer, []);
    groups.get(customer).push(row);
  }
  const allGroups = [...groups.entries()];
  page = Math.max(1, Math.min(page, Math.ceil(allGroups.length / 20) || 1));
  const visible = allGroups.slice((page - 1) * 20, page * 20);
  const headers = [
    "客户昵称",
    "商品 / 货号",
    "数量",
    "计价基础",
    "币种",
    "核算折扣",
    "汇率（本币→人民币）",
    "行运费（人民币）",
    "应收人民币",
    "操作",
  ];
  const total = (rows) =>
    rows.reduce((sum, row) => sum + amounts(row, state.settings).cny, 0);
  const body = visible.flatMap(([customer, rows]) => [
    ...rows.map((r) =>
      h(
        "tr",
        {},
        h("td", {}, customer),
        h(
          "td",
          {},
          r.name || r.sku,
          h("small", { class: "muted" }, " · " + r.sku),
        ),
        h("td", {}, r.quantity),
        h(
          "td",
          { class: "money", title: "固定等于下单表的网页当前售价" },
          money(r.price || 0),
        ),
        h("td", {}, r.currency || "JPY"),
        h("td", {}, inline(r, "discount", "核算折扣", "rate-input", "number")),
        h("td", {}, inline(r, "rate", "汇率", "rate-input", "number")),
        h("td", {}, inline(r, "shipping", "行运费", "", "number")),
        h("td", { class: "money" }, money(amounts(r, state.settings).cny)),
        h(
          "td",
          {},
          btn("编辑", () => editRow(r), "ghost"),
        ),
      ),
    ),
    h(
      "tr",
      {},
      h("td", { colspan: 8 }, h("strong", {}, customer + " 合计")),
      h("td", { class: "money" }, money(total(rows))),
      h("td"),
    ),
  ]);
  $("#table-area").replaceChildren(
    h(
      "p",
      { class: "help" },
      "计价基础 = 网页当前售价；应收人民币 = 网页当前售价 × 核算折扣 × 数量 × 汇率 + 行运费。原价不参与计算，最终金额保留两位小数。",
    ),
    h(
      "div",
      {
        class: "table-wrap desktop-table",
        tabindex: "0",
        "aria-label": "账单表，可横向滚动",
      },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            headers.map((label) => h("th", { scope: "col" }, label)),
          ),
        ),
        h(
          "tbody",
          {},
          body.length
            ? body
            : h(
                "tr",
                {},
                h(
                  "td",
                  { colspan: headers.length, class: "empty" },
                  "暂无账单明细，请在下单表添加商品或清除筛选。",
                ),
              ),
        ),
      ),
    ),
    h(
      "div",
      { class: "mobile-only mobile-records", "aria-label": "账单卡片" },
      visible.length
        ? visible.map(([customer, rows]) =>
            h(
              "section",
              {},
              h(
                "header",
                { class: "table-footer" },
                h("strong", {}, customer),
                h("strong", { class: "money" }, "合计 ¥ " + money(total(rows))),
              ),
              rows.map((row) => mobileRecord(row, true)),
            ),
          )
        : h(
            "p",
            { class: "empty" },
            "暂无账单明细，请在下单表添加商品或清除筛选。",
          ),
    ),
    h(
      "div",
      { class: "table-footer" },
      h(
        "span",
        {},
        `共 ${groups.size} 位客户 · 应收合计 ¥ ${money(total(filtered()))}`,
      ),
      h(
        "div",
        { class: "row-actions" },
        btn(
          "上一页",
          () => {
            page--;
            renderBillingRows();
          },
          "",
          { disabled: page <= 1 },
        ),
        h("span", {}, `${page} / ${Math.ceil(groups.size / 20) || 1}`),
        btn(
          "下一页",
          () => {
            page++;
            renderBillingRows();
          },
          "",
          { disabled: page * 20 >= groups.size },
        ),
      ),
    ),
  );
}
function rowNode(r) {
  return h(
    "tr",
    { class: selected.has(r.id) ? "selected" : "" },
    h(
      "td",
      {},
      h("input", {
        type: "checkbox",
        "aria-label": `选择第 ${r.seq} 行`,
        checked: selected.has(r.id),
        disabled: r.status !== "draft",
        onChange: (e) => {
          e.target.checked ? selected.add(r.id) : selected.delete(r.id);
          renderRowsOnly();
          renderSide();
        },
      }),
    ),
    h("td", { class: "muted mono" }, r.seq),
    h("td", {}, inline(r, "customer", "客户昵称", "customer-input")),
    h(
      "td",
      {},
      h(
        "div",
        { class: "product-cell" },
        btn(imageNode(r), () => editRow(r), "image-button", {
          "aria-label": `编辑第 ${r.seq} 行图片`,
        }),
        h(
          "div",
          {},
          inline(r, "name", "商品名称", "name-input"),
          h(
            "div",
            {},
            productUrl(r.url)
              ? h(
                  "a",
                  {
                    class: "inline-link",
                    href: r.url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  },
                  "查看商品 ↗",
                )
              : h(
                  "span",
                  { class: "inline-link muted" },
                  r.color || "可补充颜色、链接",
                ),
          ),
        ),
      ),
    ),
    h("td", {}, inline(r, "sku", "货号", "sku-input")),
    h("td", {}, inline(r, "size", "尺码", "size-input")),
    h("td", {}, inline(r, "quantity", "数量", "qty-input", "number")),
    h("td", {}, inline(r, "originalPrice", "网页原价", "", "number")),
    h("td", {}, inline(r, "price", "网页当前售价", "", "number")),
    h("td", {}, inline(r, "currency", "币种", "size-input")),
    h(
      "td",
      {},
      h(
        "span",
        { class: `badge ${r.status}` },
        { draft: "待处理", handoff: "已交接", ordered: "已下单" }[r.status],
      ),
    ),
    h(
      "td",
      {},
      btn("编辑", () => editRow(r), "ghost"),
    ),
  );
}
function renderSide() {
  const rows = selectRows(),
    count = rows.reduce((n, r) => n + Number(r.quantity), 0),
    total = rows.reduce((n, r) => n + amounts(r, state.settings).cny, 0),
    byCurrency = rows.reduce((totals, r) => {
      const currency = r.currency || "JPY";
      totals.set(
        currency,
        (totals.get(currency) || 0) + amounts(r, state.settings).yen,
      );
      return totals;
    }, new Map()),
    error = document.querySelector(".settings [aria-invalid=true]")
      ? "请修正顶部折扣和汇率"
      : batchCheck(rows, state.settings);
  $("#selection").replaceChildren(
    h("h2", {}, "本次选单"),
    h(
      "div",
      { class: "batch-number" + (count > 20 ? " over" : "") },
      count,
      h("span", {}, " / 20 件"),
    ),
    h(
      "div",
      { class: "meter" + (count > 20 ? " over" : ""), "aria-hidden": "true" },
      ...Array.from({ length: 20 }, (_, i) =>
        h("i", { class: i < count ? "filled" : "" }),
      ),
    ),
    h(
      "small",
      {},
      `已选 ${rows.length} 条明细 · ${new Set(rows.map((r) => r.customer)).size} 位客户`,
    ),
    h(
      "div",
      { class: "totals" },
      h(
        "div",
        {},
        h("span", {}, "核算折后金额（原币）"),
        h(
          "span",
          { class: "money" },
          [...byCurrency]
            .map(([currency, value]) => `${currency} ${yen(value)}`)
            .join(" / ") || "JPY 0",
        ),
      ),
      h(
        "div",
        {},
        h("span", {}, "应收人民币"),
        h("strong", { class: "money" }, "¥ " + money(total)),
      ),
    ),
    h(
      "p",
      { class: count > 20 ? "error" : "note", id: "batch-error" },
      error || "明细准备好了，可交接到加购助手。",
    ),
    btn("推送到购物车 →", reviewBatch, "primary", {
      disabled: !!error || conflict,
      "aria-describedby": "batch-error",
    }),
    btn(
      "取消全部勾选",
      () => {
        selected.clear();
        renderContent();
        renderSide();
      },
      "ghost",
      { disabled: !rows.length },
    ),
    h(
      "p",
      { class: "note" },
      "通过加购助手在你的浏览器中操作。交接不代表已加购，也不会自动下单。",
    ),
  );
}
function loadSample() {
  state.rows.push(
    newRow({
      seq: 98,
      customer: "示例客户",
      sku: "A0CV9030",
      name: "藏青色背带裤",
      color: "藏青色",
      size: "95",
      price: 7315,
      shipping: 42,
      url: "https://www.petit-bateau.co.jp/products/a0cv9-bebe-pants-leggings",
      image:
        "https://cdn.shopify.com/s/files/1/0750/6064/2079/files/A0CV903F1.jpg?v=1739783710",
    }),
  );
  persist();
  renderContent();
  toast("已载入 1 条示例，可编辑后勾选");
}
async function imageData(file) {
  if (!file) return "";
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw Error("请选择 5 MB 以内的 JPG、PNG 或 WebP 图片");
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas
          .getContext("2d")
          .drawImage(img, 0, 0, canvas.width, canvas.height);
        res(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => rej(Error("图片无法读取，请换一张"));
      img.src = reader.result;
    };
    reader.onerror = () => rej(Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
function editRow(existing) {
  if (!existing && state.rows.length >= 2000)
    return toast("最多2,000条明细，请先导出备份再分批处理");
  const r =
    existing ||
    newRow({
      seq: Math.max(0, ...state.rows.map((r) => Number(r.seq) || 0)) + 1,
    });
  let photo = r.image;
  const locked = r.status !== "draft";
  const fields = [
    ["customer", "客户昵称", "text"],
    ["sku", "货号", "text"],
    ["name", "商品名称", "text"],
    ["size", "目标尺码（cm）", "text"],
    ["color", "颜色", "text"],
    ["quantity", "数量", "number"],
    ["originalPrice", "网页原价（仅记录）", "number"],
    ["price", "网页当前售价", "number"],
    ["currency", "币种（JPY 为日元）", "text"],
    ["shipping", "本行运费（人民币）", "number"],
    ["discount", "核算折扣（留空跟随顶部）", "number"],
    ["rate", "单独汇率（留空跟随顶部）", "number"],
    ["url", "商品链接（可选）", "url"],
  ];
  const form = h(
    "form",
    { novalidate: "", onSubmit: (e) => e.preventDefault() },
    h(
      "div",
      { class: "form-grid" },
      ...fields.map(([key, label, type]) =>
        field(
          label,
          "edit-" + key,
          key === "currency" ? r.currency || "JPY" : (r[key] ?? ""),
          type,
          {
            disabled: locked,
            "data-key": key,
            step: "any",
          },
        ),
      ),
      h(
        "label",
        { for: "image-file", class: "wide" },
        "商品图片 · JPG / PNG / WebP，最多 5 MB",
        h("input", {
          id: "image-file",
          type: "file",
          accept: "image/jpeg,image/png,image/webp",
          disabled: locked,
          onChange: async (e) => {
            try {
              photo = await imageData(e.target.files[0]);
              $("#photo-box").replaceChildren(
                h("img", { src: photo, class: "thumb", alt: "商品图片预览" }),
              );
            } catch (err) {
              $("#form-error").textContent = err.message;
            }
          },
        }),
        h("div", { id: "photo-box" }, r.image ? imageNode(r) : null),
      ),
    ),
    h(
      "p",
      { class: "help" },
      "计价基础固定等于网页当前售价；原价仅记录。应收人民币 = 网页当前售价 × 核算折扣 × 数量 × 汇率 + 行运费。运费整行只加一次。汇率为本行币种兑人民币。",
    ),
    locked
      ? h(
          "p",
          { class: "notice" },
          "此明细已交接。若要修改，请先在批次记录中撤回，并核对商家购物车。",
        )
      : null,
    errorBox(),
  );
  const actions = [btn("关闭", () => $("#dialog").close())];
  if (existing && !locked)
    actions.unshift(
      btn(
        "删除明细",
        () => {
          undo = structuredClone(r);
          state.rows = state.rows.filter((x) => x.id !== r.id);
          selected.delete(r.id);
          persist();
          $("#dialog").close();
          renderContent();
          renderSide();
          toast("已删除，可在使用说明中撤销最近一次删除");
        },
        "ghost danger",
      ),
    );
  if (!locked)
    actions.push(
      btn(
        "保存明细",
        () => {
          if (conflict) return toast("请先刷新，避免覆盖另一窗口");
          const v = { ...r, image: photo };
          fields.forEach(([key, , type]) => {
            const val = $("#edit-" + key).value.trim();
            v[key] =
              type === "number"
                ? val === "" &&
                  ["discount", "rate", "originalPrice"].includes(key)
                  ? ""
                  : Number(val)
                : key === "currency"
                  ? val.toUpperCase()
                  : val;
          });
          fields.forEach(([key]) => {
            const input = $("#edit-" + key);
            input.removeAttribute("aria-invalid");
            input.removeAttribute("aria-describedby");
          });
          const err = validateRow(v);
          if (err) {
            $("#form-error").textContent = err;
            const key = !v.customer
              ? "customer"
              : !v.sku && !v.url
                ? "sku"
                : !v.size
                  ? "size"
                  : /数量/.test(err)
                    ? "quantity"
                    : /折扣/.test(err)
                      ? "discount"
                      : /汇率/.test(err)
                        ? "rate"
                        : /链接/.test(err)
                          ? "url"
                          : /币种/.test(err)
                            ? "currency"
                            : /原价/.test(err)
                              ? "originalPrice"
                              : "price";
            const input = $("#edit-" + key);
            input.setAttribute("aria-invalid", "true");
            input.setAttribute("aria-describedby", "form-error");
            input.focus();
            return;
          }
          if (existing) Object.assign(existing, v);
          else state.rows.push(v);
          persist();
          $("#dialog").close();
          renderContent();
          renderSide();
          toast("明细已保存");
        },
        "primary",
      ),
    );
  modal(existing ? `编辑明细 · ${r.seq}` : "新增明细", form, actions);
}
function showImport() {
  const area = h("textarea", {
    id: "paste-data",
    placeholder:
      "序号\t客户\t型号\t类型\t尺码\t数量\t运费\t网页原价\t网页当前售价\t币种\t核算折扣\t汇率",
    "aria-label": "粘贴 Excel 内容",
  });
  const body = h(
    "div",
    {},
    h(
      "p",
      {},
      "从 Excel 复制含标题的单元格，直接粘贴。支持 CSV 文件，自动跳过客户汇总行。",
    ),
    h(
      "p",
      { class: "help" },
      "支持标题：序号、客户 / 昵称、型号 / 货号、名称、尺码、数量、运费、网页原价、网页当前售价、币种、核算折扣、汇率、商品链接。旧计价基数列按网页当前售价导入；原价不用于计价。",
    ),
    area,
    h(
      "label",
      { for: "csv-file" },
      "或选择 CSV 文件",
      h("input", {
        type: "file",
        id: "csv-file",
        accept: ".csv,.tsv,text/csv,text/tab-separated-values",
        onChange: async (e) => {
          const file = e.target.files[0];
          if (file?.size > 2 * 1024 * 1024) {
            $("#form-error").textContent = "文件请控制在 2 MB 内";
            return;
          }
          if (file) area.value = await file.text();
        },
      }),
    ),
    errorBox(),
  );
  modal("导入采购明细", body, [
    btn("取消", () => $("#dialog").close()),
    btn(
      "导入到明细",
      () => {
        try {
          const rows = importRows(area.value);
          if (!rows.length) throw Error("没有可导入的商品行");
          if (state.rows.length + rows.length > 2000)
            throw Error("单份工作台最多 2,000 行，请分文件处理");
          let seq = Math.max(0, ...state.rows.map((r) => Number(r.seq) || 0));
          rows.forEach((r) => {
            if (!r.seq) r.seq = ++seq;
            if (r.image && !safeImage(r.image)) r.image = "";
          });
          state.rows.push(...rows);
          persist();
          $("#dialog").close();
          tab = "details";
          filter = "all";
          query = "";
          page = 1;
          renderContent();
          renderSide();
          toast(`已导入 ${rows.length} 条，缺失信息可在表格中补齐`);
        } catch (err) {
          $("#form-error").textContent = err.message;
        }
      },
      "primary",
    ),
  ]);
}
function renderSummary() {
  const groups = new Map();
  state.rows.forEach((r) => {
    const name = r.customer || "未填客户";
    const item = groups.get(name) || {
      name,
      lines: 0,
      quantity: 0,
      total: 0,
      ordered: 0,
    };
    item.lines++;
    item.quantity += Number(r.quantity) || 0;
    item.total += amounts(r, state.settings).cny;
    if (r.status === "ordered") item.ordered++;
    groups.set(name, item);
  });
  $("#content").replaceChildren(
    h(
      "div",
      { class: "filterbar" },
      h("span", { class: "muted" }, "相同昵称自动合并 · 应收包含每行运费"),
      btn("导出 CSV", exportCSV, "ghost"),
    ),
    h(
      "div",
      { class: "table-wrap desktop-table" },
      h(
        "table",
        { class: "summary" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...[
              "客户昵称",
              "商品条数",
              "数量合计",
              "已下单条数",
              "应收人民币",
            ].map((x) => h("th", { scope: "col" }, x)),
          ),
        ),
        h(
          "tbody",
          {},
          groups.size
            ? [...groups.values()].map((g) =>
                h(
                  "tr",
                  {},
                  h("td", {}, g.name),
                  h("td", {}, g.lines),
                  h("td", {}, g.quantity),
                  h("td", {}, g.ordered),
                  h("td", { class: "money" }, "¥ " + money(g.total)),
                ),
              )
            : h(
                "tr",
                {},
                h(
                  "td",
                  { colspan: 5, class: "empty" },
                  "添加商品后，这里会自动汇总客户应收。",
                ),
              ),
        ),
      ),
    ),
    h(
      "div",
      { class: "mobile-only mobile-records", "aria-label": "客户卡片" },
      groups.size
        ? [...groups.values()].map((g) =>
            h(
              "article",
              { class: "mobile-record" },
              h(
                "header",
                {},
                h("strong", {}, g.name),
                h("span", { class: "money" }, "¥ " + money(g.total)),
              ),
              h(
                "dl",
                { class: "mobile-facts" },
                ...[
                  ["商品条数", g.lines],
                  ["数量合计", g.quantity],
                  ["已下单条数", g.ordered],
                  ["应收币种", "人民币"],
                ].map(([label, value]) =>
                  h("div", {}, h("dt", {}, label), h("dd", {}, value)),
                ),
              ),
            ),
          )
        : h("p", { class: "empty" }, "添加商品后，这里会自动汇总客户应收。"),
    ),
    h(
      "div",
      { class: "table-footer" },
      `共 ${groups.size} 位客户`,
      h(
        "strong",
        { class: "money" },
        "总应收 ¥ " +
          money([...groups.values()].reduce((s, x) => s + x.total, 0)),
      ),
    ),
  );
}
function exportCSV() {
  const titles = [
    "序号",
    "客户",
    "货号",
    "商品名称",
    "尺码",
    "数量",
    "运费",
    "网页当前售价",
    "核算折扣",
    "汇率",
    "核算折后金额（原币）",
    "应收人民币",
    "状态",
    "网页原价",
    "币种",
  ];
  const rows = state.rows.map((r) => {
    const a = amounts(r, state.settings);
    return [
      r.seq,
      r.customer,
      r.sku,
      r.name,
      r.size,
      r.quantity,
      r.shipping,
      r.price,
      a.discount,
      a.rate,
      a.yen,
      a.cny,
      { draft: "待处理", handoff: "已交接", ordered: "已下单" }[r.status],
      r.originalPrice ?? "",
      r.currency || "JPY",
    ];
  });
  download(
    "拾单-明细.csv",
    "\uFEFF" +
      [titles, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"),
    "text/csv;charset=utf-8",
  );
}
function batchFile(batch) {
  return {
    format: "shidan-batch-v1",
    id: batch.id,
    created: batch.created,
    merchant: state.settings.merchant,
    items: batch.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      size: r.size,
      color: r.color,
      image: r.image,
      url: r.url,
      quantity: r.quantity,
    })),
  };
}
function reviewBatch() {
  if (document.querySelector(".settings [aria-invalid=true]"))
    return toast("请修正顶部折扣和汇率");
  const rows = selectRows();
  const err = batchCheck(rows, state.settings);
  if (err) return toast(err);
  const list = h(
    "ul",
    { class: "batch-lines" },
    rows.map((r) =>
      h(
        "li",
        {},
        imageNode(r),
        h(
          "div",
          { class: "detail" },
          h("strong", {}, r.name || r.sku),
          h("small", {}, `${r.customer} · ${r.sku} · ${r.size} cm`),
        ),
        h("b", {}, `× ${r.quantity}`),
      ),
    ),
  );
  modal(
    "核对本次选单",
    h(
      "div",
      {},
      list,
      h(
        "div",
        { class: "notice" },
        "下载批次文件后，在加购助手中导入。助手会展示网站商品，逐项确认后才加入购物车。客户昵称、运费和应收金额不会写入批次文件。",
      ),
      h(
        "p",
        { class: "help" },
        "下载后明细标记为“已交接”，不是“已加购”。未完成的批次可从记录中重新下载。",
      ),
    ),
    [
      btn("返回修改", () => $("#dialog").close()),
      btn(
        "确认并下载加购批次",
        () => {
          const error = batchCheck(selectRows(), state.settings);
          if (error) return toast(error);
          const batch = {
            id: uid(),
            created: new Date().toISOString(),
            status: "handoff",
            rows: structuredClone(selectRows()),
          };
          state.batches.unshift(batch);
          batch.rows.forEach((r) => {
            const live = state.rows.find((x) => x.id === r.id);
            const frozen = amounts(live, state.settings);
            live.discount = frozen.discount;
            live.rate = frozen.rate;
            live.status = "handoff";
            live.batchId = batch.id;
          });
          selected.clear();
          persist();
          download(
            "拾单-加购批次-" + batch.id.slice(0, 8) + ".json",
            batchFile(batch),
          );
          $("#dialog").close();
          tab = "batches";
          renderContent();
          renderSide();
          toast("批次已下载，请导入浏览器加购助手");
        },
        "primary",
      ),
    ],
  );
}
function renderBatches() {
  const content = h("div", {});
  if (!state.batches.length)
    content.append(
      h(
        "div",
        { class: "empty" },
        h("strong", {}, "还没有交接批次"),
        h("p", {}, "在商品明细中勾选商品，核对后交接给加购助手。"),
      ),
    );
  state.batches.forEach((b, i) =>
    content.append(
      h(
        "article",
        { class: "batch-item" },
        h(
          "header",
          {},
          h(
            "div",
            {},
            h(
              "h3",
              {},
              `批次 ${state.batches.length - i} · ${b.rows.reduce((n, r) => n + r.quantity, 0)} 件`,
            ),
            h("small", {}, new Date(b.created).toLocaleString("zh-CN")),
          ),
          h(
            "span",
            { class: "badge " + b.status },
            {
              handoff: "已交接 · 等待人工下单",
              ordered: "已下单",
              cancelled: "已撤回",
            }[b.status],
          ),
        ),
        h(
          "p",
          {},
          b.rows
            .map(
              (r) =>
                `${r.customer} / ${r.name || r.sku} / ${r.size}码 ×${r.quantity}`,
            )
            .join("；"),
        ),
        h(
          "div",
          { class: "row-actions" },
          b.status === "handoff"
            ? btn("重新下载批次", () =>
                download(
                  "拾单-加购批次-" + b.id.slice(0, 8) + ".json",
                  batchFile(b),
                ),
              )
            : null,
          h(
            "a",
            {
              class: "button",
              href: "https://www.petit-bateau.co.jp/cart",
              target: "_blank",
              rel: "noopener noreferrer",
            },
            "打开商家购物车 ↗",
          ),
          b.status === "handoff"
            ? btn("标记本批已下单", () => changeBatch(b, "ordered"), "primary")
            : null,
          b.status === "handoff"
            ? btn("撤回并修改", () => changeBatch(b, "cancelled"), "ghost")
            : null,
        ),
      ),
    ),
  );
  $("#content").replaceChildren(content);
}
function changeBatch(b, status) {
  const cancel = status === "cancelled";
  modal(
    cancel ? "撤回批次，恢复编辑？" : "确认本批已在商家网站下单？",
    h(
      "div",
      {},
      h(
        "p",
        {},
        cancel
          ? "软件不会自动删除商家购物车中的商品。请先检查购物车，移除本批旧商品，避免下一次重复添加。"
          : "仅在你已提交商家订单后标记。软件不会替你提交订单或付款。",
      ),
      h(
        "label",
        { for: "batch-ack" },
        h(
          "span",
          {},
          h("input", { type: "checkbox", id: "batch-ack" }),
          " " +
            (cancel
              ? "我已检查并处理购物车中的本批商品"
              : "我已在商家网站完成本批下单"),
        ),
      ),
      errorBox(),
    ),
    [
      btn("取消", () => $("#dialog").close()),
      btn(
        cancel ? "撤回批次" : "确认已下单",
        () => {
          if (!$("#batch-ack").checked) {
            $("#form-error").textContent = "请先确认上面的事项";
            return;
          }
          b.status = status;
          b.rows.forEach((old) => {
            const r = state.rows.find(
              (r) => r.id === old.id && r.batchId === b.id,
            );
            if (r) {
              r.status = cancel ? "draft" : "ordered";
              if (cancel) {
                delete r.batchId;
                r.discount = old.discount;
                r.rate = old.rate;
              }
            }
          });
          persist();
          $("#dialog").close();
          renderContent();
          renderSide();
        },
        "primary",
      ),
    ],
  );
}
function showHelp() {
  modal(
    "使用说明与加购助手",
    h(
      "div",
      {},
      h("h3", {}, "电脑负责加购，手机可以录入"),
      h(
        "p",
        {},
        "先填写或粘贴明细，勾选合计不超过 20 件，再下载加购批次。浏览器之间数据不自动同步，请使用完整备份转移。",
      ),
      h("h3", {}, "首次安装（Chrome / Edge 电脑版）"),
      h(
        "ol",
        {},
        h("li", {}, "下载并解压下方助手文件。"),
        h(
          "li",
          {},
          "打开浏览器扩展管理页，开启开发者模式，选择“加载已解压的扩展程序”。",
        ),
        h(
          "li",
          {},
          "选择解压后的 extension 文件夹，点击工具栏中的“拾单加购助手”。",
        ),
        h(
          "li",
          {},
          "导入本工作台下载的批次文件。每件先核对图片、颜色和尺码，再点击“确认并加入购物车”。",
        ),
      ),
      h(
        "a",
        { class: "button primary", href: "shidan-helper.zip", download: "" },
        "下载加购助手 ZIP",
      ),
      h(
        "p",
        { class: "help" },
        "助手仅请求 Petit Bateau 日本官网的访问权限，不读取客户昵称，也不点击结算或付款。其他商家需要后续适配。",
      ),
      h("h3", {}, "金额如何计算"),
      h(
        "p",
        {},
        "计价基础固定等于网页当前售价。应收人民币 = 网页当前售价 × 核算折扣 × 数量 × 汇率 + 行运费，最后保留两位小数。网页原价仅用于核对，不参与计算。旧计价基数保留为网页当前售价。",
      ),
      h("h3", {}, "保存与恢复"),
      h(
        "p",
        {},
        "数据与图片保存在本机浏览器中，不会自动上传到网站。建议定期导出完整备份；CSV 只包含文字明细，不包含图片和批次记录。",
      ),
      undo
        ? btn("撤销最近一次删除", () => {
            state.rows.push(undo);
            undo = null;
            persist();
            $("#dialog").close();
            renderContent();
            renderSide();
            toast("已恢复明细");
          })
        : null,
    ),
    [btn("知道了", () => $("#dialog").close(), "primary")],
  );
}
function restoreBackup() {
  const picker = h("input", {
    type: "file",
    accept: ".json,application/json",
    onChange: async (e) => {
      try {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 30 * 1024 * 1024) throw Error("备份超过 30 MB");
        const data = JSON.parse(await f.text());
        if (
          data.version !== 1 ||
          !Array.isArray(data.rows) ||
          !Array.isArray(data.batches) ||
          !data.settings
        )
          throw Error("不是有效的拾单备份");
        if (data.rows.length > 2000) throw Error("备份超过 2,000 行");
        if (
          typeof data.settings.merchant !== "string" ||
          !Number.isFinite(data.settings.discount) ||
          data.settings.discount <= 0 ||
          data.settings.discount > 1 ||
          !Number.isFinite(data.settings.rate) ||
          data.settings.rate <= 0
        )
          throw Error("备份顶部设置无效");
        for (const b of data.batches) {
          if (
            typeof b.id !== "string" ||
            !["handoff", "ordered", "cancelled"].includes(b.status) ||
            !Array.isArray(b.rows) ||
            !Number.isFinite(Date.parse(b.created))
          )
            throw Error("备份批次记录无效");
          for (const r of b.rows)
            if (
              !r ||
              typeof r.id !== "string" ||
              typeof r.customer !== "string" ||
              typeof r.sku !== "string" ||
              !Number.isInteger(r.quantity) ||
              r.quantity < 1
            )
              throw Error("批次明细无效");
        }
        const ids = new Set();
        for (const r of data.rows) {
          if (!r.id || ids.has(r.id)) throw Error("备份含重复或缺失行标识");
          ids.add(r.id);
          for (const k of ["customer", "sku", "name", "size", "color", "url"])
            if (typeof r[k] !== "string") throw Error("备份字段格式错误");
          if (
            r.url &&
            !/^https:\/\/www\.petit-bateau\.co\.jp\/products\//.test(r.url)
          )
            throw Error("备份中存在无效商品链接");
          if (r.image && !safeImage(r.image)) r.image = "";
          if (!["draft", "handoff", "ordered"].includes(r.status))
            throw Error("备份中存在无效状态");
          if (!Number.isFinite(amounts(r, data.settings).cny))
            throw Error("备份中存在无效金额");
        }
        modal(
          "恢复备份？",
          h(
            "p",
            {},
            `将用备份中的 ${data.rows.length} 条明细替换当前 ${state.rows.length} 条。请先导出当前备份，避免丢失。`,
          ),
          [
            btn("取消", () => $("#dialog").close()),
            btn("导出当前备份", () => download("拾单-恢复前备份.json", state)),
            btn(
              "恢复并替换",
              () => {
                state = data;
                selected.clear();
                persist();
                $("#dialog").close();
                shell();
                $("#save-state").textContent = "已恢复备份";
              },
              "primary",
            ),
          ],
        );
      } catch (err) {
        toast("恢复失败：" + err.message);
      }
    },
  });
  picker.id = "restore-file";
  picker.style.display = "none";
  document.getElementById("restore-file")?.remove();
  document.body.append(picker);
  picker.click();
}
async function start() {
  shell();
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("shidan-workbench", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("draft");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const saved = await new Promise((res, rej) => {
      const req = db.transaction("draft").objectStore("draft").get("current");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (saved) {
      state = saved;
      shell();
    }
    setSyncMessage("已保存在此浏览器");
  } catch {
    $("#save-state").textContent = "本地存储不可用，请使用完整备份";
    toast("浏览器禁止本地存储，离开前请导出备份");
  } finally {
    // The main interface exists before authentication, including failed callbacks.
    renderContent();
    renderSide();
    try {
      await bootCloud();
    } catch {
      syncMessage = "登录未完成，请重新发送登录邮件";
      toast(syncMessage);
    } finally {
      authLoading = false;
      resumeApplicationAfterAuth();
    }
  }
}
start();

function setSyncMessage(message) {
  syncMessage = message;
  updateSyncStatus();
}

function updateSyncStatus() {
  if (!$("#save-state") || conflict) return;
  const offline = globalThis.navigator?.onLine === false;
  $("#save-state").textContent = authLoading
    ? "正在读取账号…"
    : authUser
      ? (offline ? "当前离线 · 已保存本地，联网后同步" : syncMessage) +
        " · 账号"
      : (offline ? "当前离线 · 仅保存本地" : syncMessage) + " · 邮箱登录";
  if (authDiagnostic) $("#save-state").textContent += " · " + authDiagnostic;
  $("#save-state").setAttribute(
    "aria-label",
    authUser
      ? `账号与同步：${authUser.email || "已登录"}，${syncMessage}`
      : "邮箱登录与云端同步",
  );
  if ($("#storage-note"))
    $("#storage-note").textContent = authUser
      ? "同一邮箱共用云端工作台 · 离线修改先保存在此浏览器"
      : "未登录时数据仅保存在当前浏览器 · 点击保存状态登录";
  const locked = authLoading || (authUser && !workspaceSync?.ready);
  for (const element of $$(".settings,.workspace,.mobile-bottom-nav"))
    element.inert = Boolean(locked);
  const restore = $$(".top-actions button").find(
    (button) => button.textContent === "恢复备份",
  );
  if (restore) restore.disabled = Boolean(locked);
}

function localGet(key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction("draft").objectStore("draft").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function localPut(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("draft", "readwrite");
    tx.objectStore("draft").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("本地保存失败"));
  });
}

function applyCloudSnapshot(snapshot) {
  state = snapshot;
  selected = new Set(
    [...selected].filter((id) => state.rows.some((r) => r.id === id)),
  );
  undo = null;
  $("#merchant").value = state.settings.merchant;
  $("#discount").value = state.settings.discount;
  $("#rate").value = state.settings.rate;
  renderContent();
  renderSide();
}

async function changeAccount(user) {
  const epoch = ++authEpoch;
  authLoading = true;
  workspaceSync?.dispose();
  workspaceSync = null;
  clearTimeout(syncTimer);
  $("#dialog")?.close();
  updateSyncStatus();
  await writeQueue;
  if (epoch !== authEpoch) return;
  authUser = user;
  selected.clear();
  undo = null;
  query = "";
  filter = "all";
  page = 1;
  const guest = (await localGet("current")) || emptyWorkspace();
  if (epoch !== authEpoch) return;
  await localPut(
    "cloud-session",
    user ? { id: user.id, email: user.email } : null,
  );
  if (epoch !== authEpoch) return;
  if (!user) {
    state = guest;
    authLoading = false;
    syncMessage = "已保存在此浏览器";
    shell();
    return;
  }
  state = emptyWorkspace();
  shell();
  const engine = new WorkspaceSync({
    userId: user.id,
    api: { read: readCloudWorkspace, save: saveCloudWorkspace },
    storage: { get: localGet, put: localPut },
    empty: emptyWorkspace(),
    onSnapshot: (value) => {
      if (epoch === authEpoch) applyCloudSnapshot(value);
    },
    onStatus: (message) => {
      if (epoch === authEpoch) setSyncMessage(message);
    },
    canApply: () =>
      !conflict &&
      !$("#dialog")?.open &&
      !document.activeElement?.matches(
        "input,textarea,select,[contenteditable=true]",
      ),
  });
  workspaceSync = engine;
  try {
    await engine.init(guest);
  } catch {
    setSyncMessage("云端暂不可用 · 本地副本已保留，点击重试");
  } finally {
    if (epoch === authEpoch) {
      authLoading = false;
      updateSyncStatus();
      if (engine.problem === "migration") showAccount();
    }
  }
}

function resumeApplicationAfterAuth() {
  if (!$("#content") || !$("#save-state")) shell();
  renderContent();
  renderSide();
  updateSyncStatus();
}

function clearAuthCallbackLocation() {
  // Also covers failure to load the auth module itself (e.g. embedded mail browser).
  try {
    const url = new URL(location.href);
    const keys = ["code", "token_hash", "error", "error_code", "error_description"];
    const hash = new URLSearchParams(url.hash.slice(1));
    const hasHash = ["access_token", "refresh_token", ...keys].some(
      (key) => hash.has(key),
    );
    const changed = hasHash || keys.some((key) => url.searchParams.has(key));
    if (!changed) return;
    for (const key of keys) url.searchParams.delete(key);
    if (hasHash) url.hash = "";
    history.replaceState(
      history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  } catch {
    /* History restrictions must never block the workbench. */
  }
}

async function bootCloud() {
  if (!db && typeof location === "undefined") return;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    authLoading = true;
    updateSyncStatus();
    let safeError = () => ({code:"auth_module_unavailable",message:"认证模块未能加载"});
    try {
      const { initializeAuthCallback, authReturnType, safeAuthError } = await loadAuthModule();
      safeError = safeAuthError;
      authDiagnosticType = authReturnType();
      const client = await initializeAuthCallback({onDiagnostic: stage => showAuthDiagnostic(stage)});
      showAuthDiagnostic("读取 session");
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      showAuthDiagnostic("读取 session", data.session?.user ? "成功：已建立 session" : "结果：未发现 session");
      if (!db) {
        authUser = data.session?.user || null;
        setSyncMessage(
          authUser
            ? "已登录 · 本地存储不可用，请使用完整备份"
            : "本地存储不可用，请使用完整备份",
        );
        return client;
      }
      if (!authSubscription) {
        authSubscription = client.auth.onAuthStateChange((_event, session) => {
          const next = session?.user || null;
          // Never await Supabase calls inside its synchronous auth callback.
          setTimeout(() => {
            if ((next?.id || null) !== (authUser?.id || null)) {
              changeAccount(next).catch(() =>
                setSyncMessage("账号读取失败，请刷新页面"),
              );
            }
          }, 0);
        }).data.subscription;
      }
      if ((data.session?.user?.id || null) !== (authUser?.id || null)) {
        await changeAccount(data.session?.user || null);
      }
      return client;
    } catch (error) {
      // Retain the existing offline-account fallback, but isolate its errors too.
      if (db && error?.code !== "AUTH_CALLBACK_FAILED") {
        try {
          const cachedUser = await localGet("cloud-session");
          if (cachedUser && !authUser) await changeAccount(cachedUser);
        } catch {
          /* Callback failure must not abort app initialization. */
        }
      }
      const detail = error?.diagnostic || safeError(error);
      showAuthDiagnostic(authDiagnosticStage, `失败：${detail.code} · ${detail.message}`);
      syncMessage = "登录未完成，请重新发送登录邮件";
      toast(syncMessage);
    } finally {
      authLoading = false;
      bootPromise = null;
      clearAuthCallbackLocation();
      // A callback/CDN/session/storage exception must always return to the app.
      resumeApplicationAfterAuth();
    }
  })();
  return bootPromise;
}

async function syncNow(force = false) {
  if (conflict || authLoading || !workspaceSync) return;
  try {
    await writeQueue;
    await workspaceSync.refresh(force);
  } catch {
    setSyncMessage(
      globalThis.navigator?.onLine === false
        ? "当前离线 · 已保存本地，联网后同步"
        : "同步未完成 · 本地已保留，点击重试",
    );
  }
}

function showAccount() {
  if (authLoading || authBusy) return;
  if (!db) {
    toast("本地存储不可用，请先允许浏览器存储并刷新");
    return;
  }
  if (!authUser) {
    showEmailLogin();
    return;
  }
  const engine = workspaceSync;
  const body = h(
    "div",
    {},
    h("p", {}, `当前邮箱：${authUser.email || "已登录"}`),
    h("p", { role: "status" }, syncMessage),
    errorBox(),
  );
  const cancel = btn("关闭", () => $("#dialog").close());
  const logout = btn(
    "退出登录",
    () => {
      modal(
        "退出当前邮箱？",
        h(
          "p",
          {},
          "未同步的修改会保留在此浏览器的当前账号副本中。再次登录此邮箱后继续同步；退出后显示原来的本地工作台。",
        ),
        [
          btn("取消", () => $("#dialog").close()),
          btn("确认退出", async (event) => {
            event.target.disabled = true;
            authBusy = true;
            try {
              await writeQueue;
              await engine?.queue;
              await signOut();
              if (authUser) await changeAccount(null);
            } catch {
              toast("退出失败，请联网后重试；数据已保留");
            } finally {
              authBusy = false;
              event.target.disabled = false;
            }
          }),
        ],
      );
    },
    "ghost",
  );
  if (engine?.problem === "migration") {
    body.append(
      h(
        "p",
        {},
        engine.remote
          ? "当前邮箱已有云端数据。使用云端数据不会删除本浏览器原有的本地工作台；退出登录后仍可查看或导出本地原件。"
          : "发现此浏览器有本地数据。是否迁移到当前邮箱，让手机和电脑共用？本地原件仍会保留。",
      ),
    );
    const choose = (upload) => async (event) => {
      event.target.disabled = true;
      try {
        await engine.chooseMigration(upload);
        $("#dialog").close();
        updateSyncStatus();
      } catch (error) {
        if ($("#form-error")) $("#form-error").textContent = error.message;
      } finally {
        event.target.disabled = false;
      }
    };
    modal(
      "确认本地数据迁移",
      body,
      [
        cancel,
        logout,
        btn(
          engine.remote ? "使用云端数据" : "不迁移，使用空白云端工作台",
          choose(false),
        ),
        engine.remote ? null : btn("确认迁移到此邮箱", choose(true), "primary"),
      ].filter(Boolean),
    );
    return;
  }
  if (engine?.problem === "conflict") {
    body.append(
      h(
        "p",
        {},
        "其他设备已修改云端数据。请先导出本地副本，再读取云端，避免丢失自己的修改。",
      ),
    );
    const useCloud = btn(
      "读取云端数据",
      async (event) => {
        event.target.disabled = true;
        try {
          await engine.useCloudAfterConflict();
          $("#dialog").close();
          updateSyncStatus();
        } catch (error) {
          if ($("#form-error")) $("#form-error").textContent = error.message;
        } finally {
          event.target.disabled = false;
        }
      },
      "primary",
      { disabled: true },
    );
    modal("同步冲突 · 本地数据已保留", body, [
      cancel,
      btn("导出本地副本", () => {
        download("拾单-同步冲突本地副本.json", state);
        useCloud.disabled = false;
      }),
      useCloud,
    ]);
    return;
  }
  modal("邮箱账号与同步", body, [
    cancel,
    logout,
    btn(
      "重试同步",
      async () => {
        $("#dialog").close();
        await bootCloud();
        await syncNow(true);
        if (workspaceSync?.problem) showAccount();
      },
      "primary",
    ),
  ]);
}

function showEmailLogin() {
  let sentEmail = "",
    busy = false;
  const email = field("邮箱", "login-email", "", "email", {
    autocomplete: "email",
    "aria-describedby": "form-error",
  });
  const code = field("邮件验证码（如有）", "login-code", "", "password", {
    autocomplete: "one-time-code",
    inputmode: "numeric",
    "aria-describedby": "form-error",
  });
  code.classList.add("hidden");
  const hint = h(
    "p",
    { class: "help", role: "status" },
    "使用同一邮箱登录，手机和电脑读取同一份工作台数据。",
  );
  const error = errorBox();
  const body = h(
    "form",
    {
      novalidate: "",
      onSubmit: (event) => {
        event.preventDefault();
        if (!busy) (sentEmail ? verify : send).click();
      },
    },
    email,
    code,
    hint,
    error,
  );
  const send = btn(
    "发送登录邮件",
    async () => {
      if (busy) return;
      const input = email.querySelector("input"),
        value = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        error.textContent = "请填写有效邮箱";
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      input.removeAttribute("aria-invalid");
      busy = true;
      send.disabled = true;
      verify.disabled = true;
      error.textContent = "";
      try {
        await bootCloud();
        await sendEmailCode(value);
        sentEmail = value;
        code.classList.remove("hidden");
        input.readOnly = true;
        hint.textContent =
          "邮件已发送。点击邮件中的登录链接返回本站；若邮件含验证码，在下方输入后登录。";
        verify.classList.remove("hidden");
        code.querySelector("input").focus();
      } catch {
        error.textContent = "邮件未发送成功，请检查网络、邮箱或稍后重试。";
      } finally {
        busy = false;
        send.disabled = false;
        verify.disabled = false;
      }
    },
    "primary",
  );
  const verify = btn(
    "验证并登录",
    async () => {
      if (busy) return;
      const token = code.querySelector("input").value.trim();
      if (!/^\d{6,10}$/.test(token)) {
        error.textContent = "请输入邮件中的数字验证码";
        return;
      }
      busy = true;
      verify.disabled = true;
      send.disabled = true;
      error.textContent = "";
      try {
        const session = await verifyEmailCode(sentEmail, token);
        if (session?.user && authUser?.id !== session.user.id)
          await changeAccount(session.user);
      } catch {
        error.textContent = "验证码无效或已过期，请检查后重试或重新发送邮件。";
      } finally {
        busy = false;
        verify.disabled = false;
        send.disabled = false;
      }
    },
    "primary",
  );
  verify.classList.add("hidden");
  modal("邮箱登录", body, [
    btn("取消", () => $("#dialog").close()),
    send,
    verify,
  ]);
  email.querySelector("input").focus();
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", updateSyncStatus);
  window.addEventListener("online", () => {
    updateSyncStatus();
    bootCloud()
      .then(() => syncNow())
      .catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncNow();
  });
  setInterval(() => {
    if (!document.hidden) syncNow();
  }, 15000);
}

function showChainImport() {
  const area = h("textarea", {
    id: "chain-text",
    "aria-label": "接龙原文",
    placeholder:
      "货号：A0CV9030\n名称：藏青色背带裤\n1. 小林 95码 1件\n2. 小陈 104码 2件",
  });
  const hint = h(
    "p",
    { class: "help" },
    "支持编号接龙；货号、名称、尺码可写在顶部作为公共信息。每条可覆盖。图片需导入后补充，未写数量默认 1 件。",
  );
  modal("粘贴接龙 · 先预览再导入", h("div", {}, hint, area, errorBox()), [
    btn("取消", () => $("#dialog").close()),
    btn(
      "解析并预览",
      () => {
        try {
          const result = parseChain(area.value);
          showChainPreview(result, area.value);
        } catch (e) {
          $("#form-error").textContent = e.message;
        }
      },
      "primary",
    ),
  ]);
}
function showChainPreview(result, original) {
  const body = h(
    "div",
    {},
    h(
      "p",
      {},
      `识别到 ${result.rows.length} 条接龙。可直接修改；向右滚动可查看尺码与数量。`,
    ),
  );
  const head = h(
    "thead",
    {},
    h(
      "tr",
      {},
      ["昵称", "货号", "商品名称", "尺码", "数量"].map((x) =>
        h("th", { scope: "col" }, x),
      ),
    ),
  );
  const rows = result.rows.map(({ row }, index) => {
    const cells = ["customer", "sku", "name", "size", "quantity"].map((key) => {
      const input = h("input", {
        "aria-label": `接龙第 ${index + 1} 条 ${{ customer: "昵称", sku: "货号", name: "商品名称", size: "尺码", quantity: "数量" }[key]}`,
        value: row[key],
        type: key === "quantity" ? "number" : "text",
        onInput: (e) => {
          row[key] =
            key === "quantity" ? Number(e.target.value) : e.target.value;
        },
      });
      return h("td", {}, input);
    });
    return h("tr", {}, cells);
  });
  const table = h("table", {}, head, h("tbody", {}, rows));
  body.append(
    h(
      "div",
      {
        class: "table-wrap",
        style: "min-height:0",
        tabindex: "0",
        "aria-label": "接龙预览，可横向滚动",
      },
      table,
    ),
  );
  result.rows.forEach(({ row, issues }) => {
    if (issues.length)
      body.append(
        h(
          "p",
          { class: "notice" },
          `第 ${row.seq} 条：${issues.join("；")}。原文：${row.note}`,
        ),
      );
  });
  if (result.notes.length)
    body.append(
      h(
        "p",
        { class: "help" },
        "未作为商品导入的说明：" + result.notes.join(" / "),
      ),
    );
  body.append(
    h(
      "p",
      { class: "help" },
      "价格和运费暂为 0，图片尚未添加。缺少必填信息的行可先保存，补齐前不能推送。",
    ),
    errorBox(),
  );
  modal("核对接龙解析结果", body, [
    btn("返回修改原文", () => {
      showChainImport();
      $("#chain-text").value = original;
    }),
    btn(
      "确认导入明细",
      () => {
        if (state.rows.length + result.rows.length > 2000) {
          $("#form-error").textContent = "超过 2,000 行，请分文件处理";
          return;
        }
        for (const { row } of result.rows) {
          if (row.url && !productUrl(row.url)) {
            row.url = "";
          }
          state.rows.push(row);
        }
        persist();
        $("#dialog").close();
        tab = "details";
        filter = "all";
        query = "";
        page = 1;
        renderContent();
        renderSide();
        toast(`已导入 ${result.rows.length} 条接龙，请补齐标记的信息`);
      },
      "primary",
    ),
  ]);
}

// Responsive projections of the same rows. No separate mobile state or calculations.
function mobileRecords(visible, eligible) {
  const all = h("input", {
    type: "checkbox",
    "aria-label": "手机选择本页待处理明细",
    checked: eligible.length > 0 && eligible.every((r) => selected.has(r.id)),
    disabled: !eligible.length || conflict,
    onChange: (e) => {
      eligible.forEach((r) =>
        e.target.checked ? selected.add(r.id) : selected.delete(r.id),
      );
      renderRowsOnly();
      renderSide();
    },
  });
  all.indeterminate =
    eligible.some((r) => selected.has(r.id)) &&
    !eligible.every((r) => selected.has(r.id));
  return h(
    "div",
    {
      class: "mobile-only mobile-records",
      "aria-label": tab === "billing" ? "账单卡片" : "商品卡片",
    },
    h("label", { class: "mobile-select-all" }, all, "选择本页待处理明细"),
    visible.length
      ? visible.map((r) => mobileRecord(r, tab === "billing"))
      : h(
          "div",
          { class: "empty" },
          h(
            "strong",
            {},
            state.rows.length ? "没有符合条件的明细" : "从第一件商品开始",
          ),
          h(
            "p",
            {},
            state.rows.length
              ? "换个关键词或清除筛选再试试。"
              : "可以新增商品，也可以粘贴 Excel 或接龙。",
          ),
          state.rows.length
            ? btn("清除筛选", () => {
                query = "";
                filter = "all";
                page = 1;
                renderContent();
              })
            : btn("载入已验证示例", loadSample, "primary"),
        ),
  );
}
function mobileRecord(r, billing) {
  const a = amounts(r, state.settings);
  const editable = (key, label, type = "text") => {
    const input = inline(r, key, label, "", type);
    input.setAttribute("aria-label", `手机 ${r.seq} ${label}`);
    if (type === "number")
      input.setAttribute(
        "inputmode",
        key === "quantity" ? "numeric" : "decimal",
      );
    return h("label", {}, h("span", {}, label), input);
  };
  const facts = (entries) =>
    h(
      "dl",
      { class: "mobile-facts" },
      entries.map(([label, value]) =>
        h("div", {}, h("dt", {}, label), h("dd", {}, value || "未填写")),
      ),
    );
  return h(
    "article",
    {
      class: "mobile-record" + (selected.has(r.id) ? " selected" : ""),
      "data-mobile-row": r.id,
      "aria-label": `${billing ? "账单" : "商品"} ${r.seq} ${r.customer}`,
    },
    h(
      "header",
      {},
      h(
        "label",
        { class: "mobile-row-check" },
        h("input", {
          type: "checkbox",
          "aria-label": `手机选择第 ${r.seq} 行`,
          checked: selected.has(r.id),
          disabled: r.status !== "draft" || conflict,
          onChange: (e) => {
            e.target.checked ? selected.add(r.id) : selected.delete(r.id);
            renderRowsOnly();
            renderSide();
          },
        }),
        h("strong", {}, r.customer || "未填客户"),
        h("span", { class: "muted" }, "#" + r.seq),
      ),
      h(
        "span",
        { class: "badge " + r.status },
        { draft: "待处理", handoff: "已交接", ordered: "已下单" }[r.status],
      ),
    ),
    h(
      "div",
      { class: "mobile-product" },
      btn(imageNode(r), () => editRow(r), "image-button", {
        "aria-label": `手机编辑第 ${r.seq} 行图片`,
      }),
      h(
        "div",
        {},
        h("strong", {}, r.name || r.sku || "未填写商品名称"),
        h(
          "small",
          { class: "muted" },
          [r.sku, r.color, r.size ? r.size + "码" : ""]
            .filter(Boolean)
            .join(" · "),
        ),
        productUrl(r.url)
          ? h(
              "a",
              {
                href: r.url,
                target: "_blank",
                rel: "noopener noreferrer",
                class: "inline-link",
              },
              "查看商品 ↗",
            )
          : null,
      ),
    ),
    billing
      ? h(
          "div",
          {},
          h(
            "div",
            { class: "mobile-fields" },
            facts([
              [
                "计价基础（网页当前售价）",
                `${r.price || 0} ${r.currency || "JPY"}`,
              ],
            ]),
            editable("quantity", "数量", "number"),
            editable("discount", "核算折扣", "number"),
            editable("rate", "汇率", "number"),
            editable("shipping", "行运费（人民币）", "number"),
          ),
          h(
            "p",
            { class: "mobile-formula" },
            `${r.price || 0} ${r.currency || "JPY"} × ${a.discount} × ${r.quantity} × ${a.rate} + ${r.shipping || 0} = ${money(a.cny)} 人民币`,
          ),
        )
      : h(
          "div",
          {},
          facts([
            ["货号", r.sku],
            ["颜色", r.color],
          ]),
          h(
            "div",
            { class: "mobile-fields" },
            editable("size", "尺码"),
            editable("quantity", "数量", "number"),
            editable("originalPrice", "网页原价", "number"),
            editable("price", "网页当前售价", "number"),
            editable("currency", "币种"),
          ),
        ),
    h(
      "footer",
      {},
      h(
        "div",
        {},
        h("small", { class: "muted" }, "应收人民币"),
        h("strong", { class: "money" }, "¥ " + money(a.cny)),
      ),
      btn(billing ? "编辑账单明细" : "编辑商品", () => editRow(r), "ghost"),
    ),
  );
}
