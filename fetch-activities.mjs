#!/usr/bin/env node
/**
 * 洛克王国工具箱 —— 活动数据发布器
 *
 * 在 GitHub Actions（或本地 Node 18+）里运行：带微信小程序 Referer 抓取活动接口，
 * 过滤成精简 JSON 写入 activities.json，供页面经 jsDelivr 匿名读取。
 * 接口无需任何密钥，仅校验 Referer，故仓库不存任何 Secret。
 *
 * 本地：node fetch-activities.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://v0ptib2vax.sealosbja.site/get_activities';
const REFERER = 'https://servicewechat.com/wx38b0bed275763e1b/131/page-frame.html';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI ' +
  'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541f38) XWEB/25799';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'activities.json');

function pet(p, kind) {
  return {
    name: String(p.name || '').trim(),
    id: String(p._id || ''),
    img: String((kind === 'pet' ? p.main_url : p.icon_url) || ''),
  };
}

function mergeProps(a) {
  const seen = new Set();
  const out = [];
  for (const p of [...(a.get_props || []), ...(a.get_extra_props || [])]) {
    const name = String(p.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(pet(p, 'prop'));
  }
  return out;
}

async function main() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  let json;
  try {
    const res = await fetch(API, {
      headers: { 'content-type': 'application/json', referer: REFERER, 'user-agent': UA, accept: '*/*' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(t);
  }
  if (!json || json.success !== true || !json.data || !Array.isArray(json.data.otherActivities)) {
    throw new Error('接口返回异常：' + JSON.stringify(json).slice(0, 200));
  }

  const activities = json.data.otherActivities
    .filter((a) => a && a.name)
    .map((a) => ({
      name: String(a.name).trim(),
      start: String(a.start_date || '').slice(0, 10),
      end: a.end_time ? Math.floor(a.end_time / 1000) : 0,
      pets: (a.get_pets || []).filter((p) => p && p.name).map((p) => pet(p, 'pet')),
      props: mergeProps(a),
    }));

  const payload = { ok: true, ts: Date.now(), activities };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`✔ 写入 ${activities.length} 个活动 → activities.json`);
}

main().catch((e) => {
  console.error('✘ 抓取失败：', e.message);
  process.exit(1);
});