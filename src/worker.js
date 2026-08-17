/**
 * Stremio Addon (Cloudflare Worker)
 * Tu dong tim phu de Tieng Viet cho phim/series tu subtitlecat.com.
 *
 * Luong xu ly khi Stremio hoi subtitle cho 1 IMDB id:
 *  1. Tra ten phim/tap phim qua Cinemeta (Stremio chi gui IMDB id, khong gui ten phim).
 *  2. Tim cac trang subtitlecat.com co the khop (qua DuckDuckGo/Bing, vi subtitlecat
 *     khong co o tim kiem server-side that su).
 *  3. Voi moi trang ung vien, lay tieu de that cua trang do va tinh do tuong dong
 *     (fuzzy match) voi ten phim can tim -> chon trang khop nhat.
 *  4. Neu trang do da co san phu de Tieng Viet (nut "Download") -> tra ve link do luon.
 *  5. Neu chua co (chi co "Translate") -> tai 1 ban phu de nguon (uu tien English),
 *     tu dich toan bo sang Tieng Viet (Google Translate khong can API key),
 *     luu vao Cloudflare KV va phuc vu qua route /srt/:key.srt cua chinh Worker nay.
 *
 * Cache: dung Cloudflare KV de khong phai tim/dich lai nhieu lan cho cung 1 phim.
 */

// ------------------------- Tien ich chung -------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS }
  });
}

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
};

async function fetchText(url, init = {}) {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, ...(init.headers || {}) },
    ...init
  });
  if (!res.ok) return null;
  return await res.text();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------- Do tuong dong ten phim (fuzzy match) -------------------------

function normalizeTitle(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bo dau
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function bigrams(str) {
  const s = `  ${str} `;
  const grams = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  return grams;
}

// He so tuong dong Dice dua tren bigram - nhanh, khong can thu vien ngoai
function diceCoefficient(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ga = bigrams(na);
  const gb = bigrams(nb);
  let intersection = 0;
  let totalA = 0;
  let totalB = 0;
  for (const v of ga.values()) totalA += v;
  for (const v of gb.values()) totalB += v;
  for (const [g, count] of ga.entries()) {
    if (gb.has(g)) intersection += Math.min(count, gb.get(g));
  }
  if (totalA + totalB === 0) return 0;
  return (2 * intersection) / (totalA + totalB);
}

function scoreCandidate(candidateTitle, targetName, season, episode) {
  let score = diceCoefficient(candidateTitle, targetName);

  if (season && episode) {
    const s = pad2(season);
    const e = pad2(episode);
    const patterns = [
      new RegExp(`s0*${season}\\s*e0*${episode}\\b`, 'i'),
      new RegExp(`\\b${season}x${e}\\b`, 'i'),
      new RegExp(`season\\s*0*${season}.*episode\\s*0*${episode}`, 'i')
    ];
    if (patterns.some((re) => re.test(candidateTitle))) {
      score += 0.35;
    } else {
      // series ma khong khop so tap -> tru diem manh, tranh nham tap khac
      score -= 0.25;
    }
  }

  return Math.max(0, Math.min(1, score));
}

// ------------------------- Cinemeta: lay ten phim/tap tu IMDB id -------------------------

async function getCinemetaMeta(type, imdbId) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const raw = await fetchText(url);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && data.meta ? data.meta : null;
  } catch (e) {
    return null;
  }
}

function buildSearchQueries(type, meta, season, episode) {
  const name = (meta.name || '').trim();
  const year = meta.year ? String(meta.year).slice(0, 4) : '';
  const queries = [];

  if (type === 'series' && season && episode) {
    const s = pad2(season);
    const e = pad2(episode);
    queries.push(`${name} S${s}E${e}`);
    queries.push(`${name} ${season}x${e}`);
    queries.push(`${name}`);
  } else {
    if (year) queries.push(`${name} ${year}`);
    queries.push(name);
  }
  return queries;
}

// ------------------------- Tim trang subtitlecat qua cong cu tim kiem -------------------------

function extractSubtitlecatLinks(html) {
  const links = new Set();
  const hrefRegex = /href="([^"]+)"/g;
  let m;
  while ((m = hrefRegex.exec(html)) !== null) {
    let href = m[1].replace(/&amp;/g, '&');

    if (href.includes('uddg=')) {
      try {
        const u = new URL(href, 'https://duckduckgo.com');
        const real = u.searchParams.get('uddg');
        if (real) href = decodeURIComponent(real);
      } catch (e) {
        /* bo qua */
      }
    }

    if (/subtitlecat\.com\/subs\/\d+\/[^"]+\.html/i.test(href)) {
      links.add(href.split('#')[0]);
    }
  }
  return Array.from(links);
}

// Header rieng cho tung cong cu tim kiem de giong trinh duyet that hon,
// giam kha nang bi chan/challenge khi goi tu IP Cloudflare Workers.
const SEARCH_HEADERS = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Ghi lai chi tiet moi lan goi cong cu tim kiem: co loi khong, status, tim duoc bao nhieu link.
// Dung cho ca luc chay that lan luc debug (/debug/subtitles).
async function runSearchEngine(name, url, trace) {
  const entry = { engine: name, url, status: null, error: null, found: 0 };
  trace && trace.push(entry);
  try {
    const res = await fetch(url, { headers: { ...FETCH_HEADERS, ...SEARCH_HEADERS } });
    entry.status = res.status;
    if (!res.ok) return [];
    const html = await res.text();
    const links = extractSubtitlecatLinks(html);
    entry.found = links.length;
    return links;
  } catch (e) {
    entry.error = String(e && e.message ? e.message : e);
    return [];
  }
}

async function searchViaDuckDuckGoLite(query, trace) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(
    'site:subtitlecat.com ' + query
  )}`;
  return runSearchEngine('duckduckgo-lite', url, trace);
}

async function searchViaDuckDuckGoHtml(query, trace) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(
    'site:subtitlecat.com ' + query
  )}`;
  return runSearchEngine('duckduckgo-html', url, trace);
}

async function searchViaBing(query, trace) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(
    'site:subtitlecat.com ' + query
  )}`;
  return runSearchEngine('bing', url, trace);
}

// Thu lan luot nhieu nguon, gop ket qua lai. Khong dung som qua som de tang
// co hoi tim duoc link ke ca khi 1-2 nguon bi chan.
async function collectCandidateUrls(queries, maxCandidates = 8, trace = null) {
  const all = new Set();
  const engines = [searchViaDuckDuckGoLite, searchViaDuckDuckGoHtml, searchViaBing];

  for (const q of queries) {
    for (const engine of engines) {
      try {
        const links = await engine(q, trace);
        links.forEach((u) => all.add(u));
      } catch (e) {
        /* bo qua, thu nguon tiep theo */
      }
      if (all.size >= maxCandidates) break;
    }
    if (all.size >= maxCandidates) break;
  }
  return Array.from(all).slice(0, maxCandidates);
}

// ------------------------- Doc trang chi tiet subtitlecat -------------------------

function extractPageTitle(html) {
  let m = /<h2[^>]*>\s*All language subtitles for\s+([^<]+)<\/h2>/i.exec(html);
  if (m) return m[1].trim();
  m = /<title>[^<]*-\s*([^<]+)<\/title>/i.exec(html);
  if (m) return m[1].trim();
  return '';
}

// Tra ve map { langCode: absoluteSrtUrl } bang cach tim moi lien ket dang "...-<code>.srt"
function extractDownloadMap(html, pageUrl) {
  const map = {};
  const re = /href="([^"]+-([a-zA-Z]{2}(?:-[A-Za-z0-9]{2,4})?)\.srt)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/g, '&');
    const code = m[2];
    try {
      map[code] = encodeURI(new URL(href, pageUrl).toString());
    } catch (e) {
      /* bo qua link loi */
    }
  }
  return map;
}

async function fetchCandidateInfo(pageUrl) {
  const html = await fetchText(pageUrl);
  if (!html) return null;
  const title = extractPageTitle(html);
  const downloadMap = extractDownloadMap(html, pageUrl);
  return { pageUrl, title, downloadMap };
}

// Chon trang subtitlecat khop nhat voi ten phim/tap phim can tim
async function findBestCandidate(type, meta, season, episode, minScore, trace = null) {
  const queries = buildSearchQueries(type, meta, season, episode);
  const candidateUrls = await collectCandidateUrls(queries, 8, trace);

  let best = null;
  let bestScore = 0;
  const candidateScores = [];

  for (const url of candidateUrls) {
    const info = await fetchCandidateInfo(url);
    if (!info || !info.title) {
      candidateScores.push({ url, title: null, score: 0, note: 'khong doc duoc trang' });
      continue;
    }

    const targetLabel =
      type === 'series' && season && episode
        ? `${meta.name} S${pad2(season)}E${pad2(episode)}`
        : `${meta.name} ${meta.year || ''}`.trim();

    const score = scoreCandidate(info.title, targetLabel, season, episode);
    candidateScores.push({ url, title: info.title, score });

    if (score > bestScore) {
      bestScore = score;
      best = info;
    }

    // Da rat khop -> dung som, do bot request
    if (bestScore >= 0.85) break;
  }

  if (trace) trace.candidateScores = candidateScores;

  if (best && bestScore >= minScore) {
    return { ...best, score: bestScore };
  }
  return null;
}

// ------------------------- SRT: parse / rebuild -------------------------

function parseSrt(srtText) {
  const clean = srtText.replace(/\r/g, '').replace(/^\uFEFF/, '');
  const blocks = clean.split(/\n\s*\n/).filter((b) => b.trim());
  const cues = [];

  const timeRe = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;

  for (const block of blocks) {
    const lines = block.split('\n');
    let timeLine = null;
    let timeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (timeRe.test(lines[i])) {
        timeLine = lines[i].match(timeRe);
        timeIdx = i;
        break;
      }
    }
    if (!timeLine) continue;
    const textLines = lines.slice(timeIdx + 1);
    cues.push({
      start: timeLine[1].replace('.', ','),
      end: timeLine[2].replace('.', ','),
      text: textLines.join('\n').trim()
    });
  }
  return cues;
}

function rebuildSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`)
    .join('\n');
}

// ------------------------- Dich sang Tieng Viet (Google Translate, khong can API key) -------------------------

const CUE_DELIMITER = '\n\u2016\n'; // ky tu hiem gap, dung lam ranh gioi giua cac cue khi gop batch

function chunkCues(cues, maxChars = 3500, maxCount = 60) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const cue of cues) {
    const piece = cue.text || ' ';
    const addLen = piece.length + CUE_DELIMITER.length;
    if (
      current.length > 0 &&
      (currentLen + addLen > maxChars || current.length >= maxCount)
    ) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(cue);
    currentLen += addLen;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translateTextGoogle(textToTranslate, targetLang = 'vi', sourceLang = 'auto') {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=${encodeURIComponent(sourceLang)}` +
    `&tl=${encodeURIComponent(targetLang)}` +
    '&dt=t&q=' +
    encodeURIComponent(textToTranslate);

  const raw = await fetchText(url);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    // data[0] la mang cac doan da duoc Google tach cau; ghep lai theo dung thu tu
    const segments = data[0] || [];
    return segments.map((seg) => seg[0]).join('');
  } catch (e) {
    return null;
  }
}

async function translateCuesBatch(cues, targetLang = 'vi') {
  const joined = cues.map((c) => c.text.replace(/\n/g, ' ')).join(CUE_DELIMITER);
  const translated = await translateTextGoogle(joined, targetLang);
  if (!translated) return null;

  const parts = translated.split(/\n?\s*\u2016\s*\n?/);
  if (parts.length !== cues.length) return null; // khong khop -> de code goi lai dich tung cau

  return parts.map((p) => p.trim());
}

async function translateCuesOneByOne(cues, targetLang = 'vi') {
  const results = [];
  for (const cue of cues) {
    const t = await translateTextGoogle(cue.text.replace(/\n/g, ' '), targetLang);
    results.push(t || cue.text);
    await sleep(120);
  }
  return results;
}

async function translateSrtToVietnamese(srtText) {
  const cues = parseSrt(srtText);
  if (!cues.length) return null;

  const chunks = chunkCues(cues);
  const translatedCues = [];

  // Dich song song theo tung nhom nho de tang toc nhung khong qua tai
  const CONCURRENCY = 4;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const group = chunks.slice(i, i + CONCURRENCY);
    const groupResults = await Promise.all(
      group.map(async (chunk) => {
        let texts = await translateCuesBatch(chunk, 'vi');
        if (!texts) {
          texts = await translateCuesOneByOne(chunk, 'vi');
        }
        return chunk.map((cue, idx) => ({
          start: cue.start,
          end: cue.end,
          text: texts[idx] || cue.text
        }));
      })
    );
    groupResults.forEach((cuesArr) => translatedCues.push(...cuesArr));
    await sleep(150);
  }

  return rebuildSrt(translatedCues);
}

// ------------------------- Nguon phu de goc uu tien de dich -------------------------

const SOURCE_LANG_PRIORITY = ['en', 'es', 'fr', 'pt-BR', 'de', 'ru', 'zh-CN'];

function pickSourceLanguage(downloadMap) {
  for (const code of SOURCE_LANG_PRIORITY) {
    if (downloadMap[code]) return code;
  }
  const codes = Object.keys(downloadMap).filter((c) => c !== 'vi');
  return codes[0] || null;
}

// ------------------------- Ham tong hop: tim / dich phu de Viet -------------------------

function decisionKey(type, imdbId, season, episode) {
  return `decision:${type}:${imdbId}:${season || 0}:${episode || 0}`;
}

function subtitleKey(type, imdbId, season, episode) {
  return `srt:${type}:${imdbId}:${season || 0}:${episode || 0}`;
}

async function resolveVietnameseSubtitle(env, type, imdbId, season, episode, workerBaseUrl) {
  const dKey = decisionKey(type, imdbId, season, episode);

  const cachedRaw = await env.SUBCAT_KV.get(dKey);
  if (cachedRaw) {
    try {
      return JSON.parse(cachedRaw);
    } catch (e) {
      /* cache hong, tinh lai */
    }
  }

  const minScore = parseFloat(env.MIN_MATCH_SCORE || '0.35');
  const decisionTtl = parseInt(env.DECISION_TTL_SECONDS || '43200', 10);
  const subtitleTtl = parseInt(env.SUBTITLE_TTL_SECONDS || '2592000', 10);

  let result = { found: false };

  try {
    const meta = await getCinemetaMeta(type, imdbId);
    if (meta) {
      const best = await findBestCandidate(type, meta, season, episode, minScore);

      if (best) {
        if (best.downloadMap.vi) {
          // Da co san phu de Viet -> dung luon, khong can dich
          result = { found: true, url: best.downloadMap.vi, source: 'direct', matchScore: best.score };
        } else {
          // Chua co ban Viet -> tu tai ban goc + tu dich
          const srcLang = pickSourceLanguage(best.downloadMap);
          if (srcLang) {
            const srcSrtText = await fetchText(best.downloadMap[srcLang]);
            if (srcSrtText) {
              const translatedSrt = await translateSrtToVietnamese(srcSrtText);
              if (translatedSrt && translatedSrt.trim()) {
                const sKey = subtitleKey(type, imdbId, season, episode);
                await env.SUBCAT_KV.put(sKey, translatedSrt, {
                  expirationTtl: subtitleTtl
                });
                result = {
                  found: true,
                  url: `${workerBaseUrl}/srt/${encodeURIComponent(sKey)}.srt`,
                  source: 'auto-translated',
                  translatedFrom: srcLang,
                  matchScore: best.score
                };
              }
            }
          }
        }
      }
    }
  } catch (err) {
    result = { found: false, error: String(err && err.message ? err.message : err) };
  }

  // Cache ket qua (ke ca truong hop khong tim thay) de tranh spam tim kiem lien tuc
  await env.SUBCAT_KV.put(dKey, JSON.stringify(result), {
    expirationTtl: result.found ? decisionTtl : 60 * 30
  });

  return result;
}

// ------------------------- Manifest & routing -------------------------

const MANIFEST = {
  id: 'org.subtitlecat.vi.autosub',
  version: '2.0.0',
  name: 'SubtitleCat VI Auto',
  description:
    'Tu dong tim (fuzzy-match ten phim) va tu dong dich phu de Tieng Viet tu subtitlecat.com khi chua co san',
  logo: 'https://subtitlecat.com/favicon_large.jpg',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

function parseSubtitleIdParam(idParam) {
  const decoded = decodeURIComponent(idParam);
  const parts = decoded.split(':');
  const imdbId = parts[0];
  const season = parts[1] ? parseInt(parts[1], 10) : undefined;
  const episode = parts[2] ? parseInt(parts[2], 10) : undefined;
  return { imdbId, season, episode };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (pathname === '/' || pathname === '') {
      return text(
        'SubtitleCat VI Auto - Stremio addon.\nCai vao Stremio bang: ' +
          `${url.origin}/manifest.json`
      );
    }

    if (pathname === '/manifest.json') {
      return json(MANIFEST);
    }

    // /subtitles/{type}/{id}.json  hoac  /subtitles/{type}/{id}/{extra}.json
    const subMatch = pathname.match(
      /^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/
    );
    if (subMatch) {
      const type = subMatch[1];
      const rawId = subMatch[2];
      const { imdbId, season, episode } = parseSubtitleIdParam(rawId);

      if (!/^tt\d+/.test(imdbId)) {
        return json({ subtitles: [] });
      }

      const result = await resolveVietnameseSubtitle(
        env,
        type,
        imdbId,
        season,
        episode,
        url.origin
      );

      if (!result.found) {
        return json({ subtitles: [] });
      }

      return json({
        subtitles: [
          {
            id: `subtitlecat-vi-${imdbId}-${season || 0}-${episode || 0}`,
            url: result.url,
            lang: 'vie'
          }
        ]
      });
    }

    // Route debug: xem chi tiet tung buoc xu ly (Cinemeta, cac cong cu tim kiem,
    // diem so tung ung vien, downloadMap...) ma khong can xem log Cloudflare.
    // Vi du: /debug/subtitles?type=movie&id=tt0111161
    if (pathname === '/debug/subtitles') {
      const type = url.searchParams.get('type') === 'series' ? 'series' : 'movie';
      const rawId = url.searchParams.get('id') || '';
      const { imdbId, season, episode } = parseSubtitleIdParam(rawId);

      const debugInfo = {
        input: { type, rawId, imdbId, season, episode },
        meta: null,
        queries: [],
        searchTrace: [],
        candidateScores: [],
        best: null,
        result: null
      };

      if (!/^tt\d+/.test(imdbId)) {
        debugInfo.error = 'id khong hop le, vi du dung: ?type=movie&id=tt0111161';
        return json(debugInfo, 400);
      }

      const minScore = parseFloat(env.MIN_MATCH_SCORE || '0.35');
      const meta = await getCinemetaMeta(type, imdbId);
      debugInfo.meta = meta;

      if (meta) {
        debugInfo.queries = buildSearchQueries(type, meta, season, episode);
        const trace = [];
        const best = await findBestCandidate(type, meta, season, episode, minScore, trace);
        debugInfo.searchTrace = trace;
        debugInfo.candidateScores = trace.candidateScores || [];
        debugInfo.best = best
          ? {
              pageUrl: best.pageUrl,
              title: best.title,
              score: best.score,
              downloadMap: best.downloadMap
            }
          : null;
      }

      if (url.searchParams.get('nocache') === '1') {
        await env.SUBCAT_KV.delete(decisionKey(type, imdbId, season, episode));
      }

      // Chay luon ham chinh (co dung cache) de xem ket qua cuoi cung addon se tra ve
      debugInfo.result = await resolveVietnameseSubtitle(
        env,
        type,
        imdbId,
        season,
        episode,
        url.origin
      );

      return json(debugInfo);
    }

    // Phuc vu file .srt da duoc tu dong dich, luu trong KV
    const srtMatch = pathname.match(/^\/srt\/([^/]+)\.srt$/);
    if (srtMatch) {
      const key = decodeURIComponent(srtMatch[1]);
      const content = await env.SUBCAT_KV.get(key);
      if (!content) {
        return text('Khong tim thay phu de (co the da het han cache).', 404);
      }
      return text(content, 200, 'application/x-subrip; charset=utf-8');
    }

    return text('Not found', 404);
  }
};
