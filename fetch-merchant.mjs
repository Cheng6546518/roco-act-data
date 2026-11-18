#!/usr/bin/env node
/**
 * 远行商人数据镜像：服务端抓 onebiji 实时页并解析成结构化 merchant.json；
 * onebiji 失败时回退蛇瞳 qds 缓存。由 GitHub Actions 定时提交，页面经 jsDelivr 匿名读取。
 */
import fs from 'node:fs';

const ONEBIJI = 'https://www.onebiji.com/hykb_tools/comm/lkwgmerchant/preview.php?id=1&immgj=0';
const QDS = 'https://cdn.jsdelivr.net/gh/qi-du-shang/qi-du-shang.github.io@main/data.json';
const REFRESH_HOURS = [0, 8, 12, 16, 20]; // 北京时间整点刷新
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function get(url, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA, Referer: 'https://www.onebiji.com/' } });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function parseOnebijiHtml(html) {
  const extractAttr = (a, n) => { const m = new RegExp(n + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(a); return m ? m[1] : ''; };
  const txt = (b, ps) => { for (const p of ps) { const m = p.exec(b); if (m && m[1]) return m[1].replace(/\s+/g, ''); } return ''; };
  const pi = s => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : undefined; };
  const curIdx = pi(/var\s+index\s*=\s*(\d+)/i.exec(html)?.[1]) || 1;
  const allSecs = [...html.matchAll(/<ul[^>]*class=["'][^"']*shop-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi)].map(m => m[1]);
  const blocks = allSecs.length ? allSecs : [html];
  const items = [];
  for (const block of blocks) {
    for (const m of block.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
      const attrs = m[1] || '', b = m[2] || '';
      const cls = extractAttr(attrs, 'class');
      if ((cls || '').includes('show_none_tip')) continue;
      const style = extractAttr(attrs, 'style').replace(/\s+/g, '').toLowerCase();
      if (style.includes('display:none')) continue;
      const raw = [...cls.matchAll(/\bshow_(\d+)\b/g)].map(x => +x[1]);
      const slotIdx = raw.length ? raw : [curIdx];
      const name = txt(b, [
        /<em[^>]*class=["'][^"']*shop_name[^"']*["'][^>]*>([\s\S]*?)<\/em>/i,
        /<p[^>]*>\s*<em[^>]*>([\s\S]*?)<\/em>\s*<\/p>/i
      ]);
      if (!name) continue;
      let price = txt(b, [
        /<em[^>]*class=["'][^"']*shop_price[^"']*["'][^>]*>([\s\S]*?)<\/em>/i,
        /(价格[:：]\s*[\d.,]+(?:w|W|万)?)/i
      ]).replace(/^价格[:：]/, '');
      const limit = txt(b, [
        /<div[^>]*class=["'][^"']*gitem[^"']*["'][^>]*>[\s\S]*?<em>([\s\S]*?)<\/em>/i,
        /(限购\s*\d+)/
      ]).replace(/^限购\s*/, '');
      let icon = (/<img[^>]+src=["']([^"']+?)["']/i.exec(b) || [])[1] || '';
      if (icon && icon.indexOf('//') === 0) icon = 'https:' + icon;
      items.push({ name, price, limit, icon, slotIdx });
    }
  }
  const cur = items.filter(i => (i.slotIdx || []).includes(curIdx));
  const final = cur.length ? cur : items;
  const tl = [...html.matchAll(/<ul[^>]*class=["'][^"']*time-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi)].map(m => m[1]).join('\n');
  const tms = [...tl.matchAll(/>\s*(\d{1,2}[:：]\d{2})/g)].map(x => x[1]);
  const label = tms.length >= 2 ? tms[0] + '-' + tms[1] : '';
  return { round: curIdx, roundLabel: label, items: final.map(({ slotIdx, ...rest }) => rest) };
}

/* 下一个刷新整点（北京时间）的时间戳 */
function nextRefreshTs(now = new Date()) {
  const b = new Date(now.getTime() + 8 * 3600e3);
  const h = b.getUTCHours();
  const next = REFRESH_HOURS.find(x => x > h);
  if (next !== undefined) return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), next - 8);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + 1, -8); // 次日 00:00 北京
}

async function fromQds() {
  const d = JSON.parse(await get(QDS));
  const items = (d.items || []).map(it => ({
    name: it.name || '', price: it.price != null ? String(it.price) : '—',
    limit: it.limit != null ? String(it.limit) : '', icon: it.image || ''
  })).filter(it => it.name);
  if (!items.length) throw new Error('qds empty');
  let expire = 0;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(d.nextRefreshBeijing || '');
  if (m) expire = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
  return { source: 'qds', round: Number(d.round) || null, roundLabel: '', expire: expire || nextRefreshTs(), items };
}

const out = { ok: false, fetchedAt: new Date().toISOString() };
try {
  const html = await get(ONEBIJI);
  const p = parseOnebijiHtml(html);
  if (!p.items.length) throw new Error('onebiji parse empty');
  Object.assign(out, { ok: true, source: 'onebiji', round: p.round, roundLabel: p.roundLabel, expire: nextRefreshTs(), items: p.items });
} catch (e) {
  console.error('onebiji failed:', e.message);
  try { Object.assign(out, await fromQds(), { ok: true }); }
  catch (e2) { console.error('qds failed:', e2.message); }
}
const b = new Date(Date.now() + 8 * 3600e3);
out.open = b.getUTCHours() >= 8; // 商人 08:00–24:00 现身
fs.writeFileSync(new URL('./merchant.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('merchant.json:', out.ok ? `ok source=${out.source} round=${out.round} items=${out.items.length} open=${out.open}` : 'FAILED');
if (!out.ok) process.exit(1);