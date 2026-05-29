import {
  LOOKBOOK_IMAGE_CASUAL_BASE64,
  LOOKBOOK_IMAGE_SMART_BASE64,
} from './lookbook-images.js';

// MCP Apps UI resource: a self-contained HTML page rendered by the host
// (Claude Desktop / claude.ai) inside a sandboxed iframe alongside the tool
// result. All images are inline data URIs and there are no external scripts
// or stylesheets, so the host's default deny-by-default CSP applies without
// needing `_meta.ui.csp.resourceDomains`.
//
// The content is intentionally fixed and product-agnostic — see Slack
// huckleberry-inc#C0AAPPSMLCD (tamaki, Reply 34, 2026-05-28): the demo just
// needs "適当なコーデとかレビュー情報" to show that 3rd-party enrichment can
// be surfaced to the agent for purchase intent boost.

const CASUAL_IMG = `data:image/jpeg;base64,${LOOKBOOK_IMAGE_CASUAL_BASE64}`;
const SMART_IMG = `data:image/jpeg;base64,${LOOKBOOK_IMAGE_SMART_BASE64}`;

export const LOOKBOOK_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<title>Styling & Reviews</title>
<style>
  :root {
    --bg: #fafaf7;
    --card: #ffffff;
    --ink: #1a1a1a;
    --muted: #6b6b6b;
    --accent: #c8a165;
    --border: rgba(0, 0, 0, 0.08);
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif);
    color: var(--ink);
    background: var(--bg);
    line-height: 1.5;
    padding: 20px;
  }
  h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 12px;
    letter-spacing: -0.01em;
  }
  h2:not(:first-of-type) { margin-top: 28px; }
  .lead {
    margin: 0 0 16px;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  figure {
    margin: 0;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  figure img {
    display: block;
    width: 100%;
    height: 200px;
    object-fit: cover;
  }
  figcaption {
    padding: 10px 12px;
  }
  figcaption .label {
    font-weight: 600;
    font-size: 0.92rem;
    margin: 0 0 2px;
  }
  figcaption .desc {
    font-size: 0.82rem;
    color: var(--muted);
    margin: 0;
  }
  .reviews {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 10px;
  }
  .reviews li {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: var(--shadow);
  }
  .stars {
    color: var(--accent);
    letter-spacing: 1px;
    font-size: 0.88rem;
    margin-bottom: 4px;
  }
  blockquote {
    margin: 0;
    font-size: 0.92rem;
  }
  .meta {
    margin: 6px 0 0;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .disclaimer {
    margin-top: 24px;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.03);
    border-radius: 6px;
    font-size: 0.75rem;
    color: var(--muted);
    line-height: 1.5;
  }
</style>
</head>
<body>
  <h2>こんな着こなしはいかが？</h2>
  <p class="lead">スタイリストおすすめのコーデ例です。</p>
  <div class="grid">
    <figure>
      <img src="${CASUAL_IMG}" alt="カジュアル: 白T + ブラックボトムのデイリースタイル" />
      <figcaption>
        <p class="label">Daily Casual</p>
        <p class="desc">白T × ブラックボトム。シンプルで失敗のない定番。</p>
      </figcaption>
    </figure>
    <figure>
      <img src="${SMART_IMG}" alt="街使い: パステルコート + ベルテッドバッグの大人スタイル" />
      <figcaption>
        <p class="label">City Statement</p>
        <p class="desc">淡色ロングコート + ベルテッドバッグ。外出に映える1枚。</p>
      </figcaption>
    </figure>
  </div>

  <h2>みんなのレビュー</h2>
  <ul class="reviews">
    <li>
      <div class="stars">★★★★★</div>
      <blockquote>サイズ感ぴったり。結婚式で着ていったら何人にも褒められました。</blockquote>
      <p class="meta">— Sarah K. · Trustpilot</p>
    </li>
    <li>
      <div class="stars">★★★★☆</div>
      <blockquote>生地は本当に良いが、ややタイトめ。サイズ感に迷ったらワンサイズ上げをおすすめ。</blockquote>
      <p class="meta">— Jamie L. · Trustpilot</p>
    </li>
    <li>
      <div class="stars">★★★★★</div>
      <blockquote>5回洗濯しても全く色落ちせず、シルエットも崩れません。ヘビロテ確定。</blockquote>
      <p class="meta">— Marcus T. · Yotpo</p>
    </li>
  </ul>

  <p class="disclaimer">
    ※ 本パネルはデモ用の固定コンテンツです (Shopify / 各サードパーティ由来ではありません)。
    実運用では商品ごとにキュレートされたコーデ・レビューを動的に差し込む想定です。
  </p>
</body>
</html>`;
