import {getMerchant} from './merchants.js';
import { parseChain } from "./chain.js?pricing=1";
let syncCodeModule;
function loadSyncCode() {
  return syncCodeModule ||= import("./sync-code.js?v=1").catch(error => { syncCodeModule = null; throw error; });
}
const readCloudWorkspace = async (...args) => (await loadSyncCode()).readCloudWorkspace(...args);
const saveCloudWorkspace = async (...args) => (await loadSyncCode()).saveCloudWorkspace(...args);
const signOut = async () => {
  (await loadSyncCode()).disconnectSyncCode();
  await localPut("active-sync-code", null);
};
import { WorkspaceSync } from "./workspace-sync.js";
import {
  DEFAULTS,
  uid,
  newRow,
  amounts,
  batchCheck,
  validateRow,
  detailError,
  safeProductImage,
  validQuote,
  importRows,
  csvCell,
  productUrl,
  round,
} from "./core.js?pricing=1";
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
function persist(onFailure) {
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
        onFailure?.(error);
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
    .catch((error) => {
      onFailure?.(error || Error("本地保存失败"));
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
// Keep checkbox nodes mounted while selection changes: native click/change and
// desktop/mobile projections must observe the same Set, without rebuilding fields.
function updateSelectionView() {
  const rows = selectRows();
  for (const box of $$('input[data-select-row]')) {
    const on = selected.has(box.dataset.selectRow);
    box.checked = on;
    box.closest('tr,article')?.classList.toggle('selected', on);
  }
  for (const box of $$('input[data-select-page]')) {
    const ids = JSON.parse(box.dataset.selectPage);
    box.checked = ids.length > 0 && ids.every(id => selected.has(id));
    box.indeterminate = ids.some(id => selected.has(id)) && !box.checked;
  }
  renderSide();
}
function selectPageItems(rows, checked) {
  const remaining = 20 - selectRows().reduce((sum, row) => sum + Number(row.quantity), 0);
  const anySelected = rows.some(row => selected.has(row.id));
  const canAdd = rows.some(row => !selected.has(row.id) && Number(row.quantity) <= remaining);
  // A capped partial page can still be cleared using its select-all checkbox.
  selectItems(rows, checked && (!anySelected || canAdd));
}
function selectItems(rows, checked) {
  if (conflict || authLoading) { updateSelectionView(); return; }
  let count = selectRows().reduce((sum, row) => sum + Number(row.quantity), 0);
  let limited = false;
  for (const row of rows) {
    if (!checked) { selected.delete(row.id); continue; }
    if (selected.has(row.id)) continue;
    const quantity = Number(row.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || count + quantity > 20) { limited = true; continue; }
    selected.add(row.id); count += quantity;
  }
  updateSelectionView();
  if (limited) toast('最多选择 20 件，超出数量的明细未勾选');
}
function imageNode(row) {
  if (row.webImage || row.image)
    return h("img", {
      class: "thumb",
      src: row.webImage || row.image,
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
const safeImage = safeProductImage;
function field(label, id, value, type = "text", attrs = {}) {
  return h(
    "label",
    { for: id },
    label,
    h("input", { id, type, value, ...attrs }),
  );
}
function checkMerchant() {
  const input = $("#merchant");
  const valid = Boolean(productUrl(input.value.trim()));
  if (!valid) {
    input.setAttribute("aria-invalid", "true");
    toast("请先填写有效的商家网址（http:// 或 https://）");
    input.focus();
  } else input.removeAttribute("aria-invalid");
  return valid;
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
          h("p", {}, "粘贴接龙 · 勾选明细 · 核对后加购"),
        ),
        h(
          "span",
          {
            id: "save-state",
            class: "save",
            "aria-live": "polite",
            role: "button",
            tabindex: "0",
            title: "同步码与云端同步",
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
        field("商家网址（必填）", "merchant", state.settings.merchant, "url", {
          required: "",
          "aria-required": "true",
          onChange: (e) => {
            settingInput("merchant", e.target.value.trim());
            checkMerchant();
          },
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
            btn("安装加购助手 ↗", installHelper, "ghost"),
          ),
        ),
      ),
      h(
        "footer",
        { class: "page-note" },
        h(
          "span",
          { id: "storage-note" },
          "无需登录即可使用 · 点击保存状态设置同步码",
        ),
        h("span", {}, "支持：Petit Bateau · panpantutu · Miki House · Montbell 日本站"),
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
  const eligible = visible;
  const all = h("input", {
    type: "checkbox",
    "aria-label": "选择本页明细",
    checked: eligible.length > 0 && eligible.every((r) => selected.has(r.id)),
    disabled: !eligible.length || conflict,
    "data-select-page": JSON.stringify(eligible.map(r => r.id)),
    onChange: (e) => selectPageItems(eligible, e.target.checked),
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
          : "点击“粘贴接龙”，按固定格式一键生成明细。",
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
  if (["price", "originalPrice", "currency"].includes(key)) return h("input", {value:r[key] ?? (key==="currency"?"JPY":""),readonly:"",class:cls,"aria-label":`${r.seq} ${label}`,title:"由加购助手核对后回写，只读"});
  const a = amounts(r, state.settings);
  if(['discount','rate','shipping'].includes(key))return h('div',{},h('input',{value:a[key],readonly:'',class:cls,'aria-label':`${r.seq} ${label}`,title:'请在编辑明细的高级计价中设置'}),h('small',{class:'muted'},r[key]===''||r[key]==null?'继承批次设置':'单条覆盖'));
  let value = ["discount", "rate", "shipping"].includes(key)
    ? a[key]
    : key === "currency"
      ? r.currency || "JPY"
      : (r[key] ?? "");
  return h("input", {
    value,
    type,
    class: cls,
    "aria-label": `${r.seq} ${label}`,
    "data-row-id": r.id,
    "data-field": key,
    title: ["discount", "rate", "shipping"].includes(key)
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
        ? v === "" && ["discount", "rate", "shipping", "originalPrice"].includes(key)
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
      if (key === "quantity" && selected.has(r.id) && selectRows().reduce((n,row) => n + Number(row.quantity), 0) > 20) {
        selected.delete(r.id);
        toast("该明细数量变更后超过 20 件，已取消勾选");
      }
      persist();
      // Preserve an in-flight click when a changed field loses focus to a checkbox.
      if (tab === "details") {
        const desktop = $$('tr[data-row-id]').find(n => n.dataset.rowId === r.id);
        if (desktop) {
          const fresh = rowNode(r);
          [...desktop.children].slice(1).forEach((cell, i) => cell.replaceWith(fresh.children[1]));
        }
        const mobile = $$('article[data-mobile-row]').find(n => n.dataset.mobileRow === r.id);
        if (mobile) {
          const fresh = mobileRecord(r, false);
          mobile.querySelector('header strong').textContent = r.customer || '未填客户';
          [...mobile.children].slice(1).forEach(child => child.replaceWith(fresh.children[1]));
        }
        updateSelectionView();
      } else { renderRowsOnly(); renderSide(); }
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
    { class: selected.has(r.id) ? "selected" : "", "data-row-id": r.id },
    h(
      "td",
      {},
      h("input", {
        type: "checkbox",
        "aria-label": `选择第 ${r.seq} 行`,
        checked: selected.has(r.id),
        disabled: conflict,
        "data-select-row": r.id,
        title: "选择该条明细，可重新发起一次加购",
        onChange: (e) => selectItems([r], e.target.checked),
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
          "aria-label": `编辑第 ${r.seq} 行明细`,
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
        { class: `badge ${r.status}`, title: r.helper?.reason || "" },
        helperStatus(r),
      ),
      r.helper?.reason ? h("small", {class:"muted"}, r.helper.reason) : null,
    ),
    h(
      "td",
      {},
      btn("编辑", () => editRow(r), "ghost"),
    ),
  );
}
function mobileCartDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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
      : mobileCartDevice() ? '加购仅支持电脑 Chrome；手机可录入并同步明细' : batchCheck(rows, state.settings);
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
    btn("开始加购 →", startHelper, "primary", {
      disabled: !!error || conflict,
      "aria-describedby": "batch-error",
    }),
    btn(
      "取消全部勾选",
      () => {
        selected.clear();
        updateSelectionView();
      },
      "ghost",
      { disabled: !rows.length },
    ),
    h(
      "p",
      { class: "note" },
      "助手打开明细商品链接，读取网页主图，逐件人工核对后加购。不一致会标记“需人工核对”，不会下单或付款。",
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
  if (!existing && !checkMerchant()) return;
  if (!existing && state.rows.length >= 2000) return toast("最多2,000条明细，请先导出备份再分批处理");
  const r = existing || newRow({seq: Math.max(0, ...state.rows.map(r => Number(r.seq) || 0)) + 1});
  const epoch = authEpoch;
  let saving = false;
  const fields = [
    ['customer','客户昵称（必填）','text'], ['sku','货号（必填）','text'],
    ['size','目标尺码（cm，必填）','text'], ['quantity','数量（必填）','number'],
    ['url','商品链接（必填）','url'], ['name','商品名称（选填）','text'], ['color','颜色（选填）','text'],
  ];
  const error = errorBox();
  const advanced = h('details',{class:'advanced-pricing'},h('summary',{},'高级计价 · '+(['discount','rate','shipping'].some(k=>r[k]!==''&&r[k]!=null)?'单条覆盖':'继承批次设置')));
  for(const [key,label] of [['discount','核算折扣'],['rate','汇率（本币 → 人民币）'],['shipping','本行运费（人民币）']]){
    const overridden = r[key] !== '' && r[key] != null;
    const input=field(label,'edit-'+key,overridden?r[key]:'','number',{step:'any',disabled:!overridden});
    const control=input.querySelector('input');
    const mode=h('select',{id:'edit-'+key+'-mode','aria-label':label+'计价方式',onChange:e=>{
      control.disabled=e.target.value==='inherit';
      advanced.querySelector('summary').textContent='高级计价 · '+([...advanced.querySelectorAll('select')].some(n=>n.value==='override')?'单条覆盖':'继承批次设置');
      if(!control.disabled && control.value==='')control.value=amounts(r,state.settings)[key];
    }},h('option',{value:'inherit'},'继承批次设置'),h('option',{value:'override'},'单条覆盖'));
    mode.value=overridden?'override':'inherit';
    advanced.append(h('div',{class:'pricing-override'},h('label',{for:mode.id},label+'设置',mode),input));
  }
  advanced.append(h('p',{class:'help'},'留在“继承批次设置”时跟随顶部折扣、汇率；默认行运费为 '+money(state.settings.shipping || 0)+' 元。单条覆盖仅影响本条，运费整行只加一次。'));
  const readonlyPrice = h('div',{class:'form-grid price-readonly','aria-label':'网页价格（只读）'},
    ...[['originalPrice','网页原价'],['price','网页当前售价'],['currency','币种']].map(([key,label])=>field(label,'read-'+key,
      key==='currency' ? (r.currency || 'JPY') : (r[key] === '' || r[key] == null ? '未读取' : r[key]),'text',{readonly:''})),
    h('p',{class:'help wide'},r.priceReadAt ? '价格读取时间：'+new Date(r.priceReadAt).toLocaleString('zh-CN') : '尚未由加购助手核对回写；已有价格保留。Petit Bateau 默认币种为 JPY。'));
  const form=h('form',{novalidate:'',onSubmit:e=>e.preventDefault()},
    h('div',{class:'form-grid'},...fields.map(([key,label,type])=>field(label,'edit-'+key,r[key] ?? '',type,{
      'data-key':key, ...(!['name','color'].includes(key)?{'aria-required':'true'}:{}),
      ...(key==='quantity'?{min:1,max:20,step:1}:{}),
    }))),
    h('div',{class:'readonly-photo'},h('strong',{},'网页主图（只读）'),r.webImage || r.image ? imageNode(r):h('p',{class:'help'},'打开商品链接后由助手自动读取主图，客户无需提供图片。')),
    h('p',{class:'help'},'通过商品链接打开对应商品页，自动读取网页主图；核对货号、目标尺码和款式，无法确认时停止并标记“需人工核对”。'),
    readonlyPrice,
    h('p',{class:'help'},'应收人民币 = 网页当前售价 × 核算折扣 × 数量 × 汇率 + 行运费。网站原价不参与计算；不会再叠加网站促销折扣。'),
    advanced,
    r.helper ? h('p',{class:'notice'},`${helperStatus(r)} · 已加 ${r.helper.added}/${r.quantity} 件。${r.helper.reason || ''}`) : null,error);
  const cancel=btn('取消',()=>$('#dialog').close());
  const saveButton=btn(existing?'保存修改':'保存明细',async()=>{
    if(saving)return;
    if(conflict||authLoading||epoch!==authEpoch||!db||(workspaceSync&&!workspaceSync.ready))return toast('请等待同步完成或刷新后再保存');
    if(!existing&&!checkMerchant())return;
    const v={...r};
    for(const [key,,type] of fields){const raw=$('#edit-'+key).value.trim();v[key]=type==='number'?Number(raw):raw;}
    for(const key of ['discount','rate','shipping']){
      const isOverride=$('#edit-'+key+'-mode').value==='override';
      const raw=$('#edit-'+key).value.trim();v[key]=isOverride ? (raw===''?NaN:Number(raw)) : '';
    }
    for(const input of form.querySelectorAll('[aria-invalid]')){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}
    const issue=detailError(v);
    if(issue){error.textContent=issue.message;const input=$('#edit-'+issue.key);if(input){input.closest('details')?.setAttribute('open','');input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby','form-error');input.focus();}return;}
    const before=structuredClone(r);
    if(existing)Object.assign(existing,v);else state.rows.push(v);
    saving=true;saveButton.disabled=cancel.disabled=true;saveButton.setAttribute('aria-busy','true');
    let failure;persist(e=>{failure=e});await writeQueue;
    if(epoch!==authEpoch)return;
    if(failure){if(existing){for(const key of [...fields.map(f=>f[0]),'discount','rate','shipping'])existing[key]=before[key];}else state.rows=state.rows.filter(row=>row!==v);saving=false;saveButton.disabled=cancel.disabled=false;saveButton.removeAttribute('aria-busy');error.textContent='保存失败，请重试；输入已保留。';return;}
    if(selected.has(v.id)&&selectRows().reduce((n,row)=>n+Number(row.quantity),0)>20)selected.delete(v.id);
    $('#dialog').close();renderContent();renderSide();toast(existing?'已保存修改':'明细已保存');
  },'primary');
  const actions=[cancel,saveButton];
  if(existing)actions.push(btn('删除该条明细',()=>{if(!saving)confirmDeleteRow(r)},'ghost danger'));
  modal(existing?`编辑明细 · ${r.seq}`:'新增明细',form,actions);
}
function confirmDeleteRow(row) {
  if (conflict || authLoading || (workspaceSync && !workspaceSync.ready))
    return toast("请等待同步完成或刷新后再删除");
  const dialog = $("#dialog"), editor = [...dialog.childNodes], epoch = authEpoch;
  let deleting = false;
  const cleanup = () => {
    dialog.removeEventListener("cancel", cancel);
    dialog.removeEventListener("close", cleanup);
    dialog.removeAttribute("aria-describedby");
  };
  const restore = () => {
    if (deleting) return;
    cleanup();
    dialog.replaceChildren(...editor);
    [...dialog.querySelectorAll("button")].find(b => b.textContent === "删除该条明细")?.focus();
  };
  const cancel = event => { event.preventDefault(); restore(); };
  const cancelButton = btn("取消", restore);
  const error = h("p", {class:"error",role:"alert"});
  const deleteButton = btn("删除明细", async () => {
    if (deleting) return;
    if (epoch !== authEpoch || conflict || authLoading || !db || (workspaceSync && !workspaceSync.ready)) {
      error.textContent = "工作台状态已变化或存储不可用，请关闭弹窗并刷新后重试";
      return;
    }
    const index = state.rows.indexOf(row);
    if (index < 0) { error.textContent = "该明细已变化或已移除，请关闭弹窗后重新查看"; return; }
    deleting = true; deleteButton.disabled = cancelButton.disabled = true;
    deleteButton.setAttribute("aria-busy", "true");
    state.rows.splice(index, 1);
    let failure;
    persist(e => { failure = e; });
    await writeQueue;
    if (epoch !== authEpoch) { cleanup(); return; }
    if (failure) {
      if (!state.rows.some(r => r.id === row.id)) state.rows.splice(Math.min(index,state.rows.length),0,row);
      deleting = false; deleteButton.disabled = cancelButton.disabled = false;
      deleteButton.removeAttribute("aria-busy");
      error.textContent = "删除未保存，请重试。";
      renderContent(); renderSide();
      return;
    }
    selected.delete(row.id);
    cleanup(); dialog.close();
    renderContent(); renderSide();
    toast("已删除该条明细");
  }, "danger");
  modal("确认删除这条明细？", h("div", {},
    h("p", {id:"delete-detail-description"}, "删除后将从当前同步工作台移除，无法恢复。"), error
  ), [cancelButton, deleteButton]);
  dialog.setAttribute("aria-describedby", "delete-detail-description");
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener("close", cleanup);
  cancelButton.focus();
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
      a.shipping,
      r.price,
      a.discount,
      a.rate,
      a.yen,
      a.cny,
      helperStatus(r),
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
const helperRequests = new Map();
function helperRequest(type, data = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const requestId = uid();
    const timer = setTimeout(() => { helperRequests.delete(requestId); reject(Error('未连接到加购助手。请安装或更新扩展，再刷新拾单页面。')); }, timeout);
    helperRequests.set(requestId, { resolve, reject, timer });
    window.postMessage({ source: 'shidan-page-v2', type, requestId, ...data }, location.origin);
  });
}
function helperStatus(r) {
  if (detailError(r)) return '信息不完整';
  if (r.helper) return {pending:'待人工核对',added:'已处理',review:'需人工核对',failed:'加购失败'}[r.helper.status] || '可重新加购';
  return {draft:'待处理',handoff:'已交接',ordered:'已下单'}[r.status] || '待处理';
}
function applyHelperResult(result) {
  if (conflict || !result || !Array.isArray(result.items)) return;
  const batch = state.batches.find(b => b.id === result.id && b.helper);
  if (!batch) return;
  let changed = batch.helperDone !== Boolean(result.done);
  batch.helperDone = Boolean(result.done);
  for (const update of result.items) {
    const row = state.rows.find(r => r.id === update.id && r.batchId === batch.id);
    const original = batch.rows.find(r => r.id === update.id);
    if (!original || !['pending','added','review','failed'].includes(update.status) || !Number.isSafeInteger(update.added) || update.added < 0 || update.added > original.quantity) continue;
    const reason = update.reason || (update.status==='pending' ? (result.phase==='queued'?'商品页已打开，等待上一批完成；可继续选单':'请在商品页核对图片、颜色和尺码；可继续选单') : '');
    const next = {status:update.status,added:update.added,reason:String(reason).slice(0,180)};
    const identityMatches=row && ['sku','size','color','url'].every(key=>(row[key] || '')===(original[key] || ''));
    if(safeProductImage(update.webImage) && update.webImage.startsWith('https://')) {
      if(original.webImage!==update.webImage){original.webImage=update.webImage;changed=true;}
      if(identityMatches && row.webImage!==update.webImage){row.webImage=update.webImage;changed=true;}
    }
    if(validQuote(update.quote)) {
      const quote=update.quote;
      if(JSON.stringify(original.priceQuote)!==JSON.stringify(quote)){original.priceQuote={...quote};changed=true;}
      const sameIdentity=identityMatches;
      if(sameIdentity && (!row.priceReadAt || Date.parse(quote.readAt)>Date.parse(row.priceReadAt))) {
        row.price=quote.price;row.originalPrice=quote.originalPrice ?? '';row.currency=quote.currency;row.priceReadAt=quote.readAt;row.priceSourceUrl=quote.url;changed=true;
      }
    }

    if (JSON.stringify(original.helper)!==JSON.stringify(next)) {original.helper={...next};changed=true;}
    if (row && JSON.stringify(row.helper)!==JSON.stringify(next)) {row.helper=next;changed=true;}
  }
  if (changed) { persist(); renderContent(); renderSide(); }
}
function disconnectedHelper(ids, reason) {
  for(const id of ids){
    const batch=state.batches.find(b=>b.id===id&&b.helper&&!b.helperDone);
    if(!batch)continue;
    applyHelperResult({id,done:true,items:batch.rows.map(original=>{
      const row=state.rows.find(r=>r.id===original.id&&r.batchId===id);
      const prior=row?.helper || original.helper || {status:'pending',added:0};
      return {id:original.id,...prior,...(prior.status==='pending'?{status:'review',reason}: {})};
    })});
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'shidan-extension-v2') return;
    const message = event.data, pending = helperRequests.get(message.requestId);
    if (pending) { clearTimeout(pending.timer); helperRequests.delete(message.requestId); message.error ? pending.reject(Error(message.error)) : pending.resolve(message); }
    if (message.result) applyHelperResult(message.result);
    if (Array.isArray(message.results)) message.results.forEach(applyHelperResult);
    if (Array.isArray(message.missingIds)) disconnectedHelper(message.missingIds, '未找到加购会话，请核对购物车后重新发起');
  });
  const pollHelper = () => {
    const ids = state.batches.filter(b => b.helper && b.status === 'handoff').map(b => b.id);
    if (ids.length) helperRequest('SD_POLL', { ids }).catch(() => disconnectedHelper(ids, '助手未连接，结果未确认；请核对购物车后重试')); 
  };
  window.addEventListener('focus', pollHelper);
  window.addEventListener('pageshow', pollHelper);
  document.addEventListener('visibilitychange', () => {if(!document.hidden)pollHelper();});
  setInterval(() => { if (!document.hidden) pollHelper(); }, 5000);
}
function installHelper() {
  modal('安装 四商家加购助手', h('div', {},
    h('p', {}, '请使用电脑 Chrome。下载并解压安装包，文件夹第一层应包含 manifest.json。'),
    h('p', {}, '打开 chrome://extensions，开启“开发者模式”，点击“加载已解压的扩展程序”，选择解压文件夹。安装或更新后刷新拾单及商家页面。'),
    h('a', {href:'./shidan-helper.zip?v=0.4.0-pricing1',download:'shidan-helper.zip',class:'primary'}, '下载 Chrome 扩展安装包'),
    h('p', {class:'help'}, '已有旧版请移除旧版再加载此版本，避免两个助手同时工作。每件必须人工确认图片、颜色和尺码；仅加购物车，不提交订单、不付款。')
  ), [btn('关闭', () => $('#dialog').close())]);
}
let helperStarting = false;
async function startHelper() {
  if (helperStarting || conflict) return;
  if (mobileCartDevice()) return toast('请在电脑 Chrome 中使用加购助手');
  const rows = selectRows();
  const error = batchCheck(rows, state.settings);
  if (error) return toast(error);
  if (document.querySelector('.settings [aria-invalid=true]')) return toast('请修正顶部设置');
  const epoch = authEpoch;
  helperStarting = true;
  try {
    const hello = await helperRequest('SD_HELLO');
    if (hello.version !== '0.4.0' || hello.pricing !== 'fixed-chain-v1') throw Error('请先更新本次 v0.4.0 加购助手安装包，再刷新拾单页面');
    if (epoch !== authEpoch || conflict) throw Error('工作台已切换，请重新选择商品');
    const current = selectRows();
    const problem = batchCheck(current, state.settings); if (problem) throw Error(problem);
    const batch = { id: uid(), created: new Date().toISOString(), status: 'handoff', helper: true, merchant: state.settings.merchant, rows: structuredClone(current) };
    const payload = batchFile(batch);
    // Persist the batch identity before dispatch, so a reload can recover its results.
    state.batches.unshift(batch);
    for (const row of current) { row.batchId = batch.id; row.helper = {status:'pending',added:0,reason:'正在连接商品页，可继续选择其他明细'}; }
    selected.clear(); persist(); renderContent(); renderSide();
    try {
      const response = await helperRequest('SD_START', {batch:payload}, 20000);
      if (epoch === authEpoch) applyHelperResult(response.result);
      toast('已打开对应商品页，可返回拾单继续选单');
    } catch (error) {
      if (epoch === authEpoch) {
        for (const row of current) row.helper = {status:'failed',added:0,reason:error.message || '助手响应未确认，请核对购物车后重试'};
        batch.helperDone = true;
        for(const original of batch.rows) original.helper={...current.find(r=>r.id===original.id).helper};
        persist(); renderContent(); renderSide();
      }
      throw error;
    }
  } catch (error) { toast(error.message); }
  finally { helperStarting = false; if(epoch===authEpoch)renderSide(); }
}

function batchFile(batch) {
  return {
    format: "shidan-batch-v1",
    id: batch.id,
    created: batch.created,
    merchant: batch.merchant || state.settings.merchant,
    items: batch.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      size: r.size,
      color: r.color,
      image: safeProductImage(r.image) ? r.image : "",
      url: r.url || r.productUrl || r.imageUrl || "",
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
              href: (() => {const m=getMerchant(b.merchant || state.settings.merchant);return m ? m.origin+m.cartPath : state.settings.merchant;})(),
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
        async () => {
          if (!$("#batch-ack").checked) {
            $("#form-error").textContent = "请先确认上面的事项";
            return;
          }
          if (b.helper && !b.helperDone) {
            try { await helperRequest("SD_CANCEL", {id:b.id}); }
            catch (error) { $("#form-error").textContent = "请先在扩展中停止本批，再刷新拾单核对结果。"; return; }
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
                delete r.helper;
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
        "顶部填写商家网址，勾选合计不超过 20 件，点击“开始加购”。同一同步码可共享工作台数据；加购需在安装扩展的电脑 Chrome 中完成。",
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
          "选择解压后含 manifest.json 的文件夹，然后刷新拾单页面。",
        ),
        h(
          "li",
          {},
          "在拾单点击“开始加购”。每件核对图片、颜色和尺码，确认一致后加入购物车。",
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
        "助手仅访问拾单和这四家商店，不读取客户昵称、同步码和账单金额，也不点击结算或付款。",
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
            !productUrl(r.url)
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
      syncMessage = "同步连接未完成，本地数据已保留";
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
    ? "正在连接同步码…"
    : authUser
      ? (offline ? "当前离线 · 已保存本地，联网后同步" : syncMessage) +
        " · 同步码"
      : (offline ? "当前离线 · 仅保存本地" : syncMessage) + " · 同步码";
  
  $("#save-state").setAttribute(
    "aria-label",
    authUser
      ? `同步码工作台：${syncMessage}`
      : "同步码与云端同步",
  );
  if ($("#storage-note"))
    $("#storage-note").textContent = authUser
      ? "同一同步码共用工作台 · 离线修改先保存在此浏览器"
      : "无需登录即可使用 · 点击保存状态设置同步码";
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
  let remaining = 20;
  selected = new Set([...selected].filter(id => {
    const row = state.rows.find(r => r.id === id);
    const quantity = Number(row?.quantity);
    if (!row || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > remaining) return false;
    remaining -= quantity; return true;
  }));
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
  query = "";
  filter = "all";
  page = 1;
  const guest = (await localGet("current")) || emptyWorkspace();
  if (epoch !== authEpoch) return;
  await localPut(
    "sync-code-session",
    user ? { id: user.id } : null,
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

async function bootCloud() {
  if (!db) return;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      const code = await localGet("active-sync-code");
      if (!code) return;
      const api = await loadSyncCode();
      const user = await api.restoreSyncCode(code);
      if (authUser?.id !== user.id) await changeAccount(user);
    } catch {
      syncMessage = "同步连接未完成 · 本地数据已保留，点击重试";
    } finally {
      authLoading = false;
      bootPromise = null;
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
    showSyncCode();
    return;
  }
  const engine = workspaceSync;
  const body = h(
    "div",
    {},
    h("p", {}, "当前已连接同步码工作台"),
    btn("查看 / 复制同步码", () => showSyncCode(true)),
    h("p", { role: "status" }, syncMessage),
    errorBox(),
  );
  const cancel = btn("关闭", () => $("#dialog").close());
  const logout = btn(
    "断开同步码",
    () => {
      modal(
        "断开当前同步码？",
        h(
          "p",
          {},
          "未同步修改保留在此浏览器的同步码副本中。再次输入相同同步码可继续；断开后恢复本机原有工作台。请先复制保存同步码。",
        ),
        [
          btn("取消", () => $("#dialog").close()),
          btn("确认断开", async (event) => {
            event.target.disabled = true;
            authBusy = true;
            try {
              await writeQueue;
              await engine?.queue;
              await signOut();
              if (authUser) await changeAccount(null);
            } catch {
              toast("断开失败，数据已保留，请重试");
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
          ? "当前同步码已有云端数据。使用云端数据不会删除本浏览器原有的本地工作台；断开同步码后仍可查看或导出本地原件。"
          : "发现此浏览器有本地数据。是否迁移到当前同步码，让手机和电脑共用？本地原件仍会保留。",
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
        engine.remote ? null : btn("确认迁移到此同步码", choose(true), "primary"),
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
  modal("同步码与数据同步", body, [
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

async function showSyncCode(reveal = false) {
  const api = await loadSyncCode();
  const existing = reveal ? api.currentSyncCode() : "";
  const input = field("同步码", "sync-code", existing, "text", {autocomplete:"off", spellcheck:"false"});
  const error = errorBox();
  const description = h("p", {}, "无需邮箱。创建同步码后，在另一台设备粘贴同一码即可共享。持有码的人可读写数据，请妥善保管。");
  const body = h("div", {}, description, input, error);
  const close = btn("关闭", () => $("#dialog").close());
  if (reveal) {
    input.querySelector("input").readOnly = true;
    modal("当前同步码", body, [close, btn("复制同步码", async () => {
      try { await navigator.clipboard.writeText(existing); toast("同步码已复制"); }
      catch { input.querySelector("input").select(); error.textContent="请手动复制所选同步码"; }
    }, "primary")]);
    return;
  }
  let busy = false;
  const connect = async (create, button) => {
    if (busy) return;
    busy = true; button.disabled = true; error.textContent = "";
    const value = create ? api.generateSyncCode() : input.querySelector("input").value;
    try {
      await writeQueue;
      const user = await api.connectSyncCode(value, create);
      await localPut("active-sync-code", api.normalizeSyncCode(value));
      await changeAccount(user);
      if (!workspaceSync?.problem) showSyncCode(true);
    } catch (cause) { error.textContent = cause.message || "连接未完成，本地数据已保留"; }
    finally { busy=false; button.disabled=false; }
  };
  modal("同步码", body, [close,
    btn("创建新同步码", event => connect(true,event.currentTarget)),
    btn("连接此同步码", event => connect(false,event.currentTarget), "primary")]);
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
  const area=h('textarea',{id:'chain-text','aria-label':'接龙原文',placeholder:'昵称：小林\n货号：A0DV401090\n尺码：95\n商品链接：https://www.petit-bateau.co.jp/products/a0dv4-bebe-25h81-cardigans\n数量：1'});
  let importing=false;
  const error=errorBox();
  const action=btn('一键导入',async()=>{
    if(importing)return;
    if(conflict||authLoading||!db||(workspaceSync&&!workspaceSync.ready)) {error.textContent='请等待同步完成或刷新后再导入';return;}
    try {
      const result=parseChain(area.value);
      if(state.rows.length+result.rows.length>2000)throw Error('超过 2,000 行，请分批处理');
      if(result.notes.length)throw Error('有未识别的文字，请按固定格式调整：'+result.notes.slice(0,3).join(' / '));
      const max=Math.max(0,...state.rows.map(r=>Number(r.seq)||0));
      const added=result.rows.map(({row},i)=>({...row,seq:max+i+1}));
      importing=true;action.disabled=true;action.setAttribute('aria-busy','true');
      state.rows.push(...added);let failure;persist(e=>{failure=e});await writeQueue;
      if(failure){const ids=new Set(added.map(r=>r.id));state.rows=state.rows.filter(r=>!ids.has(r.id));throw Error('导入未保存，请重试；原文已保留');}
      $('#dialog').close();tab='details';filter='all';query='';page=Math.ceil(state.rows.length/20);renderContent();renderSide();
      const incomplete=added.filter(r=>detailError(r)).length;
      toast(`已导入 ${added.length} 条明细${incomplete?'，其中 '+incomplete+' 条信息不完整，请编辑补齐':''}`);
    }catch(e){error.textContent=e.message;importing=false;action.disabled=false;action.removeAttribute('aria-busy');}
  },'primary');
  modal('粘贴接龙 · 一键导入',h('div',{},h('p',{class:'help'},'每组填写昵称、货号、尺码、商品链接，可用空行分隔。数量未填默认 1；无需填写图片。信息不完整的明细仍会保存，补齐后才能加购。'),area,error),[btn('取消',()=>{if(!importing)$('#dialog').close()}),action]);
  area.focus();
}

// Responsive projections of the same rows. No separate mobile state or calculations.
function mobileRecords(visible, eligible) {
  const all = h("input", {
    type: "checkbox",
    "aria-label": "手机选择本页待处理明细",
    checked: eligible.length > 0 && eligible.every((r) => selected.has(r.id)),
    disabled: !eligible.length || conflict,
    "data-select-page": JSON.stringify(eligible.map(r => r.id)),
    onChange: (e) => selectPageItems(eligible, e.target.checked),
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
    h("label", { class: "mobile-select-all" }, all, "选择本页明细"),
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
          disabled: conflict,
          "data-select-row": r.id,
          title: "选择该条明细，可重新发起一次加购",
          onChange: (e) => selectItems([r], e.target.checked),
        }),
        h("strong", {}, r.customer || "未填客户"),
        h("span", { class: "muted" }, "#" + r.seq),
      ),
      h(
        "span",
        { class: "badge " + r.status, title: r.helper?.reason || "" },
        helperStatus(r),
      ),
    ),
    r.helper?.reason ? h("p", {class:"help"}, r.helper.reason) : null,
    h(
      "div",
      { class: "mobile-product" },
      btn(imageNode(r), () => editRow(r), "image-button", {
        "aria-label": `手机编辑第 ${r.seq} 行明细`,
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
            `${r.price || 0} ${r.currency || "JPY"} × ${a.discount} × ${r.quantity} × ${a.rate} + ${a.shipping} = ${money(a.cny)} 人民币`,
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
