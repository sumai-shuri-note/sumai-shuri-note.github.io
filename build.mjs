#!/usr/bin/env node
// 住まいの修理ノート — ビルド。src/content の Markdown を dist/ の HTML にする。
// 使う物は npm の marked と gray-matter だけ。ネットワークは使わない。
//
//   SITE_URL=https://example.org/ node build.mjs
//
// 原則（リポジトリの憲法に合わせる）:
//   - fail-closed: 必須の項目が無い原稿・知らないリンク札・禁止語は、警告ではなく失敗にする。
//   - 冪等: 同じ原稿から同じ dist/ が出る（ビルド時刻を埋め込まない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { marked } from 'marked';
import { findForbidden } from './lib/forbidden.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'site.config.json'),
  links: path.join(ROOT, 'links.json'),
  assets: path.join(ROOT, 'src', 'assets'),
  articles: path.join(ROOT, 'src', 'content', 'articles'),
  pages: path.join(ROOT, 'src', 'content', 'pages'),
  dist: path.join(ROOT, 'dist'),
};

export const DEFAULT_SITE_URL = 'https://sumai-shuri-note.pages.dev/';

// 記事の型（二択）。この見出しが、この順で必ず要る。
export const REQUIRED_HEADINGS = ['自分でやるなら、この道具', '頼むなら、ここ', '現場の一言'];
const SECTION_CLASS = {
  '自分でやるなら、この道具': { cls: 'choice choice-diy', id: 'sec-diy' },
  '頼むなら、ここ': { cls: 'choice choice-hire', id: 'sec-hire' },
  '現場の一言': { cls: 'hitokoto', id: 'sec-hitokoto' },
};

marked.use({ gfm: true, breaks: false });

// ---------- 小さな道具 ----------

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeXml(s) {
  return escapeHtml(s);
}

export function normalizeSiteUrl(raw) {
  const v = (raw && String(raw).trim()) || DEFAULT_SITE_URL;
  if (!/^https?:\/\/[^\s]+$/.test(v)) {
    throw new Error(`SITE_URL が URL になっていません: ${v}`);
  }
  return v.endsWith('/') ? v : v + '/';
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

// front matter の日付は、YAML が Date に変えてしまう事がある（`date: 2026-11-01` は Date になる）。
// どちらで書かれても YYYY-MM-DD の文字列にそろえる。
export function toIsoDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return v == null ? '' : String(v).trim();
}

export function formatDateJa(iso) {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return `${y}年${m}月${d}日`;
}

export function toRfc822(iso) {
  // 日本時間の 0 時として扱う（記事の公開日は日付だけを持つ）。
  return new Date(`${iso}T00:00:00+09:00`).toUTCString();
}

export function jsonLd(obj) {
  // </script> を本文に書かれても壊れないように < を逃がす。
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 文字数（空白を除く）。記事の長さの目安に使う。
export function countChars(text) {
  return Array.from(text.replace(/\s+/g, '')).length;
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadConfig() {
  const c = loadJson(PATHS.config);
  for (const k of ['siteName', 'description', 'author', 'prBanner', 'priceNote', 'linkPendingText']) {
    if (c[k] == null || c[k] === '') throw new Error(`site.config.json に ${k} がありません`);
  }
  if (!c.author.line || !c.author.name || !c.author.path) {
    throw new Error('site.config.json の author は name / line / path の3つが要ります');
  }
  return c;
}

export function loadLinks(file = PATHS.links) {
  const links = loadJson(file);
  for (const [slug, v] of Object.entries(links)) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`links.json の札「${slug}」は英小文字・数字・ハイフンだけにしてください`);
    if (!v || typeof v !== 'object' || !v.label) throw new Error(`links.json の札「${slug}」に label がありません`);
    if (!['物販', '業者紹介'].includes(v.kind)) throw new Error(`links.json の札「${slug}」の kind は 物販 か 業者紹介 です`);
    if (v.url && !/^https?:\/\//.test(v.url)) throw new Error(`links.json の札「${slug}」の url が http(s) で始まっていません`);
  }
  return links;
}

// ---------- 札（placeholder）の置き換え ----------

// [[link:札]] → 計測つきリンク。url が空なら「（リンク準備中）」の文字。
export function renderLink(slug, links, config) {
  const entry = links[slug];
  if (!entry) throw new Error(`links.json に無い札です: [[link:${slug}]]`);
  const label = escapeHtml(entry.label);
  if (entry.url) {
    return `<a href="${escapeHtml(entry.url)}" rel="sponsored nofollow noopener" target="_blank">${label}</a><small class="ad-mark">［広告］</small>${entry.pixel ? `<img src="${escapeHtml(entry.pixel)}" width="1" height="1" alt="" class="ad-px">` : ''}`;
  }
  return `<span class="link-pending" data-link="${escapeHtml(slug)}">${label}<small>${escapeHtml(config.linkPendingText)}</small></span>`;
}

// [[photo:説明]] → 写真の枠（準備中）。[[photo:説明|assets/img/x.jpg]] → 画像。
export function renderPhoto(spec) {
  const [captionRaw, srcRaw] = spec.split('|').map((s) => s.trim());
  const caption = escapeHtml(captionRaw || '');
  if (srcRaw) {
    if (!/^assets\/[A-Za-z0-9_./-]+$/.test(srcRaw)) {
      throw new Error(`写真の置き場は assets/ の下だけです: [[photo:${spec}]]`);
    }
    return `<figure><img src="${escapeHtml(srcRaw)}" alt="${caption}" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
  }
  return `<figure class="photo-pending"><div class="photo-box">写真の枠（準備中）</div><figcaption>${caption}</figcaption></figure>`;
}

// [[site:articles/xxx/]] → サイトの URL + その道。サイト内リンクを置き場に依らず書くため。
export function renderSiteUrl(p, siteUrl) {
  const rel = (p || '').trim();
  if (/^[a-z]+:/i.test(rel) || rel.startsWith('/') || rel.includes('..')) {
    throw new Error(`[[site:...]] にはサイト内の相対の道だけを書きます: [[site:${p}]]`);
  }
  return siteUrl + rel;
}


// [[desk:general]] / [[desk:pest]] → 地域の相談窓口（運営元の施工チーム）。対象地域だけを書き、運営元との関係を明示する。
let siteUrlForDesk = '';
export function renderDesk(kind, config) {
  const d = config.localDesk;
  if (!d || !d.url) throw new Error('site.config.json に localDesk.url がありません');
  const k = d[kind];
  if (!k) throw new Error(`[[desk:${kind}]] は general か pest です`);
  if (!/^https:\/\//.test(d.url)) throw new Error('localDesk.url は https で始めてください');
  return `<aside class="local-desk"><p class="local-desk-title"><strong>${escapeHtml(d.offerTitle)}</strong></p>`
    + `<p class="local-desk-area">${escapeHtml(k.area)}の方（${escapeHtml(k.areaNote)}）</p>`
    + `<p>${escapeHtml(d.offer)}</p><p>${escapeHtml(d.who)}がお答えします。記事を書いている編集部と同じ運営元です。</p>`
    + `<p><a class="local-desk-button" href="${escapeHtml(d.url)}" rel="noopener" target="_blank">${escapeHtml(d.button)}</a></p>`
    + `<p class="local-desk-reply">${escapeHtml(d.reply)}</p>`
    + (d.nearArea ? `<p class="local-desk-near"><strong>${escapeHtml(d.nearArea)}</strong>：${escapeHtml(d.nearLine)}</p>` : '')
    + renderDeskExtras(d, siteUrlForDesk)
    + `<p class="local-desk-monitor">${escapeHtml(d.monitor)}</p>`
    + `<p class="local-desk-outside">${escapeHtml(d.outside)}</p></aside>`;
}

function renderDeskExtras(d, siteUrl) {
  let out = '';
  if (d.chat && d.chat.length) {
    out += `<details class="desk-more"><summary>${escapeHtml(d.chatTitle)}</summary><div class="chat">`
      + d.chat.map((m) => `<p class="bubble ${m.who === 'you' ? 'you' : 'pro'}"><span class="who">${m.who === 'you' ? 'あなた' : '施工チーム'}</span>${escapeHtml(m.text)}</p>`).join('')
      + `</div><p class="small">${escapeHtml(d.chatNote)}</p></details>`;
  }
  if (d.prices && d.prices.length) {
    out += `<details class="desk-more"><summary>${escapeHtml(d.priceTitle)}</summary><table class="price-table"><thead><tr><th>困りごと</th><th>費用の目安</th></tr></thead><tbody>`
      + d.prices.map((p) => `<tr><td><a href="${escapeHtml(siteUrl + p.path)}">${escapeHtml(p.trouble)}</a></td><td>${escapeHtml(p.range)}</td></tr>`).join('')
      + `</tbody></table><p class="small">${escapeHtml(d.priceNote)}</p></details>`;
  }
  if (d.cases && d.cases.length) {
    out += `<div class="cases"><p><strong>${escapeHtml(d.casesTitle)}</strong></p><ul>`
      + d.cases.map((k) => `<li><strong>${escapeHtml(k.area || '')}</strong> ${escapeHtml(k.trouble)} → ${escapeHtml(k.work)}（${escapeHtml(k.days)}）</li>`).join('')
      + `</ul></div>`;
  }
  return out;
}

// 地域外の方への比較枠（ASP の業者紹介。URL は links.json の1行で差し替わる）。
export function renderOutside(cluster, links, config) {
  const o = config.outsideCompare;
  if (!o) return '';
  const key = Object.keys(o.byCluster).find((k) => String(cluster).includes(k));
  if (!key) return '';
  const slugs = o.byCluster[key];
  const cmp = slugs.filter((s) => links[s] && links[s].url && links[s].compare).sort((a, b) => links[a].compare.rank - links[b].compare.rank);
  const rest = slugs.filter((s) => !cmp.includes(s));
  const nudge = o.nudge && o.nudge[key] ? `<p class="oc-nudge">${escapeHtml(o.nudge[key])}</p>` : '';
  let table = '';
  if (cmp.length) {
    const rows = cmp.map((s, i) => {
      const e = links[s]; const c = e.compare;
      const px = e.pixel ? `<img src="${escapeHtml(e.pixel)}" width="1" height="1" alt="" class="ad-px">` : '';
      return `<tr${i === 0 ? ' class="oc-top"' : ''}><th scope="row">${escapeHtml(c.name)}<small class="ad-mark">［広告］</small></th><td data-l="受付">${escapeHtml(c.speed)}</td><td data-l="無料の範囲">${escapeHtml(c.free)}</td><td data-l="保証">${escapeHtml(c.warranty)}</td><td><a class="oc-btn" href="${escapeHtml(e.url)}" rel="sponsored nofollow noopener" target="_blank">${escapeHtml(c.cta)}</a>${px}</td></tr>`;
    }).join('');
    table = `<table class="oc-table"><thead><tr><th>サービス</th><th>受付</th><th>無料の範囲</th><th>保証</th><th></th></tr></thead><tbody>${rows}</tbody></table><p class="small">${escapeHtml(o.tableNote || '')}</p>`;
  }
  const items = rest.map((slug) => `<li>${renderLink(slug, links, config)}</li>`).join('');
  return `<aside class="outside-compare"><h2>${escapeHtml(o.title)}</h2><p>${escapeHtml(o.lead)}</p>${nudge}${table}${items ? `<ul>${items}</ul>` : ''}</aside>`;
}

const ICON_DIR = path.join(ROOT, 'node_modules', 'lucide-static', 'icons');
function icon(name) { const f = path.join(ICON_DIR, `${name}.svg`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace('<svg', '<svg class="ui-ic" aria-hidden="true"') : ''; }
// [[steps]] 相談の流れ（3段）・[[pricecards]] 費用の目安カード
export function renderSteps() {
  const st = [['camera', '写真を撮る', '困っている所を、スマホで2〜3枚'], ['message-circle', 'LINEで送る', '地域と困りごとを一言そえて'], ['clipboard-check', '目安と応急処置が届く', '費用の幅と、今すぐできる事を無料で']];
  return `<ol class="ui-steps">${st.map(([ic, h, p], i) => `<li><span class="ui-num">${i + 1}</span>${icon(ic)}<strong>${h}</strong><span>${p}</span></li>`).join('')}</ol>`;
}
export function renderPriceCards(config, siteUrl) {
  const ps = (config.localDesk && config.localDesk.prices) || [];
  return `<div class="ui-prices">${ps.map((p) => `<a class="ui-price" href="${escapeHtml(siteUrl + p.path)}"><span class="ui-price-t">${escapeHtml(p.trouble)}</span><span class="ui-price-v">${escapeHtml(p.range)}</span></a>`).join('')}</div><p class="small">${escapeHtml(config.localDesk.priceNote)}</p>`;
}

// 全記事とトップの下に置く信頼の枠（会社名は出さない）。
export function renderTrust(config) {
  const t = config.trust;
  if (!t) return '';
  return `<aside class="trust-box"><h2>${escapeHtml(t.title)}</h2><ul>${t.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></aside>`;
}

export function renderPlaceholders(html, links, config, siteUrl) {
  siteUrlForDesk = siteUrl;
  let out = html;
  // 段落に写真の札だけがある時は、段落ごと差し替える。
  out = out.replace(/<p>\s*\[\[photo:([^\]]*)\]\]\s*<\/p>/g, (_, spec) => renderPhoto(spec));
  out = out.replace(/\[\[photo:([^\]]*)\]\]/g, (_, spec) => renderPhoto(spec));
  out = out.replace(/<p>\s*\[\[steps\]\]\s*<\/p>/g, () => renderSteps());
  out = out.replace(/<p>\s*\[\[pricecards\]\]\s*<\/p>/g, () => renderPriceCards(config, siteUrl));
  out = out.replace(/<p>\s*\[\[desk:([a-z]+)\]\]\s*<\/p>/g, (_, k) => renderDesk(k, config));
  out = out.replace(/\[\[desk:([a-z]+)\]\]/g, (_, k) => renderDesk(k, config));
  out = out.replace(/\[\[link:([a-z0-9-]+)\]\]/g, (_, slug) => renderLink(slug, links, config));
  out = out.replace(/\[\[site:([^\]]*)\]\]/g, (_, p) => escapeHtml(renderSiteUrl(p, siteUrl)));
  // Markdown のリンク先 `[文](  [[site:xxx]]  )` に書くと marked が [ ] を %5B %5D にするので、その形も受ける。
  out = out.replace(/%5B%5Bsite:([^%"]*)%5D%5D/g, (_, p) => escapeHtml(renderSiteUrl(decodeURIComponent(p), siteUrl)));
  // 画像の相対パスをサイトの URL にそろえる。
  out = out.replace(/src="assets\//g, `src="${siteUrl}assets/`);
  const left = out.match(/\[\[[^\]]*\]\]/);
  if (left) throw new Error(`知らない札が残っています: ${left[0]}`);
  return out;
}

// ---------- 原稿の読み込み ----------

export function validateFaq(faq, where) {
  if (!Array.isArray(faq) || faq.length !== 3) {
    throw new Error(`${where}: faq は3問ちょうど必要です（今 ${Array.isArray(faq) ? faq.length : 0} 問）`);
  }
  faq.forEach((item, i) => {
    if (!item || typeof item.q !== 'string' || typeof item.a !== 'string' || !item.q.trim() || !item.a.trim()) {
      throw new Error(`${where}: faq の ${i + 1} 問目に q と a が要ります`);
    }
  });
}

function readMarkdown(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { data, content } = matter(raw);
  return { data, content, file };
}

export function loadArticles(dir = PATHS.articles) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const articles = [];
  const seen = new Set();
  for (const f of files) {
    const { data, content, file } = readMarkdown(path.join(dir, f));
    const where = path.relative(PATHS.root, file);
    if (data.draft === true) continue;
    for (const k of ['title', 'description', 'date', 'cluster']) {
      if (!data[k]) throw new Error(`${where}: front matter に ${k} がありません`);
    }
    const slug = data.slug || f.replace(/\.md$/, '');
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`${where}: slug は英小文字・数字・ハイフンだけにしてください`);
    if (seen.has(slug)) throw new Error(`${where}: slug「${slug}」が重なっています`);
    seen.add(slug);
    const date = toIsoDate(data.date);
    const updated = toIsoDate(data.updated || data.date);
    if (!isIsoDate(date) || !isIsoDate(updated)) throw new Error(`${where}: date / updated は YYYY-MM-DD で書いてください`);
    validateFaq(data.faq, where);
    articles.push({
      kind: 'article',
      slug,
      title: String(data.title),
      description: String(data.description),
      date,
      updated,
      cluster: String(data.cluster),
      keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
      faq: data.faq,
      body: content,
      sourceFile: where,
      urlPath: `articles/${slug}/`,
    });
  }
  // 新しい順（更新日 → 公開日 → slug）
  articles.sort((a, b) => (b.updated.localeCompare(a.updated) || b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)));
  return articles;
}

export function loadPage(name, dir = PATHS.pages) {
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) throw new Error(`固定ページがありません: ${path.relative(PATHS.root, file)}`);
  const { data, content } = readMarkdown(file);
  const where = path.relative(PATHS.root, file);
  for (const k of ['title', 'description']) {
    if (!data[k]) throw new Error(`${where}: front matter に ${k} がありません`);
  }
  validateFaq(data.faq, where);
  const updated = data.updated ? toIsoDate(data.updated) : null;
  if (updated && !isIsoDate(updated)) throw new Error(`${where}: updated は YYYY-MM-DD で書いてください`);
  return { name, title: String(data.title), description: String(data.description), updated, faq: data.faq, body: content };
}

// ---------- 記事本文（二択の型）の組み立て ----------

export function splitSections(markdown) {
  const tokens = marked.lexer(markdown);
  const lead = [];
  const sections = [];
  let current = null;
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 1) {
      throw new Error('本文に「#」の見出しは書かないでください（H1 は front matter の title から作ります）');
    }
    if (t.type === 'heading' && t.depth === 2) {
      current = { heading: t.text.trim(), tokens: [] };
      sections.push(current);
      continue;
    }
    (current ? current.tokens : lead).push(t);
  }
  return { lead, sections };
}

export function renderArticleBody(article, links, config, siteUrl) {
  const { lead, sections } = splitSections(article.body);
  const names = sections.map((s) => s.heading);
  let lastIdx = -1;
  for (const h of REQUIRED_HEADINGS) {
    const idx = names.indexOf(h);
    if (idx === -1) throw new Error(`${article.sourceFile}: 見出し「## ${h}」がありません`);
    if (idx < lastIdx) throw new Error(`${article.sourceFile}: 見出しの順は ${REQUIRED_HEADINGS.join(' → ')} です`);
    lastIdx = idx;
  }
  const leadHtml = lead.length ? `<div class="lead">${marked.parser(lead)}</div>` : '';
  let out = leadHtml;
  for (const s of sections) {
    const meta = SECTION_CLASS[s.heading];
    const inner = marked.parser(s.tokens);
    if (meta) {
      out += `<section class="${meta.cls}" id="${meta.id}"><h2>${escapeHtml(s.heading)}</h2>${inner}</section>`;
    } else {
      out += `<section><h2>${escapeHtml(s.heading)}</h2>${inner}</section>`;
    }
  }
  out += `<p class="price-note">${escapeHtml(config.priceNote)}</p>`;
  out += renderFaq(article.faq);
  out += renderOutside(article.cluster, links, config);
  out += renderTrust(config);
  return renderPlaceholders(out, links, config, siteUrl);
}

export function renderFaq(faq) {
  const items = faq
    .map((f) => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`)
    .join('');
  return `<section class="faq" id="sec-faq"><h2>よくある質問</h2>${items}</section>`;
}

export function faqJsonLd(faq) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

// ---------- ページの外側 ----------

export function renderLayout({ config, siteUrl, page }) {
  const canonical = siteUrl + (page.urlPath || '');
  const aboutUrl = siteUrl + config.author.path;
  const title = page.isHome ? `${config.siteName}｜${config.tagline}` : `${escapeHtml(page.title)}｜${config.siteName}`;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}">`,
    page.noindex ? '<meta name="robots" content="noindex">' : '',
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.siteName)}" href="${siteUrl}feed.xml">`,
    `<link rel="stylesheet" href="${siteUrl}assets/style.css">`,
    `<meta property="og:site_name" content="${escapeHtml(config.siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(page.title)}">`,
    `<meta property="og:description" content="${escapeHtml(page.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="${page.kind === 'article' ? 'article' : 'website'}">`,
    '<meta name="twitter:card" content="summary">',
    config.searchConsoleVerification
      ? `<meta name="google-site-verification" content="${escapeHtml(config.searchConsoleVerification)}">`
      : '',
    config.bingSiteAuth ? `<meta name="msvalidate.01" content="${escapeHtml(config.bingSiteAuth)}">` : '',
    config.ga4MeasurementId ? ga4Snippet(config.ga4MeasurementId) : '',
    ...page.jsonLd.map(jsonLd),
  ]
    .filter(Boolean)
    .join('\n');

  const dateLine = page.kind === 'article'
    ? `<span>公開日：<time datetime="${page.date}">${formatDateJa(page.date)}</time></span><span>最終更新日：<time datetime="${page.updated}">${formatDateJa(page.updated)}</time></span>`
    : `<span>最終更新日：<time datetime="${page.updated}">${formatDateJa(page.updated)}</time></span>`;

  const h1 = page.isHome ? `<h1>${escapeHtml(config.tagline)}</h1>` : `<h1>${escapeHtml(page.title)}</h1>`;

  return `<!doctype html>
<html lang="${config.language || 'ja'}">
<head>
${head}
</head>
<body>
<p class="pr-banner">${escapeHtml(config.prBanner)}</p>
<header class="site-header">
<a class="brand" href="${siteUrl}">${escapeHtml(config.siteName)}</a>
<nav><a href="${siteUrl}">記事一覧</a><a href="${aboutUrl}">編集部について</a><a href="${siteUrl}feed.xml">RSS</a></nav>
</header>
<main>
<article>
${h1}
<p class="meta"><span>著者：<a href="${aboutUrl}">${escapeHtml(config.author.line)}</a></span>${dateLine}</p>
${page.bodyHtml}
</article>
</main>
${config.localDesk && config.localDesk.url ? `<a class="sticky-line" href="${escapeHtml(config.localDesk.url)}" rel="noopener" target="_blank">${escapeHtml(config.localDesk.button)}</a>` : ''}
<footer class="site-footer">
<div class="author-box">著者：<a href="${aboutUrl}">${escapeHtml(config.author.line)}</a>。配管・内装・外壁・害獣駆除の現場で働く施工チームが書いています。</div>
<p>${escapeHtml(config.prBanner)}。${escapeHtml(config.priceNote)}</p>
${(config.sameAs||[]).length ? `<p>${config.sameAs.map((u) => `<a href="${escapeHtml(u)}" rel="me noopener" target="_blank">${u.includes("tiktok") ? "TikTok" : "YouTube"}</a>`).join(' ')}</p>` : ''}
<p>© ${escapeHtml(config.siteName)}</p>
</footer>
</body>
</html>
`;
}

function ga4Snippet(id) {
  const safe = escapeHtml(id);
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${safe}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${safe}');</script>`;
}

// ---------- ページごとの組み立て ----------

function orgAuthor(config, siteUrl) {
  return { '@type': 'Organization', name: config.author.name, url: siteUrl + config.author.path };
}

function publisher(config, siteUrl) {
  return { '@type': 'Organization', name: config.siteName, url: siteUrl, ...(config.sameAs && config.sameAs.length ? { sameAs: config.sameAs } : {}) };
}

export function buildArticlePage(article, { config, links, siteUrl }) {
  const canonical = siteUrl + article.urlPath;
  const bodyHtml = renderArticleBody(article, links, config, siteUrl);
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    datePublished: article.date,
    dateModified: article.updated,
    inLanguage: 'ja',
    articleSection: article.cluster,
    keywords: article.keywords.join(','),
    author: orgAuthor(config, siteUrl),
    publisher: publisher(config, siteUrl),
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: config.siteName, item: siteUrl },
      { '@type': 'ListItem', position: 2, name: article.title, item: canonical },
    ],
  };
  const page = {
    kind: 'article',
    title: article.title,
    description: article.description,
    date: article.date,
    updated: article.updated,
    urlPath: article.urlPath,
    bodyHtml,
    jsonLd: [articleLd, faqJsonLd(article.faq), breadcrumb],
  };
  const html = renderLayout({ config, siteUrl, page });
  return { html, outFile: path.join('articles', article.slug, 'index.html'), charCount: countChars(stripTags(bodyHtml.replace(/<aside[\s\S]*?<\/aside>/g, "")) + article.title) };
}

export function renderArticleList(articles, siteUrl) {
  if (!articles.length) return '<p>記事は準備中です。</p>';
  const items = articles
    .map(
      (a) =>
        `<li><span class="cluster-tag">${escapeHtml(a.cluster)}</span><a href="${siteUrl}${a.urlPath}">${escapeHtml(a.title)}</a><span class="desc">${escapeHtml(a.description)}</span><span class="date">最終更新日：${formatDateJa(a.updated)}</span></li>`,
    )
    .join('');
  return `<ul class="article-list">${items}</ul>`;
}

export function buildHomePage(pageSrc, articles, { config, links, siteUrl, siteUpdated }) {
  const intro = renderPlaceholders(marked.parse(pageSrc.body), links, config, siteUrl);
  const bodyHtml = `${intro}<section id="sec-articles"><h2>記事一覧</h2>${renderArticleList(articles, siteUrl)}</section>${renderFaq(pageSrc.faq)}${renderTrust(config)}`;
  const websiteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: config.siteName,
    description: config.description,
    url: siteUrl,
    inLanguage: 'ja',
    publisher: publisher(config, siteUrl),
  };
  const page = { kind: 'home', isHome: true, title: pageSrc.title, description: pageSrc.description, updated: pageSrc.updated || siteUpdated, urlPath: '', bodyHtml, jsonLd: [websiteLd, faqJsonLd(pageSrc.faq)] };
  return { html: renderLayout({ config, siteUrl, page }), outFile: 'index.html' };
}

export function buildAreaPage(pageSrc, slug, { config, links, siteUrl, siteUpdated }) {
  const urlPath = `area/${slug}/`;
  const bodyHtml = `${renderPlaceholders(marked.parse(pageSrc.body), links, config, siteUrl)}${renderFaq(pageSrc.faq)}${renderTrust(config)}`;
  const ld = { '@context': 'https://schema.org', '@type': 'WebPage', name: pageSrc.title, description: pageSrc.description, url: siteUrl + urlPath, inLanguage: 'ja', publisher: publisher(config, siteUrl) };
  const page = { kind: 'area', title: pageSrc.title, description: pageSrc.description, updated: pageSrc.updated || siteUpdated, urlPath, bodyHtml, jsonLd: [ld, faqJsonLd(pageSrc.faq)] };
  return { html: renderLayout({ config, siteUrl, page }), outFile: path.join('area', slug, 'index.html'), urlPath, updated: page.updated };
}

export function buildAboutPage(pageSrc, { config, links, siteUrl, siteUpdated }) {
  const bodyHtml = `${renderPlaceholders(marked.parse(pageSrc.body), links, config, siteUrl)}${renderFaq(pageSrc.faq)}`;
  const aboutLd = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: pageSrc.title,
    description: pageSrc.description,
    url: siteUrl + config.author.path,
    inLanguage: 'ja',
    mainEntity: orgAuthor(config, siteUrl),
  };
  const page = { kind: 'about', title: pageSrc.title, description: pageSrc.description, updated: pageSrc.updated || siteUpdated, urlPath: config.author.path, bodyHtml, jsonLd: [aboutLd, faqJsonLd(pageSrc.faq)] };
  return { html: renderLayout({ config, siteUrl, page }), outFile: path.join(config.author.path, 'index.html') };
}

export function buildNotFoundPage(pageSrc, { config, links, siteUrl, siteUpdated }) {
  const bodyHtml = `${renderPlaceholders(marked.parse(pageSrc.body), links, config, siteUrl)}${renderFaq(pageSrc.faq)}`;
  const ld = { '@context': 'https://schema.org', '@type': 'WebPage', name: pageSrc.title, url: siteUrl + '404.html', inLanguage: 'ja' };
  const page = { kind: '404', noindex: true, title: pageSrc.title, description: pageSrc.description, updated: pageSrc.updated || siteUpdated, urlPath: '404.html', bodyHtml, jsonLd: [ld, faqJsonLd(pageSrc.faq)] };
  return { html: renderLayout({ config, siteUrl, page }), outFile: '404.html' };
}

export function buildSitemap(articles, { config, siteUrl, siteUpdated, areaUrls = [] }) {
  const urls = [
    { loc: siteUrl, lastmod: siteUpdated },
    { loc: siteUrl + config.author.path, lastmod: siteUpdated },
    ...articles.map((a) => ({ loc: siteUrl + a.urlPath, lastmod: a.updated })),
    ...areaUrls,
  ];
  const body = urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function buildRobots(siteUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`;
}

export function buildFeed(articles, { config, siteUrl, siteUpdated }) {
  const items = articles
    .map(
      (a) => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${escapeXml(siteUrl + a.urlPath)}</link>
      <guid isPermaLink="true">${escapeXml(siteUrl + a.urlPath)}</guid>
      <pubDate>${toRfc822(a.date)}</pubDate>
      <description>${escapeXml(a.description)}</description>
      <category>${escapeXml(a.cluster)}</category>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(config.siteName)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(config.description)}</description>
    <language>ja</language>
    <lastBuildDate>${toRfc822(siteUpdated)}</lastBuildDate>
    <atom:link href="${escapeXml(siteUrl)}feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

// ---------- 全体 ----------

function writeOut(distDir, rel, content) {
  const file = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// 代表判断 2026-11-03：運営者名（屋号）は編集部ページ（about）にだけ出してよい。他のページでは今まで通り禁止。
export const OPERATOR_NAME = Buffer.from('TEEtTFVDQVRP', 'base64').toString('utf8');
export const OPERATOR_ALLOWED = new Set(['about/index.html', 'src/content/pages/about.md']);
const OPERATOR_ALLOWED_PAGES = OPERATOR_ALLOWED;
function assertClean(rel, content) {
  const checked = OPERATOR_ALLOWED_PAGES.has(rel) ? content.split(OPERATOR_NAME).join('') : content;
  const hits = findForbidden(checked);
  if (hits.length) {
    throw new Error(`${rel}: 出してはならない語があります（${hits.map((h) => h.sample).join(', ')}）。原稿を直してください`);
  }
}

export function build({ siteUrl: rawSiteUrl = process.env.SITE_URL, distDir = PATHS.dist, log = () => {} } = {}) {
  const siteUrl = normalizeSiteUrl(rawSiteUrl);
  const config = loadConfig();
  const links = loadLinks();
  const articles = loadArticles();
  const home = loadPage('index');
  const about = loadPage('about');
  const notFound = loadPage('404');
  const dates = [...articles.map((a) => a.updated), home.updated, about.updated].filter(Boolean).sort();
  const siteUpdated = dates[dates.length - 1] || '1970-01-01';
  const ctx = { config, links, siteUrl, siteUpdated };

  const outputs = [];
  for (const a of articles) {
    const r = buildArticlePage(a, ctx);
    outputs.push({ rel: r.outFile, content: r.html, charCount: r.charCount, slug: a.slug });
  }
  const h = buildHomePage(home, articles, ctx);
  outputs.push({ rel: h.outFile, content: h.html });
  const ab = buildAboutPage(about, ctx);
  outputs.push({ rel: ab.outFile, content: ab.html });
  const nf = buildNotFoundPage(notFound, ctx);
  outputs.push({ rel: nf.outFile, content: nf.html });
  const areaUrls = [];
  for (const f of fs.readdirSync(PATHS.pages).filter((n) => /^area-[a-z0-9-]+\.md$/.test(n))) {
    const slug = f.replace(/^area-/, '').replace(/\.md$/, '');
    const r = buildAreaPage(loadPage(f.replace(/\.md$/, '')), slug, ctx);
    outputs.push({ rel: r.outFile, content: r.html });
    areaUrls.push({ loc: siteUrl + r.urlPath, lastmod: r.updated });
  }
  outputs.push({ rel: 'sitemap.xml', content: buildSitemap(articles, { ...ctx, areaUrls }) });
  outputs.push({ rel: 'robots.txt', content: buildRobots(siteUrl) });
  outputs.push({ rel: 'feed.xml', content: buildFeed(articles, ctx) });
  outputs.push({ rel: '.nojekyll', content: '' });
  // Search Console の所有確認ファイル（中身は Google が決めた 1 行。秘密ではない）。
  for (const name of config.googleVerificationFiles || []) {
    if (!/^google[0-9a-f]+\.html$/.test(name)) throw new Error(`googleVerificationFiles の名前が変です: ${name}`);
    outputs.push({ rel: name, content: `google-site-verification: ${name}` });
  }
  // IndexNow（Bing など）の鍵ファイル。鍵は公開して使う物で、秘密ではない。
  if (config.indexNowKey) {
    if (!/^[0-9a-f]{32}$/.test(config.indexNowKey)) throw new Error('indexNowKey は 32 桁の 16 進数にする');
    outputs.push({ rel: `${config.indexNowKey}.txt`, content: config.indexNowKey });
  }

  // 全部そろってから書く（途中で失敗した時に半端な dist/ を残さない）。
  for (const o of outputs) assertClean(o.rel, o.content);

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  for (const o of outputs) writeOut(distDir, o.rel, o.content);
  if (fs.existsSync(PATHS.assets)) {
    fs.cpSync(PATHS.assets, path.join(distDir, 'assets'), { recursive: true });
  }
  // 複製した素材にも禁止語が無いか見る（SVG やテキストの素材のため）。
  for (const f of walk(path.join(distDir, 'assets'))) {
    if (/\.(css|svg|txt|json|js|html|xml)$/i.test(f)) assertClean(path.relative(distDir, f), fs.readFileSync(f, 'utf8'));
  }

  for (const o of outputs) {
    if (o.charCount != null) log(`記事 ${o.slug}: ${o.charCount} 文字`);
  }
  log(`siteUrl=${siteUrl} 記事 ${articles.length} 本、ファイル ${outputs.length} 個 → ${path.relative(process.cwd(), distDir) || '.'}`);
  return { siteUrl, articles, outputs, siteUpdated };
}

export function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    build({ log: (m) => console.log(m) });
  } catch (e) {
    console.error(`ビルド失敗: ${e.message}`);
    process.exit(1);
  }
}
