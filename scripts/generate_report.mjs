#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODELS = ["GLM-5-Turbo", "GLM-4.7", "GLM-4.7-Flash"];
const TIMEOUT = parseInt(process.env.ZHIPU_TIMEOUT || "660000", 10);
const MAX_TOKENS = parseInt(process.env.ZHIPU_MAX_TOKENS || "100000", 10);
const INPUT = process.env.PAPERS_OUTPUT || "papers.json";
const OUTPUT = process.env.REPORT_OUTPUT || "";

const SYSTEM_PROMPT = `你是迷走神經、自律神經調節與身心醫學領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員與大眾閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 5-8（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

function loadPapers(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function buildPrompt(data) {
  const date = data.date;
  const count = data.count;
  const papersText = JSON.stringify(data.papers || [], null, 2);

  return `以下是 ${date} 從 PubMed 抓取的最新迷走神經相關文獻（共 ${count} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${date}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "迷走神經刺激": 3,
    "心率變異度": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：迷走神經刺激、心率變異度、憂鬱症、焦慮症、PTSD、創傷、壓力、腸腦軸、微生態、發炎、免疫、慢性疼痛、腸躁症、發炎性腸道疾病、肥胖與食慾、運動與恢復、呼吸訓練、社交決定因子、兒童逆境、自律神經失調、神經調節、生理回饋、正念冥想、睡眠、神經科學、營養與代謝。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

function tryParseJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    cleaned = firstNewline !== -1 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/, "").trim();
  }
  cleaned = cleaned.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
  if (!cleaned.startsWith("{")) cleaned = "{" + cleaned;
  if (!cleaned.endsWith("}")) cleaned = cleaned + "}";
  return JSON.parse(cleaned);
}

async function callZhipu(apiKey, model, prompt) {
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: MAX_TOKENS,
  };

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get("retry-after") || "60", 10);
    console.error(`[WARN] Rate limited, waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    throw new Error("rate_limited");
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

async function analyzeWithRetry(apiKey, prompt) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt})...`);
        const raw = await callZhipu(apiKey, model, prompt);
        const parsed = tryParseJson(raw);
        console.error(
          `[INFO] Analysis complete: ${parsed.top_picks?.length || 0} top picks, ${parsed.all_papers?.length || 0} total`
        );
        return parsed;
      } catch (e) {
        if (e instanceof SyntaxError) {
          console.error(`[WARN] JSON parse failed attempt ${attempt}: ${e.message}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        if (e.message === "rate_limited") continue;
        console.error(`[ERROR] ${model} failed: ${e.message}`);
        break;
      }
    }
  }
  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const dp = dateStr.split("-");
  const dateDisplay = dp.length === 3 ? `${dp[0]}年${parseInt(dp[1])}月${parseInt(dp[2])}日` : dateStr;
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const wd = dp.length === 3 ? weekdays[new Date(dateStr).getDay()] : "";

  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topHtml = "";
  for (const p of topPicks) {
    const tags = (p.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
    const util = p.clinical_utility || "中";
    const ucls = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    const pico = p.pico || {};
    const picoHtml = (pico.population || pico.intervention || pico.comparison || pico.outcome)
      ? `<div class="pico-grid">
        <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${pico.population || "-"}</span></div>
        <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${pico.intervention || "-"}</span></div>
        <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${pico.comparison || "-"}</span></div>
        <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${pico.outcome || "-"}</span></div>
      </div>`
      : "";
    topHtml += `
    <div class="news-card featured">
      <div class="card-header">
        <span class="rank-badge">#${p.rank || ""}</span>
        <span class="emoji-icon">${p.emoji || "📄"}</span>
        <span class="${ucls}">${util}實用性</span>
      </div>
      <h3>${p.title_zh || p.title_en || ""}</h3>
      <p class="journal-source">${p.journal || ""} &middot; ${p.title_en || ""}</p>
      <p>${p.summary || ""}</p>
      ${picoHtml}
      <div class="card-footer">
        ${tags}
        <a href="${p.url || "#"}" target="_blank">閱讀原文 →</a>
      </div>
    </div>`;
  }

  let allHtml = "";
  for (const p of allPapers) {
    const tags = (p.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
    const util = p.clinical_utility || "中";
    const ucls = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    allHtml += `
    <div class="news-card">
      <div class="card-header-row">
        <span class="emoji-sm">${p.emoji || "📄"}</span>
        <span class="${ucls} utility-sm">${util}</span>
      </div>
      <h3>${p.title_zh || p.title_en || ""}</h3>
      <p class="journal-source">${p.journal || ""}</p>
      <p>${p.summary || ""}</p>
      <div class="card-footer">
        ${tags}
        <a href="${p.url || "#"}" target="_blank">PubMed →</a>
      </div>
    </div>`;
  }

  const kwHtml = keywords.map((k) => `<span class="keyword">${k}</span>`).join("");
  let topicHtml = "";
  if (Object.keys(topicDist).length) {
    const maxC = Math.max(...Object.values(topicDist), 1);
    topicHtml = Object.entries(topicDist)
      .map(
        ([t, c]) => `<div class="topic-row">
      <span class="topic-name">${t}</span>
      <div class="topic-bar-bg"><div class="topic-bar" style="width:${Math.round((c / maxC) * 100)}%"></div></div>
      <span class="topic-count">${c}</span>
    </div>`
      )
      .join("");
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Vagus Nerve Daily &middot; 迷走神經文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 迷走神經文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 120px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .link-banner { margin-top: 16px; animation: fadeUp 0.5s ease 0.4s both; }
  .link-card { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .link-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .link-icon { font-size: 28px; flex-shrink: 0; }
  .link-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .link-desc { font-size: 12px; color: var(--muted); }
  .link-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 80px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🫀</div>
    <div class="header-text">
      <h1>Vagus Nerve Daily &middot; 迷走神經文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}（週${wd}）</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topHtml ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topHtml}</div>` : ""}

  ${allHtml ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allHtml}</div>` : ""}

  ${topicHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicHtml}</div>` : ""}

  ${kwHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${kwHtml}</div></div>` : ""}

  <div class="link-banner">
    <a href="https://www.leepsyclinic.com/" class="link-card" target="_blank">
      <span class="link-icon">🏥</span>
      <div><span class="link-name">李政洋身心診所首頁</span></div>
      <span class="link-arrow">→</span>
    </a>
  </div>
  <div class="link-banner" style="margin-top:12px">
    <a href="https://blog.leepsyclinic.com/" class="link-card" target="_blank">
      <span class="link-icon">📬</span>
      <div><span class="link-name">訂閱電子報</span><br/><span class="link-desc">收到最新的身心醫學知識</span></div>
      <span class="link-arrow">→</span>
    </a>
  </div>
  <div class="link-banner" style="margin-top:12px">
    <a href="https://buymeacoffee.com/CYlee" class="link-card" target="_blank">
      <span class="link-icon">☕</span>
      <div><span class="link-name">Buy Me a Coffee</span><br/><span class="link-desc">支持迷走神經文獻日報持續運作</span></div>
      <span class="link-arrow">→</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${MODELS[0]}</span>
    <span><a href="https://github.com/u8901006/vagus-nerve">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const apiKey = process.env.ZHIPU_API_KEY || "";
  if (!apiKey) {
    console.error("[ERROR] ZHIPU_API_KEY not set");
    process.exit(1);
  }

  const outPath = OUTPUT;
  if (!outPath) {
    console.error("[ERROR] REPORT_OUTPUT env var required (e.g. docs/vagus-2026-01-01.html)");
    process.exit(1);
  }

  const papersData = loadPapers(INPUT);
  let analysis;

  if (!papersData.papers?.length) {
    console.error("[WARN] No papers, generating empty report");
    analysis = {
      date: papersData.date,
      market_summary: "今日 PubMed 暫無新的迷走神經相關文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    const prompt = buildPrompt(papersData);
    analysis = await analyzeWithRetry(apiKey, prompt);
    if (!analysis) {
      console.error("[ERROR] All models failed");
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf-8");
  console.error(`[INFO] Report saved to ${outPath}`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
