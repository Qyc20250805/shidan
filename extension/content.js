(() => {
  const selected = new Map();
  function collect() {
    for (const card of document.querySelectorAll('[data-mobile-row]')) {
      const id = card.dataset.mobileRow;
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (!checkbox?.checked) { selected.delete(id); continue; }
      const facts = [...card.querySelectorAll('dl > div')];
      const sku = facts.find(n => n.querySelector('dt')?.textContent === '货号')?.querySelector('dd')?.textContent;
      // Billing cards do not expose all product fields. Retain the order snapshot.
      if (sku === undefined) continue;
      const quantity = Number(card.querySelector('input[aria-label$=" 数量"]')?.value);
      const link = card.querySelector('a.inline-link')?.href || '';
      selected.set(id, {
        sku: sku === '未填写' ? '' : sku,
        size: card.querySelector('input[aria-label$=" 尺码"]')?.value || '',
        url: /^https?:\/\//.test(link) ? link : '',
        quantity: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0
      });
    }
    const count = document.querySelector('aside')?.textContent.match(/已选\s*(\d+)\s*条明细/);
    if (count && Number(count[1]) === 0) selected.clear();
    return count ? Number(count[1]) : null;
  }
  new MutationObserver(collect).observe(document.querySelector('#app') || document.body, {
    subtree: true, childList: true, characterData: true, attributes: true
  });
  document.addEventListener('change', () => queueMicrotask(collect));
  collect();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'SHIDAN_SELECTION') return;
    const count = collect();
    if (count === null || count !== selected.size) {
      reply({ error: '请回到下单表。若安装前已跨页勾选，请刷新拾单后重新勾选，确保清单完整。' });
      return;
    }
    reply({ rows: [...selected.values()] });
  });
})();
