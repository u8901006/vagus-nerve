#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const SEARCH_QUERIES = [
  {
    name: "core-vagus",
    q: '("Vagus Nerve"[Mesh] OR "vagus nerve"[tiab] OR vagal[tiab] OR "vagal afferent*"[tiab] OR "vagal efferent*"[tiab] OR "parasympathetic nervous system"[tiab] OR "autonomic nervous system"[tiab])',
  },
  {
    name: "vns",
    q: '("Vagus Nerve Stimulation"[Mesh] OR "vagus nerve stimulation"[tiab] OR VNS[tiab] OR taVNS[tiab] OR "auricular vagus nerve stimulation"[tiab] OR "non-invasive vagus nerve stimulation"[tiab] OR nVNS[tiab] OR "bioelectronic medicine"[tiab])',
  },
  {
    name: "hrv-vagal",
    q: '("Heart Rate Variability"[Mesh] OR "heart rate variability"[tiab] OR HRV[tiab] OR "vagal tone"[tiab] OR "cardiac vagal tone"[tiab] OR "respiratory sinus arrhythmia"[tiab] OR RSA[tiab] OR RMSSD[tiab] OR "parasympathetic activity"[tiab])',
  },
  {
    name: "gut-brain",
    q: '("gut-brain axis"[tiab] OR "brain-gut axis"[tiab] OR "microbiota-gut-brain axis"[tiab] OR microbiome[tiab] OR microbiota[tiab] OR "short-chain fatty acids"[tiab] OR SCFA[tiab] OR "gut hormones"[tiab] OR ghrelin[tiab] OR leptin[tiab] OR "GLP-1"[tiab])',
  },
  {
    name: "inflammation",
    q: '(inflammation[tiab] OR inflammatory[tiab] OR cytokine*[tiab] OR "TNF-alpha"[tiab] OR "IL-6"[tiab] OR "C-reactive protein"[tiab] OR "cholinergic anti-inflammatory pathway"[tiab] OR "inflammatory reflex"[tiab] OR neuroimmune[tiab])',
  },
];

const TOPIC_COMBOS = [
  '(depression[tiab] OR "treatment-resistant depression"[tiab] OR anxiety[tiab] OR panic[tiab] OR PTSD[tiab] OR trauma[tiab] OR stress[tiab] OR "emotion regulation"[tiab] OR "self-regulation"[tiab] OR interoception[tiab] OR dissociation[tiab] OR sleep[tiab])',
  '("social determinants"[tiab] OR "socioeconomic status"[tiab] OR loneliness[tiab] OR "social isolation"[tiab] OR discrimination[tiab] OR "childhood adversity"[tiab])',
  '(nutrition[tiab] OR diet[tiab] OR appetite[tiab] OR satiety[tiab] OR obesity[tiab] OR probiotic*[tiab] OR prebiotic*[tiab] OR "Mediterranean diet"[tiab])',
  '(exercise[tiab] OR "physical activity"[tiab] OR "aerobic training"[tiab] OR recovery[tiab] OR overtraining[tiab] OR yoga[tiab] OR breathwork[tiab] OR "slow breathing"[tiab])',
  '("chronic pain"[tiab] OR fibromyalgia[tiab] OR "irritable bowel syndrome"[tiab] OR IBS[tiab] OR "inflammatory bowel disease"[tiab] OR IBD[tiab] OR "autonomic dysfunction"[tiab])',
];

const DAYS = parseInt(process.env.FETCH_DAYS || "7", 10);
const MAX_PAPERS = parseInt(process.env.MAX_PAPERS || "60", 10);
const OUTPUT = process.env.PAPERS_OUTPUT || "papers.json";
const UA = { "User-Agent": "VagusNerveBot/1.0 (research aggregator)" };

function dateFilter(days) {
  const d = new Date(Date.now() - days * 86400000);
  const s = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  return `"${s}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function pmSearch(term, retmax = 30) {
  const u = new URL(PUBMED_SEARCH);
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("term", term);
  u.searchParams.set("retmax", String(retmax));
  u.searchParams.set("sort", "date");
  u.searchParams.set("retmode", "json");
  const r = await fetch(u.toString(), { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j?.esearchresult?.idlist || [];
}

function xmlText(parent, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = parent.match(re);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").trim();
}

function parseArticles(xml) {
  const papers = [];
  const chunks = xml.split(/<PubmedArticle>/).slice(1);
  for (const chunk of chunks) {
    const title = xmlText(chunk, "ArticleTitle");
    const journal = xmlText(chunk, "Title");
    const pmid = xmlText(chunk, "PMID");
    const year = xmlText(chunk, "Year");
    const month = xmlText(chunk, "Month");
    const day = xmlText(chunk, "Day");
    const dateStr = [year, month, day].filter(Boolean).join(" ");

    let abstract = "";
    const absMatch = chunk.match(/<Abstract>([\\s\\S]*?)<\/Abstract>/i);
    if (absMatch) {
      const texts = [];
      const absChunks = absMatch[1].split(/<AbstractText/).slice(1);
      for (const ac of absChunks) {
        const labelM = ac.match(/Label="([^"]*)"/);
        const label = labelM ? labelM[1] : "";
        const closeIdx = ac.indexOf(">");
        if (closeIdx === -1) continue;
        const inner = ac.slice(closeIdx + 1);
        const text = inner.replace(/<[^>]+>/g, "").replace(/<\/AbstractText>[\s\S]*/, "").trim();
        if (label && text) texts.push(`${label}: ${text}`);
        else if (text) texts.push(text);
      }
      abstract = texts.join(" ").slice(0, 2000);
    }

    const keywords = [];
    const kwMatches = chunk.matchAll(/<Keyword[^>]*>([\s\S]*?)<\/Keyword>/g);
    for (const km of kwMatches) {
      const kw = km[1].replace(/<[^>]+>/g, "").trim();
      if (kw) keywords.push(kw);
    }

    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";
    papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
  }
  return papers;
}

async function pmFetch(pmids) {
  if (!pmids.length) return [];
  const u = new URL(PUBMED_FETCH);
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("id", pmids.join(","));
  u.searchParams.set("retmode", "xml");
  const r = await fetch(u.toString(), { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  return parseArticles(xml);
}

async function main() {
  const df = dateFilter(DAYS);
  const seen = new Set();
  let allPmids = [];

  const perSearch = Math.ceil(MAX_PAPERS / (SEARCH_QUERIES.length * TOPIC_COMBOS.length)) + 3;

  for (const sq of SEARCH_QUERIES) {
    for (const topic of TOPIC_COMBOS) {
      const query = `(${sq.q}) AND (${topic}) AND ${df}`;
      try {
        const ids = await pmSearch(query, perSearch);
        for (const id of ids) {
          if (!seen.has(id)) { seen.add(id); allPmids.push(id); }
        }
        await sleep(350);
      } catch (e) {
        console.error(`[WARN] Search ${sq.name} failed: ${e.message}`);
      }
    }
  }

  console.error(`[INFO] Found ${allPmids.length} unique PMIDs`);
  allPmids = allPmids.slice(0, MAX_PAPERS);

  if (!allPmids.length) {
    console.error("[WARN] No papers found");
    const empty = {
      date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }),
      count: 0, papers: [],
    };
    writeFileSync(OUTPUT, JSON.stringify(empty, null, 2), "utf-8");
    return;
  }

  let allPapers = [];
  for (let i = 0; i < allPmids.length; i += 50) {
    const batch = allPmids.slice(i, i + 50);
    try {
      const papers = await pmFetch(batch);
      allPapers = allPapers.concat(papers);
      await sleep(400);
    } catch (e) {
      console.error(`[WARN] Fetch batch failed: ${e.message}`);
    }
  }

  const dedup = new Map();
  for (const p of allPapers) {
    if (p.pmid && !dedup.has(p.pmid)) dedup.set(p.pmid, p);
  }
  allPapers = [...dedup.values()];

  const output = {
    date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }),
    count: allPapers.length,
    papers: allPapers,
  };

  writeFileSync(OUTPUT, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved ${allPapers.length} papers to ${OUTPUT}`);
}

main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
