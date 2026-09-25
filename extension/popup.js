const status = document.querySelector('#status');
const list = document.querySelector('#list');
const refresh = document.querySelector('#refresh');
async function readSelection() {
  refresh.disabled = true;
  list.replaceChildren();
  status.textContent = '正在读取拾单勾选商品…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('请先打开拾单下单表。');
    let result;
    try { result = await chrome.tabs.sendMessage(tab.id, { type: 'SHIDAN_SELECTION' }); }
    catch { throw new Error('请打开 GitHub Pages 拾单下单表；安装扩展后请刷新该页面。'); }
    if (result?.error) throw new Error(result.error);
    if (!Array.isArray(result?.rows)) throw new Error('未能读取勾选商品，请刷新拾单后重试。');
    const rows = result.rows;
    status.textContent = rows.length ? `已勾选 ${rows.length} 条，共 ${rows.reduce((n,r)=>n+r.quantity,0)} 件` : '尚未勾选商品，请在拾单下单表中勾选。';
    for (const row of rows) {
      const item = document.createElement('article');
      for (const text of [`货号：${row.sku || '未填写'}`, `尺码：${row.size || '未填写'}`, `数量：${row.quantity}`]) {
        const p = document.createElement('p'); p.textContent = text; item.append(p);
      }
      if (/^https?:\/\//.test(row.url)) {
        const a = document.createElement('a'); a.href = row.url; a.textContent = row.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; item.append(a);
      } else { const p = document.createElement('p'); p.textContent = '商品链接：未填写'; item.append(p); }
      list.append(item);
    }
  } catch (error) { status.textContent = error.message; }
  finally { refresh.disabled = false; }
}
refresh.addEventListener('click', readSelection);
readSelection();
