// Independent data layer. No UI, persistence, network or browser-extension code.
import { uid, round } from "./core.js";

export const BILL_DEFAULTS = Object.freeze({ discount: 1, jpyToCny: 0.045 });

export function newOrder(values = {}) {
  return {
    id: uid(),
    customer: "",
    image: "",
    url: "",
    name: "",
    sku: "",
    color: "",
    size: "",
    quantity: 1,
    originalPrice: null,
    webPrice: null,
    currency: "JPY",
    priceReadAt: null,
    cartStatus: "pending",
    note: "",
    ...values,
  };
}

export function newLedger() {
  return { version: 2, orders: [], bills: [] };
}

function validateQuote({ originalPrice, webPrice, currency, priceReadAt }) {
  if (
    typeof webPrice !== "number" ||
    !Number.isFinite(webPrice) ||
    webPrice < 0
  )
    throw Error("网站当前售价须为非负数");
  if (
    originalPrice !== null &&
    (typeof originalPrice !== "number" ||
      !Number.isFinite(originalPrice) ||
      originalPrice < 0)
  )
    throw Error("网站原价须为非负数或空值");
  if (!/^[A-Z]{3}$/.test(currency)) throw Error("币种须为三位大写字母代码");
  if (
    priceReadAt !== null &&
    (typeof priceReadAt !== "string" ||
      !Number.isFinite(Date.parse(priceReadAt)))
  )
    throw Error("价格读取时间无效");
}

// Returns a new order only; never modifies an existing bill.
export function updateOrderPrice(order, quote) {
  const next = {
    ...order,
    originalPrice: quote.originalPrice ?? null,
    webPrice: quote.webPrice,
    currency: quote.currency ?? order.currency,
    priceReadAt: quote.priceReadAt ?? new Date().toISOString(),
  };
  validateQuote(next);
  return next;
}

export function validateBill(bill) {
  if (!bill.orderId || !bill.customer?.trim())
    throw Error("缺少关联下单记录或客户昵称");
  if (!Number.isInteger(bill.quantity) || bill.quantity < 1)
    throw Error("数量须为正整数");
  if (!/^[A-Z]{3}$/.test(bill.currency)) throw Error("币种无效");
  if (!Number.isFinite(bill.basePrice) || bill.basePrice < 0)
    throw Error("计价基础须为非负数");
  if (
    !Number.isFinite(bill.discount) ||
    bill.discount <= 0 ||
    bill.discount > 1
  )
    throw Error("核算折扣须大于 0 且不超过 1");
  if (!Number.isFinite(bill.rate) || bill.rate <= 0)
    throw Error("请提供此币种兑换人民币的汇率");
  if (!Number.isFinite(bill.shipping) || bill.shipping < 0)
    throw Error("行运费须为非负数");
  if (!["draft", "confirmed", "paid"].includes(bill.status))
    throw Error("账单状态无效");
  const total =
    bill.basePrice * bill.discount * bill.quantity * bill.rate + bill.shipping;
  if (
    !Number.isFinite(total) ||
    Math.abs(total) > Number.MAX_SAFE_INTEGER / 100
  )
    throw Error("应收金额超出可计算范围");
}

export function billAmount(bill) {
  validateBill(bill);
  // Freight is a row total, added once. Round only the final CNY amount.
  return round(
    bill.basePrice * bill.discount * bill.quantity * bill.rate + bill.shipping,
  );
}

export function createBill(order, options = {}) {
  validateQuote(order);
  const bill = {
    id: uid(),
    orderId: order.id,
    customer: order.customer,
    product: {
      name: order.name,
      sku: order.sku,
      color: order.color,
      size: order.size,
    },
    quantity: order.quantity,
    basePrice: order.webPrice,
    currency: order.currency,
    discount: options.discount ?? BILL_DEFAULTS.discount,
    rate:
      options.rate ??
      (order.currency === "JPY" ? BILL_DEFAULTS.jpyToCny : null),
    shipping: options.shipping ?? 0,
    priceReadAt: order.priceReadAt,
    status: "draft",
  };
  validateBill(bill);
  return bill;
}

export function generateBill(ledger, orderId, options = {}) {
  if (ledger.bills.some((bill) => bill.orderId === orderId))
    throw Error("该下单明细已关联账单");
  const order = ledger.orders.find((row) => row.id === orderId);
  if (!order) throw Error("关联下单明细不存在");
  return { ...ledger, bills: [...ledger.bills, createBill(order, options)] };
}

export function priceChanged(bill, order) {
  return (
    bill.orderId === order.id &&
    (bill.basePrice !== order.webPrice || bill.currency !== order.currency)
  );
}

// Call only after the caller explicitly confirms the new basis.
// This module has no automatic synchronization side effects.
export function syncBillPrice(bill, order, rateForNewCurrency) {
  if (bill.orderId !== order.id) throw Error("账单与下单记录不匹配");
  validateQuote(order);
  const next = {
    ...bill,
    basePrice: order.webPrice,
    currency: order.currency,
    priceReadAt: order.priceReadAt,
    rate: bill.currency === order.currency ? bill.rate : rateForNewCurrency,
  };
  validateBill(next);
  return next;
}
