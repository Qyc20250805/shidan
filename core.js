export const MAX_ITEMS = 20;
export const DEFAULTS = {
  merchant: "https://www.petit-bateau.co.jp/",
  discount: 0.7,
  rate: 0.045,
};
export const uid = () => crypto.randomUUID();
export const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export function amounts(row, settings) {
  const discount =
    row.discount === "" || row.discount == null
      ? settings.discount
      : Number(row.discount);
  const rate =
    row.rate === "" || row.rate == null ? settings.rate : Number(row.rate);
  // price remains the persisted key for the current website price, preserving
  // all old workspaces/backups without altering the login/sync transport.
  const base = Number(row.price || 0) * discount * Number(row.quantity || 0);
  const yen = round(base);
  return {
    discount,
    rate,
    yen,
    cny: round(base * rate + Number(row.shipping || 0)),
  };
}
export function newRow(values = {}) {
  return {
    id: uid(),
    seq: "",
    customer: "",
    sku: "",
    name: "",
    size: "",
    color: "",
    image: "",
    url: "",
    quantity: 1,
    shipping: 0,
    price: 0,
    originalPrice: "",
    currency: "JPY",
    discount: "",
    rate: "",
    status: "draft",
    note: "",
    ...values,
  };
}
export function validateRow(r) {
  if (
    r.originalPrice != null &&
    r.originalPrice !== "" &&
    (!Number.isFinite(+r.originalPrice) || +r.originalPrice < 0)
  )
    return "网页原价须为非负数或留空";
  if (r.currency != null && !/^[A-Z]{3}$/.test(r.currency))
    return "币种请填写三位字母代码，例如 JPY、USD";
  if (!r.customer.trim()) return "请填写客户昵称";
  if (!r.sku.trim() && !r.url.trim()) return "请填写货号或商品链接";
  if (!r.size.trim()) return "请填写目标尺码";
  if (!Number.isInteger(+r.quantity) || +r.quantity < 1 || +r.quantity > 20)
    return "数量须为 1–20 的整数";
  for (const k of ["price", "shipping"])
    if (!Number.isFinite(+r[k]) || +r[k] < 0) return "价格和运费不能为负数";
  if (
    r.discount !== "" &&
    (!Number.isFinite(+r.discount) || +r.discount <= 0 || +r.discount > 1)
  )
    return "折扣须大于 0 且不超过 1";
  if (r.rate !== "" && (!Number.isFinite(+r.rate) || +r.rate <= 0))
    return "汇率须大于 0";
  if (r.url && !productUrl(r.url))
    return "商品链接须为 Petit Bateau 日本官网的商品页";
  return "";
}
export function productUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === "www.petit-bateau.co.jp" &&
      u.pathname.startsWith("/products/")
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function batchCheck(rows, settings) {
  if (!rows.length) return "请先勾选明细";
  if (rows.some((r) => r.status !== "draft"))
    return "已交接或已下单的明细不能重复推送";
  if (rows.reduce((n, r) => n + Number(r.quantity), 0) > MAX_ITEMS)
    return "本批超过 20 件，请调整数量或取消勾选";
  if (
    !Number.isFinite(+settings.discount) ||
    +settings.discount <= 0 ||
    +settings.discount > 1 ||
    !Number.isFinite(+settings.rate) ||
    +settings.rate <= 0
  )
    return "请修正顶部折扣和汇率";
  try {
    if (new URL(settings.merchant).hostname !== "www.petit-bateau.co.jp")
      return "当前助手仅适配 Petit Bateau 日本官网";
  } catch {
    return "请填写有效的商家网址";
  }
  for (const row of rows) {
    const error = validateRow(row);
    if (error) return `第 ${row.seq} 行：${error}`;
  }
  return "";
}
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function parseDelimited(text) {
  const delimiter = text.split("\n")[0].includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("引号未闭合，请检查导入内容");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}
export function importRows(text) {
  const data = parseDelimited(text);
  if (data.length < 2) throw Error("请包含标题行和至少一行商品");
  const names = {
    序号: "seq",
    客户: "customer",
    昵称: "customer",
    客户昵称: "customer",
    型号: "sku",
    货号: "sku",
    类型: "name",
    商品名称: "name",
    名称: "name",
    尺码: "size",
    尺寸: "size",
    颜色: "color",
    数量: "quantity",
    运费: "shipping",
    原价: "originalPrice",
    网页原价: "originalPrice",
    网页当前售价: "price",
    计价基础: "price",
    币种: "currency",
    核算折扣: "discount",
    计价基数: "price",
    折扣: "discount",
    汇率: "rate",
    商品链接: "url",
    图片: "image",
  };
  const headers = data.shift().map((x) => names[x.trim()]);
  if (!headers.includes("sku") && !headers.includes("url"))
    throw Error("标题行需要“货号”“型号”或“商品链接”");
  return data
    .filter((r) => !r.some((v) => /汇总|合计/.test(v)))
    .map((cells) => {
      const r = newRow();
      headers.forEach((key, i) => {
        if (!key) return;
        const v = (cells[i] || "").trim();
        if (
          [
            "quantity",
            "shipping",
            "price",
            "originalPrice",
            "discount",
            "rate",
          ].includes(key)
        ) {
          r[key] =
            v === ""
              ? key === "quantity"
                ? 1
                : ["discount", "rate", "originalPrice"].includes(key)
                  ? ""
                  : 0
              : Number(v.replaceAll(",", ""));
        } else r[key] = key === "currency" ? v.toUpperCase() || "JPY" : v;
      });
      if (r.image && !/^https:\/\//.test(r.image)) r.image = "";
      return r;
    });
}
