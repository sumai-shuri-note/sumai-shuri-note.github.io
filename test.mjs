#!/usr/bin/env node
// 住まいの修理ノート — 検査。`npm test` で動く。Node の node:test だけを使う（追加の依存なし）。
//
// 見る事:
//   1. ビルドが通る（`node build.mjs`）。
//   2. dist/ の全 HTML に、広告表記・著者欄・最終更新日・canonical・FAQPage の構造化データ（3問）がある。
//   3. 記事の HTML に Article の構造化データ・二択の見出し・価格の注意書き・FAQ がある。
//   4. 出してはならない語が dist/ にも原稿にも無い。
//   5. links.json の札が、URL あり→計測つきリンク、URL なし→「（リンク準備中）」になる。
//   6. CSS が 10KB 以下。sitemap / robots / feed / 404 がある。
//   7. 記事の長さが 1,200〜2,000 文字。2回ビルドしても同じ物が出る。SITE_URL を変えると canonical が変わる。
//   8. 原稿の不備（見出し不足・知らない札・FAQ が3問でない）でビルドが止まる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  OPERATOR_NAME, OPERATOR_ALLOWED,
  PATHS,
  REQUIRED_HEADINGS,
  build,
  loadConfig,
  loadLinks,
  loadArticles,
  renderLink,
  renderArticleBody,
  renderPlaceholders,
  validateFaq,
  stripTags,
  countChars,
  walk,
} from './build.mjs';
import { findForbidden } from './lib/forbidden.mjs';

const ROOT = PATHS.root;
const DIST = PATHS.dist;
const config = loadConfig();
const links = loadLinks();
const articles = loadArticles();

const CHAR_MIN = 1200;
const CHAR_MAX = 2000;
const CSS_MAX_BYTES = 10 * 1024;

function htmlFiles(dir) {
  // Search Console の確認ファイル（google*.html）は記事ではないので外す。
  return walk(dir).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(path.basename(f)));
}

function read(f) {
  return fs.readFileSync(f, 'utf8');
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(JSON.parse(m[1]));
  return out;
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function snapshot(dir) {
  const map = {};
  for (const f of walk(dir)) map[path.relative(dir, f)] = sha(fs.readFileSync(f));
  return map;
}

// ---------- 1. ビルド ----------

test('ビルドが通る（node build.mjs）', () => {
  const out = execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SITE_URL: '' } });
  assert.match(out, /記事 \d+ 本/);
  assert.ok(fs.existsSync(path.join(DIST, 'index.html')), 'dist/index.html がある');
});

test('記事が5本以上ある', () => {
  assert.ok(articles.length >= 5, `記事 ${articles.length} 本`);
  for (const a of articles) {
    assert.ok(fs.existsSync(path.join(DIST, 'articles', a.slug, 'index.html')), `${a.slug} の HTML がある`);
  }
});

// ---------- 2. 全ページ共通 ----------

test('全 HTML に広告表記・著者欄・最終更新日・canonical・viewport がある', () => {
  const files = htmlFiles(DIST);
  assert.ok(files.length >= 8, `HTML ${files.length} 個`);
  for (const f of files) {
    const html = read(f);
    const rel = path.relative(DIST, f);
    assert.ok(html.includes(config.prBanner), `${rel}: 広告表記`);
    assert.ok(html.includes(config.author.line), `${rel}: 著者欄`);
    assert.ok(html.includes('最終更新日：'), `${rel}: 最終更新日`);
    assert.match(html, /<link rel="canonical" href="https?:\/\/[^"]+">/, `${rel}: canonical`);
    assert.ok(html.includes('<meta name="viewport"'), `${rel}: viewport`);
    assert.ok(html.includes('<html lang="ja">'), `${rel}: lang=ja`);
    assert.ok(html.includes('assets/style.css'), `${rel}: CSS を読む`);
  }
});

test('全 HTML に FAQPage の構造化データ（3問）と、見える FAQ がある', () => {
  for (const f of htmlFiles(DIST)) {
    const html = read(f);
    const rel = path.relative(DIST, f);
    const blocks = jsonLdBlocks(html);
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    assert.ok(faq, `${rel}: FAQPage がある`);
    assert.equal(faq.mainEntity.length, 3, `${rel}: FAQ は3問`);
    for (const q of faq.mainEntity) {
      assert.equal(q['@type'], 'Question');
      assert.ok(q.name && q.acceptedAnswer && q.acceptedAnswer.text, `${rel}: 質問と答えがある`);
      assert.ok(html.includes(`<h3>${q.name.replace(/&/g, '&amp;')}</h3>`), `${rel}: 質問が本文にも見える`);
    }
    assert.ok(html.includes('<section class="faq"'), `${rel}: FAQ の枠`);
  }
});

// ---------- 3. 記事 ----------

test('記事の HTML に Article の構造化データと二択の型がある', () => {
  for (const a of articles) {
    const f = path.join(DIST, 'articles', a.slug, 'index.html');
    const html = read(f);
    const blocks = jsonLdBlocks(html);
    const art = blocks.find((b) => b['@type'] === 'Article');
    assert.ok(art, `${a.slug}: Article がある`);
    assert.equal(art.headline, a.title);
    assert.equal(art.datePublished, a.date);
    assert.equal(art.dateModified, a.updated);
    assert.equal(art.author['@type'], 'Organization');
    assert.equal(art.author.name, config.author.name);
    assert.ok(blocks.find((b) => b['@type'] === 'BreadcrumbList'), `${a.slug}: パンくず`);

    assert.ok(html.includes(`<h1>${a.title}</h1>`), `${a.slug}: H1`);
    let last = -1;
    for (const h of REQUIRED_HEADINGS) {
      const i = html.indexOf(`<h2>${h}</h2>`);
      assert.ok(i > last, `${a.slug}: 見出し「${h}」がこの順にある`);
      last = i;
    }
    assert.ok(html.includes('class="choice choice-diy"'), `${a.slug}: 自分でやる枠`);
    assert.ok(html.includes('class="choice choice-hire"'), `${a.slug}: 頼む枠`);
    assert.ok(html.includes('class="hitokoto"'), `${a.slug}: 現場の一言`);
    assert.ok(html.includes('価格は記事作成時点のものです'), `${a.slug}: 価格の注意書き`);
    assert.ok(html.includes('<div class="lead">'), `${a.slug}: リード`);
    assert.ok(!/\[\[[^\]]*\]\]/.test(html), `${a.slug}: 札が残っていない`);
    assert.ok(html.includes('<meta property="og:type" content="article">'), `${a.slug}: og:type`);
  }
});

test(`記事の本文は ${CHAR_MIN}〜${CHAR_MAX} 文字`, () => {
  for (const a of articles) {
    const html = read(path.join(DIST, 'articles', a.slug, 'index.html'));
    const m = html.match(/<article>([\s\S]*?)<\/article>/);
    assert.ok(m, `${a.slug}: article 要素`);
    // 著者・日付の行は本文に数えない。
    const body = m[1].replace(/<p class="meta">[\s\S]*?<\/p>/, '').replace(/<aside[\s\S]*?<\/aside>/g, ''); // 共通の枠（相談・信頼）は数えない
    const n = countChars(stripTags(body));
    assert.ok(n >= CHAR_MIN && n <= CHAR_MAX, `${a.slug}: ${n} 文字（${CHAR_MIN}〜${CHAR_MAX} の範囲）`);
  }
});

// ---------- 4. 禁止語 ----------

test('dist/ に出してはならない語が無い', () => {
  const files = walk(DIST).filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const rel0 = path.relative(DIST, f).split(path.sep).join('/');
    const body0 = OPERATOR_ALLOWED.has(rel0) ? read(f).split(OPERATOR_NAME).join('') : read(f);
    const hits = findForbidden(body0);
    assert.equal(hits.length, 0, `${path.relative(DIST, f)}: 禁止語 ${hits.map((h) => h.sample).join(', ')}`);
  }
});

test('原稿・設定・README にも出してはならない語が無い', () => {
  const skip = new Set(['node_modules', 'dist', '.git']);
  const files = walk(ROOT).filter((f) => {
    const rel = path.relative(ROOT, f);
    return !rel.split(path.sep).some((seg) => skip.has(seg)) && !/\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(f);
  });
  assert.ok(files.length > 10, `見た数 ${files.length}`);
  for (const f of files) {
    const rel1 = path.relative(ROOT, f).split(path.sep).join('/');
    const body1 = OPERATOR_ALLOWED.has(rel1) ? read(f).split(OPERATOR_NAME).join('') : read(f);
    const hits = findForbidden(body1);
    assert.equal(hits.length, 0, `${path.relative(ROOT, f)}: 禁止語 ${hits.map((h) => h.sample).join(', ')}`);
  }
});

test('禁止語の検出が働く（伏せ字を復号した語を見つける）', async () => {
  const { FORBIDDEN_WORDS } = await import('./lib/forbidden.mjs');
  assert.equal(FORBIDDEN_WORDS.length, 4);
  for (const w of FORBIDDEN_WORDS) {
    assert.equal(findForbidden(`前 ${w} 後`).length, 1, '語そのものを見つける');
    assert.equal(findForbidden(`前 ${w.toLowerCase()} 後`).length, 1, '小文字でも見つける');
  }
  assert.equal(findForbidden('普通の文です。').length, 0);
});

// ---------- 5. links.json の札 ----------

test('links.json の札: URL が空なら「（リンク準備中）」、URL があれば計測つきリンク', () => {
  const fake = {
    'empty-one': { label: '道具A', kind: '物販', url: '' },
    'with-url': { label: '道具B', kind: '物販', url: 'https://example.test/item' },
  };
  const pending = renderLink('empty-one', fake, config);
  assert.ok(pending.includes(config.linkPendingText), '準備中の文字');
  assert.ok(pending.includes('道具A'));
  assert.ok(!pending.includes('<a '), '準備中はリンクにしない');

  const live = renderLink('with-url', fake, config);
  assert.ok(live.includes('<a href="https://example.test/item"'));
  assert.ok(live.includes('rel="sponsored nofollow noopener"'), '広告リンクの rel');
  assert.ok(live.includes('target="_blank"'));
  assert.ok(!live.includes(config.linkPendingText));

  assert.throws(() => renderLink('nothing', fake, config), /links\.json に無い札/);
});

test('原稿で使う札は全部 links.json にあり、dist/ ではリンクか準備中の文字になっている', () => {
  const used = new Set();
  for (const a of articles) {
    for (const m of a.body.matchAll(/\[\[link:([a-z0-9-]+)\]\]/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 5, `使っている札 ${used.size} 個`);
  for (const slug of used) {
    assert.ok(links[slug], `links.json に ${slug} がある`);
  }
  for (const a of articles) {
    const html = read(path.join(DIST, 'articles', a.slug, 'index.html'));
    for (const m of a.body.matchAll(/\[\[link:([a-z0-9-]+)\]\]/g)) {
      const slug = m[1];
      const entry = links[slug];
      if (entry.url) {
        assert.ok(html.includes(`<a href="${entry.url}" rel="sponsored nofollow noopener"`), `${a.slug}: ${slug} がリンク`);
      } else {
        assert.ok(html.includes(`data-link="${slug}"`) && html.includes(config.linkPendingText), `${a.slug}: ${slug} が準備中`);
      }
    }
  }
});

test('写真の札: 置き場なしは枠、置き場ありは画像', () => {
  const siteUrl = 'https://example.test/';
  const a = renderPlaceholders('<p>[[photo:内窓の枠]]</p>', links, config, siteUrl);
  assert.ok(a.includes('写真の枠（準備中）') && a.includes('<figcaption>内窓の枠</figcaption>') && !a.includes('<p>'));
  const b = renderPlaceholders('<p>[[photo:内窓の枠|assets/img/a.jpg]]</p>', links, config, siteUrl);
  assert.ok(b.includes(`<img src="${siteUrl}assets/img/a.jpg" alt="内窓の枠"`));
  assert.throws(() => renderPlaceholders('[[photo:x|../etc/passwd]]', links, config, siteUrl), /assets\//);
  assert.throws(() => renderPlaceholders('[[unknown:x]]', links, config, siteUrl), /知らない札/);
});

// ---------- 6. 付属物 ----------

test(`CSS は ${CSS_MAX_BYTES} バイト以下`, () => {
  const size = fs.statSync(path.join(DIST, 'assets', 'style.css')).size;
  assert.ok(size <= CSS_MAX_BYTES, `${size} バイト`);
});

test('sitemap.xml / robots.txt / feed.xml / 404.html / .nojekyll がある', () => {
  const sitemap = read(path.join(DIST, 'sitemap.xml'));
  const robots = read(path.join(DIST, 'robots.txt'));
  const feed = read(path.join(DIST, 'feed.xml'));
  const nf = read(path.join(DIST, '404.html'));
  assert.ok(fs.existsSync(path.join(DIST, '.nojekyll')));

  assert.ok(sitemap.startsWith('<?xml'));
  assert.ok(sitemap.includes('<loc>https://sumai-shuri-note.pages.dev/</loc>'));
  assert.ok(sitemap.includes('<loc>https://sumai-shuri-note.pages.dev/about/</loc>'));
  for (const a of articles) {
    assert.ok(sitemap.includes(`<loc>https://sumai-shuri-note.pages.dev/articles/${a.slug}/</loc>`), `sitemap: ${a.slug}`);
    assert.ok(feed.includes(`<link>https://sumai-shuri-note.pages.dev/articles/${a.slug}/</link>`), `feed: ${a.slug}`);
  }
  assert.ok(robots.includes('Sitemap: https://sumai-shuri-note.pages.dev/sitemap.xml'));
  assert.ok(feed.includes('<rss version="2.0"'));
  assert.equal((feed.match(/<item>/g) || []).length, articles.length);
  assert.ok(nf.includes('<meta name="robots" content="noindex">'));
  assert.ok(nf.includes('<h1>ページが見つかりません</h1>'));
});

test('編集部ページがあり、著者の構造化データが編集部ページを指す', () => {
  const about = read(path.join(DIST, config.author.path, 'index.html'));
  assert.ok(about.includes('<h1>編集部について</h1>'));
  assert.ok(jsonLdBlocks(about).find((b) => b['@type'] === 'AboutPage'));
  for (const a of articles) {
    const html = read(path.join(DIST, 'articles', a.slug, 'index.html'));
    const art = jsonLdBlocks(html).find((b) => b['@type'] === 'Article');
    assert.equal(art.author.url, 'https://sumai-shuri-note.pages.dev/' + config.author.path);
  }
});

// ---------- 7. 冪等・SITE_URL ----------

test('2回ビルドしても同じ dist/ になる', () => {
  const before = snapshot(DIST);
  build();
  const after = snapshot(DIST);
  assert.deepEqual(after, before);
});

test('SITE_URL を変えると canonical と CSS の道が変わる', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdn-'));
  try {
    const siteUrl = 'https://example.test/sub';
    const r = build({ siteUrl, distDir: tmp });
    assert.equal(r.siteUrl, 'https://example.test/sub/', '末尾に / を足す');
    const html = read(path.join(tmp, 'articles', articles[0].slug, 'index.html'));
    assert.ok(html.includes(`<link rel="canonical" href="https://example.test/sub/articles/${articles[0].slug}/">`));
    assert.ok(html.includes('href="https://example.test/sub/assets/style.css"'));
    assert.ok(read(path.join(tmp, 'robots.txt')).includes('Sitemap: https://example.test/sub/sitemap.xml'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.throws(() => build({ siteUrl: 'not a url', distDir: path.join(os.tmpdir(), 'gdn-never') }), /SITE_URL/);
});

// ---------- 8. fail-closed ----------

test('二択の見出しが無い原稿はビルドで止まる', () => {
  const base = { ...articles[0], sourceFile: 'test.md' };
  const siteUrl = 'https://example.test/';
  const missing = { ...base, body: '本文\n\n## 自分でやるなら、この道具\n\n- a\n\n## 現場の一言\n\nb' };
  assert.throws(() => renderArticleBody(missing, links, config, siteUrl), /頼むなら、ここ/);
  const wrongOrder = { ...base, body: '## 頼むなら、ここ\n\na\n\n## 自分でやるなら、この道具\n\nb\n\n## 現場の一言\n\nc' };
  assert.throws(() => renderArticleBody(wrongOrder, links, config, siteUrl), /見出しの順/);
  const h1 = { ...base, body: '# 題\n\n## 自分でやるなら、この道具\n\na\n\n## 頼むなら、ここ\n\nb\n\n## 現場の一言\n\nc' };
  assert.throws(() => renderArticleBody(h1, links, config, siteUrl), /H1/);
  const unknownLink = { ...base, body: '## 自分でやるなら、この道具\n\n[[link:no-such-slug]]\n\n## 頼むなら、ここ\n\nb\n\n## 現場の一言\n\nc' };
  assert.throws(() => renderArticleBody(unknownLink, links, config, siteUrl), /links\.json に無い札/);
  const ok = { ...base, body: '## 自分でやるなら、この道具\n\n[[link:uchimado-kit]]\n\n## 頼むなら、ここ\n\nb\n\n## 現場の一言\n\nc' };
  assert.ok(renderArticleBody(ok, links, config, siteUrl).includes('sec-hitokoto'));
});

test('FAQ が3問でない原稿は止まる', () => {
  assert.throws(() => validateFaq([{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }], 'x'), /3問/);
  assert.throws(() => validateFaq([{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }, { q: 'e', a: '' }], 'x'), /q と a/);
  assert.doesNotThrow(() => validateFaq([{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }, { q: 'e', a: 'f' }], 'x'));
});
