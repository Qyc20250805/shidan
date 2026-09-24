import { newRow } from "./core.js";
export function parseChain(text) {
  const shared = { sku: "", name: "", size: "", url: "" },
    rows = [],
    notes = [];
  const lines = text
    .normalize("NFKC")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const line of lines) {
    const numbered = line.match(/^(\d+)[.、)\s]\s*(.+)$/);
    if (!numbered) {
      const field = line.match(
        /^(?:统一)?(货号|型号|商品|名称|尺码|商品链接)\s*[:：]\s*(.+)$/,
      );
      if (field) {
        const key = {
          货号: "sku",
          型号: "sku",
          商品: "name",
          名称: "name",
          尺码: "size",
          商品链接: "url",
        }[field[1]];
        shared[key] = field[2].trim();
      } else notes.push(line);
      continue;
    }
    const original = numbered[2],
      codes = [...original.matchAll(/\b[A-Z][A-Z0-9]{4,14}\b/gi)].filter(
        (x) => /\d/.test(x[0]) && /[A-Z]/i.test(x[0]),
      );
    const sizes = [
      ...original.matchAll(
        /(?:^|[\s,，;；])(?:尺码\s*[:：]?\s*)?(\d{2,3})\s*(?:cm|码)(?=$|[\s,，;；x×*])/gi,
      ),
    ];
    let size = sizes.length === 1 ? sizes[0][1] : "";
    const quantities = [
      ...original.matchAll(
        /(?:[x×*]\s*(\d+)(?:\s*件)?|(?:数量\s*[:：]?\s*)?(\d+)\s*件)/gi,
      ),
    ];
    let quantity =
      quantities.length === 1
        ? Number(quantities[0][1] || quantities[0][2])
        : 1;
    let rest = original;
    for (const c of codes) rest = rest.replace(c[0], " ");
    for (const m of sizes) rest = rest.replace(m[0], " ");
    for (const m of quantities) rest = rest.replace(m[0], " ");
    // Bare size is accepted only as a separate trailing token, never inside a nickname.
    if (!size && !sizes.length) {
      const bare = rest.trim().match(/(?:^|\s)(\d{2,3})$/);
      if (bare) {
        size = bare[1];
        rest = rest.trim().slice(0, bare.index);
      }
    }
    rest = rest
      .replace(/(?:货号|型号|尺码|数量)\s*[:：]?/g, " ")
      .replace(/[,，;；]/g, " ")
      .trim();
    const parts = rest.split(/\s+/);
    const customer = parts.shift() || "";
    const row = newRow({
      seq: numbered[1],
      customer,
      sku: codes.length === 1 ? codes[0][0].toUpperCase() : shared.sku,
      name: parts.join(" ") || shared.name,
      size: size || shared.size.replace(/\s*(cm|码)$/i, ""),
      quantity,
      url: shared.url,
      note: original,
    });
    const issues = [];
    if (codes.length > 1) {
      row.sku = "";
      issues.push("多个货号，请拆成多行");
    }
    if (sizes.length > 1) {
      row.size = "";
      issues.push("多个尺码，请拆成多行");
    }
    if (quantities.length > 1) {
      row.quantity = 0;
      issues.push("多个数量，请确认");
    }
    if (!row.customer) issues.push("缺少昵称");
    if (!row.sku && !row.url) issues.push("缺少货号或商品链接");
    if (!row.size) issues.push("缺少尺码");
    if (!quantities.length) issues.push("数量默认 1 件，请核对");
    rows.push({ row, issues });
  }
  if (!rows.length)
    throw Error("没有识别到接龙行。每行请以“1. 昵称 …”或“1、昵称 …”开头。");
  return { rows, notes };
}
