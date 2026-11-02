// 公開物（dist/ と原稿）に出してはならない語。
// 平文では置かない。このフォルダをそのまま公開リポジトリに写しても、語が残らないようにするため。
// 中身：運営会社の名前（英字1つ・カタカナ1つ）と、関係する会社の名前（英字1つ・カタカナ1つ）。
// 追加する時は `node -e 'console.log(Buffer.from("語").toString("base64"))'` で作る。
const ENCODED = [
  'QVFVQUxPVA==',
  'TEEtTFVDQVRP',
  '44Ki44Kv44Ki44Ot44OD44OI',
  '44Op44Or44Kr44O844OI',
];

export const FORBIDDEN_WORDS = ENCODED.map((s) => Buffer.from(s, 'base64').toString('utf8'));

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 英字の語は大文字小文字を区別せず、区切り（- _ 空白）の有無も許す。カタカナは完全一致。
export const FORBIDDEN_PATTERNS = FORBIDDEN_WORDS.map((w) => {
  if (/^[A-Za-z-]+$/.test(w)) {
    const body = w.split('-').map(escapeRegExp).join('[-_ ]?');
    return new RegExp(body, 'i');
  }
  return new RegExp(escapeRegExp(w));
});

// 文字列の中に禁止語があれば、見つかった語（伏せ字）を返す。無ければ空配列。
export function findForbidden(text) {
  const hits = [];
  FORBIDDEN_PATTERNS.forEach((re, i) => {
    const m = re.exec(text);
    if (m) hits.push({ index: i, sample: maskWord(m[0]) });
  });
  return hits;
}

// 報告用。先頭1文字だけ残して伏せる（ログにも平文を残さない）。
export function maskWord(w) {
  return w.length <= 1 ? '*' : w[0] + '*'.repeat(w.length - 1);
}
