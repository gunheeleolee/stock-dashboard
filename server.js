require('dotenv').config({ override: true });
const express = require('express');
const RSSParser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const parser = new RSSParser();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const IS_VERCEL = process.env.VERCEL === '1';
const CACHE_DURATION = 30 * 60 * 1000;
const MARKET_CACHE_DURATION = 5 * 60 * 1000;

// ==========================================
// CRYPTO
// ==========================================
const cryptoState = { memoryCache: [], lastFetched: null, marketCache: null, marketLastFetched: null };

const CRYPTO_SOURCES = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' }
];

async function cryptoFetchMarket() {
  const now = Date.now();
  if (cryptoState.marketLastFetched && now - cryptoState.marketLastFetched < MARKET_CACHE_DURATION && cryptoState.marketCache) {
    return cryptoState.marketCache;
  }
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,binancecoin&vs_currencies=usd&include_24hr_change=true'
    );
    const data = response.data;
    cryptoState.marketCache = [
      { symbol: 'BTC', price: data.bitcoin?.usd, change: data.bitcoin?.usd_24h_change },
      { symbol: 'ETH', price: data.ethereum?.usd, change: data.ethereum?.usd_24h_change },
      { symbol: 'SOL', price: data.solana?.usd, change: data.solana?.usd_24h_change },
      { symbol: 'XRP', price: data.ripple?.usd, change: data.ripple?.usd_24h_change },
      { symbol: 'BNB', price: data.binancecoin?.usd, change: data.binancecoin?.usd_24h_change },
    ];
    cryptoState.marketLastFetched = now;
    return cryptoState.marketCache;
  } catch (e) {
    console.log('Crypto 시장 데이터 실패:', e.message);
    return [];
  }
}

async function cryptoFetchFearGreed() {
  try {
    const response = await axios.get('https://api.alternative.me/fng/');
    const data = response.data.data[0];
    return { value: parseInt(data.value), classification: data.value_classification };
  } catch (e) {
    console.log('Crypto Fear & Greed 실패:', e.message);
    return null;
  }
}

async function cryptoTranslateSummarizeAndScore(title, content) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `아래 영어 기사를 한국어로 처리하고 분석해줘.

제목: ${title}
본문: ${content}

아래 형식으로만 출력해줘:
번역제목: (제목을 자연스러운 한국어로 번역)
요약: (본문을 한국어로 5문장 내외로 요약. 핵심 내용을 충실하게 담아줘)
중요도: (1~5 숫자만. 기준: 5=규제/정책/시장 전체 영향, 4=주요 기관/대형 거래, 3=일반 시장 동향, 2=특정 코인/프로젝트, 1=단순 정보)
시그널: (긍정 또는 부정 또는 중립 중 하나만)
태그: (기사에서 언급된 코인 심볼만. 예: BTC,ETH,SOL / 없으면 없음)`
    }]
  });
  return message.content[0].text;
}

async function cryptoFetchAllNews() {
  const now = Date.now();
  if (cryptoState.lastFetched && now - cryptoState.lastFetched < CACHE_DURATION && cryptoState.memoryCache.length > 0) {
    return cryptoState.memoryCache;
  }

  const { data: existingArticles } = await supabase.from('articles').select('url');
  const existingUrls = new Set((existingArticles || []).map(a => a.url));

  for (const source of CRYPTO_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 5)) {
        if (existingUrls.has(item.link)) continue;
        const content = item.contentSnippet || item.content || '본문 없음';
        const result = await cryptoTranslateSummarizeAndScore(item.title, content);
        const lines = result.split('\n').filter(l => l.trim());
        const koreanTitle = lines.find(l => l.startsWith('번역제목:'))?.replace('번역제목:', '').trim();
        const summary = lines.find(l => l.startsWith('요약:'))?.replace('요약:', '').trim();
        const score = parseInt(lines.find(l => l.startsWith('중요도:'))?.replace('중요도:', '').trim()) || 3;
        const signal = lines.find(l => l.startsWith('시그널:'))?.replace('시그널:', '').trim();
        const tagText = lines.find(l => l.startsWith('태그:'))?.replace('태그:', '').trim();
        const tags = tagText && tagText !== '없음' ? tagText.split(',').map(t => t.trim()) : [];
        await supabase.from('articles').insert({
          url: item.link, original_title: item.title, korean_title: koreanTitle,
          summary, source: source.name, score, signal, tags, pub_date: item.pubDate
        });
      }
    } catch (e) { console.log(`${source.name} RSS 실패:`, e.message); }
  }

  const { data: allArticles } = await supabase.from('articles').select('*')
    .order('score', { ascending: false }).order('pub_date', { ascending: false }).limit(50);

  cryptoState.memoryCache = (allArticles || []).map(a => ({
    originalTitle: a.original_title, koreanTitle: a.korean_title, summary: a.summary,
    link: a.url, date: a.pub_date, source: a.source, score: a.score, signal: a.signal, tags: a.tags || []
  }));
  cryptoState.lastFetched = now;
  return cryptoState.memoryCache;
}

async function cryptoGenerateAnalysis(news, fearGreed) {
  const signalCount = {
    긍정: news.filter(n => n.signal === '긍정').length,
    부정: news.filter(n => n.signal === '부정').length,
    중립: news.filter(n => n.signal === '중립').length
  };
  const topNews = news.slice(0, 5).map((n, i) => `${i + 1}. [${n.signal}] ${n.koreanTitle}`).join('\n');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    messages: [{ role: 'user', content: `아래 데이터를 기반으로 크립토 시장 단기 방향성을 분석해줘.

공포탐욕지수: ${fearGreed?.value || '알 수 없음'} (${fearGreed?.classification || ''})
뉴스 시그널: 긍정 ${signalCount.긍정}건, 부정 ${signalCount.부정}건, 중립 ${signalCount.중립}건
주요 뉴스:
${topNews}

아래 형식으로만 출력해줘:
방향성: (강한상승 또는 약한상승 또는 중립 또는 약한하락 또는 강한하락 중 하나)
분석: (2~3문장으로 핵심만. 왜 이런 방향성인지 근거 포함)
주목변수: (오늘 가장 주목해야 할 변수 한 줄)` }]
  });
  return message.content[0].text;
}

async function cryptoGenerateBrief(news) {
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase.from('briefs').select('*').eq('brief_date', today).single();
  const latestArticleTime = news[0]?.date ? new Date(news[0].date).getTime() : 0;
  if (existing && new Date(existing.created_at).getTime() > latestArticleTime) {
    return { briefText: existing.brief_text, picks: existing.picks };
  }
  const articleSummaries = news.slice(0, 5).map((item, i) => `${i + 1}. ${item.koreanTitle} (${item.source}, ${item.signal})`).join('\n');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 500,
    messages: [{ role: 'user', content: `아래는 오늘의 주요 크립토 뉴스야.

${articleSummaries}

아래 형식으로만 출력해줘:
브리핑: (오늘 크립토 시장 전반을 3~4문장으로 핵심만 요약. 날카롭고 임팩트 있게)
픽1: (꼭 읽어야 할 기사 제목 1개)
픽2: (꼭 읽어야 할 기사 제목 1개)
픽3: (꼭 읽어야 할 기사 제목 1개)` }]
  });
  const brief = message.content[0].text;
  const briefLines = brief.split('\n').filter(l => l.trim());
  const briefText = briefLines.find(l => l.startsWith('브리핑:'))?.replace('브리핑:', '').trim();
  const picks = [1, 2, 3].map(i => briefLines.find(l => l.startsWith(`픽${i}:`))?.replace(`픽${i}:`, '').trim()).filter(Boolean);
  await supabase.from('briefs').upsert({ brief_date: today, brief_text: briefText, picks, created_at: new Date().toISOString() }, { onConflict: 'brief_date' });
  return { briefText, picks };
}

// ==========================================
// US STOCK
// ==========================================
const usState = { memoryCache: [], lastFetched: null, marketCache: null, marketLastFetched: null, insiderCache: null, insiderLastFetched: null };

const US_SOURCES = [
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'Seeking Alpha', url: 'https://seekingalpha.com/feed.xml' },
  { name: 'Benzinga', url: 'https://www.benzinga.com/feed' },
];

async function usFetchMarket() {
  const now = Date.now();
  if (usState.marketLastFetched && now - usState.marketLastFetched < MARKET_CACHE_DURATION && usState.marketCache) {
    return usState.marketCache;
  }
  try {
    const symbols = ['^GSPC', '^IXIC', '^DJI', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'META'];
    const response = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    const data = response.data;
    const SYMBOL_NAMES = { '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ', '^DJI': 'DOW' };
    usState.marketCache = symbols.map(sym => {
      const info = data[sym];
      if (!info) return null;
      const close = info.close?.[info.close.length - 1];
      const prevClose = info.chartPreviousClose;
      const change = prevClose ? ((close - prevClose) / prevClose * 100) : 0;
      return { symbol: SYMBOL_NAMES[sym] || sym, price: close, change, isIndex: sym.startsWith('^') };
    }).filter(Boolean);
    usState.marketLastFetched = now;
    return usState.marketCache;
  } catch (e) {
    console.log('US 시장 데이터 실패:', e.message);
    return [];
  }
}

async function usFetchFearGreed() {
  try {
    const response = await axios.get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    const data = response.data?.fear_and_greed;
    if (data) return { value: Math.round(data.score), classification: data.rating };
    return null;
  } catch (e) {
    console.log('US Fear & Greed 실패:', e.message);
    return null;
  }
}

async function usTranslateSummarizeAndScore(title, content) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    messages: [{ role: 'user', content: `아래 영어 기사를 한국어로 처리하고 분석해줘.

제목: ${title}
본문: ${content}

아래 형식으로만 출력해줘:
번역제목: (제목을 자연스러운 한국어로 번역)
요약: (본문을 한국어로 5문장 내외로 요약. 핵심 내용을 충실하게 담아줘)
중요도: (1~5 숫자만. 기준: 5=연준 정책/규제 변화/시장 전체 영향, 4=대형 실적발표/M&A/주요 기관 동향, 3=섹터 트렌드/일반 시장 동향, 2=개별 종목/특정 기업 뉴스, 1=단순 정보/오피니언)
시그널: (긍정 또는 부정 또는 중립 중 하나만)
태그: (기사에서 언급된 종목 티커 또는 섹터. 예: AAPL,NVDA,기술주 / 없으면 없음)` }]
  });
  return message.content[0].text;
}

async function usFetchAllNews() {
  const now = Date.now();
  if (usState.lastFetched && now - usState.lastFetched < CACHE_DURATION && usState.memoryCache.length > 0) {
    return usState.memoryCache;
  }

  const { data: existingArticles } = await supabase.from('us_articles').select('url');
  const existingUrls = new Set((existingArticles || []).map(a => a.url));

  for (const source of US_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 5)) {
        if (existingUrls.has(item.link)) continue;
        const content = item.contentSnippet || item.content || '';
        if (!content || content.trim().length < 50) continue;
        const result = await usTranslateSummarizeAndScore(item.title, content);
        const lines = result.split('\n').filter(l => l.trim());
        const koreanTitle = lines.find(l => l.startsWith('번역제목:'))?.replace('번역제목:', '').trim();
        const summary = lines.find(l => l.startsWith('요약:'))?.replace('요약:', '').trim();
        const score = parseInt(lines.find(l => l.startsWith('중요도:'))?.replace('중요도:', '').trim()) || 3;
        const signal = lines.find(l => l.startsWith('시그널:'))?.replace('시그널:', '').trim();
        const tagText = lines.find(l => l.startsWith('태그:'))?.replace('태그:', '').trim();
        const tags = tagText && tagText !== '없음' ? tagText.split(',').map(t => t.trim()) : [];
        await supabase.from('us_articles').insert({
          url: item.link, original_title: item.title, korean_title: koreanTitle,
          summary, source: source.name, score, signal, tags, pub_date: item.pubDate
        });
      }
    } catch (e) { console.log(`${source.name} RSS 실패:`, e.message); }
  }

  const { data: allArticles } = await supabase.from('us_articles').select('*')
    .order('score', { ascending: false }).order('pub_date', { ascending: false }).limit(50);

  usState.memoryCache = (allArticles || []).map(a => ({
    originalTitle: a.original_title, koreanTitle: a.korean_title, summary: a.summary,
    link: a.url, date: a.pub_date, source: a.source, score: a.score, signal: a.signal, tags: a.tags || []
  }));
  usState.lastFetched = now;
  return usState.memoryCache;
}

async function usGenerateAnalysis(news, fearGreed) {
  const signalCount = {
    긍정: news.filter(n => n.signal === '긍정').length,
    부정: news.filter(n => n.signal === '부정').length,
    중립: news.filter(n => n.signal === '중립').length
  };
  const topNews = news.slice(0, 5).map((n, i) => `${i + 1}. [${n.signal}] ${n.koreanTitle}`).join('\n');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    messages: [{ role: 'user', content: `아래 데이터를 기반으로 미국 주식 시장 단기 방향성을 분석해줘.

공포탐욕지수: ${fearGreed?.value || '알 수 없음'} (${fearGreed?.classification || ''})
뉴스 시그널: 긍정 ${signalCount.긍정}건, 부정 ${signalCount.부정}건, 중립 ${signalCount.중립}건
주요 뉴스:
${topNews}

아래 형식으로만 출력해줘:
방향성: (강한상승 또는 약한상승 또는 중립 또는 약한하락 또는 강한하락 중 하나)
분석: (2~3문장으로 핵심만. 왜 이런 방향성인지 근거 포함)
주목변수: (오늘 가장 주목해야 할 변수 한 줄)` }]
  });
  return message.content[0].text;
}

async function usGenerateBrief(news) {
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase.from('us_briefs').select('*').eq('brief_date', today).single();
  const latestArticleTime = news[0]?.date ? new Date(news[0].date).getTime() : 0;
  if (existing && new Date(existing.created_at).getTime() > latestArticleTime) {
    return { briefText: existing.brief_text, picks: existing.picks };
  }
  const articleSummaries = news.slice(0, 5).map((item, i) => `${i + 1}. ${item.koreanTitle} (${item.source}, ${item.signal})`).join('\n');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 500,
    messages: [{ role: 'user', content: `아래는 오늘의 주요 미국 주식 뉴스야.

${articleSummaries}

아래 형식으로만 출력해줘:
브리핑: (오늘 미국 주식 시장 전반을 3~4문장으로 핵심만 요약. 날카롭고 임팩트 있게)
픽1: (꼭 읽어야 할 기사 제목 1개)
픽2: (꼭 읽어야 할 기사 제목 1개)
픽3: (꼭 읽어야 할 기사 제목 1개)` }]
  });
  const brief = message.content[0].text;
  const briefLines = brief.split('\n').filter(l => l.trim());
  const briefText = briefLines.find(l => l.startsWith('브리핑:'))?.replace('브리핑:', '').trim();
  const picks = [1, 2, 3].map(i => briefLines.find(l => l.startsWith(`픽${i}:`))?.replace(`픽${i}:`, '').trim()).filter(Boolean);
  await supabase.from('us_briefs').upsert({ brief_date: today, brief_text: briefText, picks, created_at: new Date().toISOString() }, { onConflict: 'brief_date' });
  return { briefText, picks };
}

// SEC 내부자 거래
const TRACKED_CIKS = {
  '0000320193': 'AAPL', '0000789019': 'MSFT', '0001045810': 'NVDA',
  '0001652044': 'GOOGL', '0001018724': 'AMZN', '0001318605': 'TSLA', '0001326801': 'META'
};

async function usFetchInsiderTrades() {
  const now = Date.now();
  if (usState.insiderLastFetched && now - usState.insiderLastFetched < CACHE_DURATION && usState.insiderCache) {
    return usState.insiderCache;
  }
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const cikQuery = Object.keys(TRACKED_CIKS).map(c => `"${c}"`).join(' OR ');
    const response = await axios.get(
      `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&q=${encodeURIComponent(cikQuery)}`,
      { headers: { 'User-Agent': 'StockDashboard contact@example.com' } }
    );
    const filings = response.data?.hits?.hits || [];
    const trades = [];
    for (const filing of filings.slice(0, 10)) {
      try {
        const src = filing._source;
        const companyCik = src.ciks.find(c => TRACKED_CIKS[c]);
        if (!companyCik) continue;
        const ticker = TRACKED_CIKS[companyCik];
        const adsh = src.adsh;
        const cikNum = companyCik.replace(/^0+/, '');
        const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adsh.replace(/-/g, '')}/index.json`;
        const indexRes = await axios.get(indexUrl, { headers: { 'User-Agent': 'StockDashboard contact@example.com' } });
        const xmlFile = indexRes.data.directory.item.find(i => i.name.endsWith('.xml') && i.name !== 'primary_doc.xml');
        if (!xmlFile) continue;
        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adsh.replace(/-/g, '')}/${xmlFile.name}`;
        const xmlRes = await axios.get(xmlUrl, { headers: { 'User-Agent': 'StockDashboard contact@example.com' } });
        const xml = xmlRes.data;
        const ownerName = xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/)?.[1] || '';
        const officerTitle = xml.match(/<officerTitle>(.*?)<\/officerTitle>/)?.[1] || '';
        const isDirector = xml.includes('<isDirector>1</isDirector>');
        const shares = xml.match(/<transactionShares>\s*<value>(.*?)<\/value>/)?.[1] || '';
        const pricePerShare = xml.match(/<transactionPricePerShare>\s*<value>(.*?)<\/value>/)?.[1] || '';
        const acquiredDisposed = xml.match(/<transactionAcquiredDisposedCode>\s*<value>(.*?)<\/value>/)?.[1] || '';
        const isBuy = acquiredDisposed === 'A';
        const totalValue = shares && pricePerShare ? (parseFloat(shares) * parseFloat(pricePerShare)) : 0;
        trades.push({
          ticker, owner: ownerName, title: officerTitle || (isDirector ? 'Director' : 'Insider'),
          type: isBuy ? '매수' : '매도', shares: parseInt(shares) || 0,
          price: parseFloat(pricePerShare) || 0, totalValue: Math.round(totalValue),
          date: src.file_date
        });
      } catch (e) { /* skip */ }
    }
    usState.insiderCache = trades.filter(t => t.totalValue > 0).sort((a, b) => b.totalValue - a.totalValue);
    usState.insiderLastFetched = now;
    return usState.insiderCache;
  } catch (e) {
    console.log('내부자 거래 실패:', e.message);
    return [];
  }
}

// ==========================================
// KR STOCK
// ==========================================
const krState = { memoryCache: [], lastFetched: null, marketCache: null, marketLastFetched: null, dartCache: null, dartLastFetched: null };

const KR_SOURCES = [
  { name: '한국경제', url: 'https://www.hankyung.com/feed/all-news' },
  { name: '매일경제', url: 'https://www.mk.co.kr/rss/30000001/' },
  { name: '연합인포맥스', url: 'https://news.einfomax.co.kr/rss/S1N1.xml' },
  { name: '뉴스핌', url: 'https://www.newspim.com/rss' },
  { name: '이데일리', url: 'https://www.edaily.co.kr/rss/edaily_news.xml' },
];

async function krFetchMarket() {
  const now = Date.now();
  if (krState.marketLastFetched && now - krState.marketLastFetched < MARKET_CACHE_DURATION && krState.marketCache) {
    return krState.marketCache;
  }
  try {
    const symbols = ['^KS11', '^KQ11', '005930.KS', '000660.KS', '373220.KS', '005380.KS', '035420.KS', '035720.KS', '006400.KS'];
    const response = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    const data = response.data;
    const SYMBOL_NAMES = {
      '^KS11': 'KOSPI', '^KQ11': 'KOSDAQ',
      '005930.KS': '삼성전자', '000660.KS': 'SK하이닉스', '373220.KS': 'LG에솔',
      '005380.KS': '현대차', '035420.KS': 'NAVER', '035720.KS': '카카오', '006400.KS': '삼성SDI'
    };
    krState.marketCache = symbols.map(sym => {
      const info = data[sym];
      if (!info) return null;
      const close = info.close?.[info.close.length - 1];
      const prevClose = info.chartPreviousClose;
      const change = prevClose ? ((close - prevClose) / prevClose * 100) : 0;
      return { symbol: SYMBOL_NAMES[sym] || sym, price: close, change, isIndex: sym.startsWith('^') };
    }).filter(Boolean);
    krState.marketLastFetched = now;
    return krState.marketCache;
  } catch (e) {
    console.log('KR 시장 데이터 실패:', e.message);
    return [];
  }
}

async function krFetchVKOSPI() {
  try {
    const response = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent('^VKOSPI')}&range=1d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    const info = response.data['^VKOSPI'];
    if (!info) return null;
    const value = info.close?.[info.close.length - 1];
    if (!value) return null;
    let classification;
    if (value <= 15) classification = 'Extreme Greed';
    else if (value <= 20) classification = 'Greed';
    else if (value <= 25) classification = 'Neutral';
    else if (value <= 35) classification = 'Fear';
    else classification = 'Extreme Fear';
    return { value: Math.round(value * 10) / 10, classification };
  } catch (e) {
    console.log('VKOSPI 실패:', e.message);
    return null;
  }
}

async function krSummarizeAndScore(title, content) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    messages: [{ role: 'user', content: `아래 한국 주식 관련 기사를 분석해줘.

제목: ${title}
본문: ${content}

아래 형식으로만 출력해줘:
요약: (본문을 5문장 내외로 요약. 핵심 내용을 충실하게 담아줘)
중요도: (1~5 숫자만. 기준: 5=한국은행 금리/정부 정책/시장 전체 영향, 4=대형 실적발표/M&A/기관 동향, 3=섹터 트렌드/일반 시장 동향, 2=개별 종목/특정 기업 뉴스, 1=단순 정보/오피니언)
시그널: (긍정 또는 부정 또는 중립 중 하나만)
태그: (기사에서 언급된 종목명 또는 섹터. 예: 삼성전자,SK하이닉스,반도체 / 없으면 없음)` }]
  });
  return message.content[0].text;
}

async function krFetchAllNews() {
  const now = Date.now();
  if (krState.lastFetched && now - krState.lastFetched < CACHE_DURATION && krState.memoryCache.length > 0) {
    return krState.memoryCache;
  }

  const { data: existingArticles } = await supabase.from('kr_articles').select('url');
  const existingUrls = new Set((existingArticles || []).map(a => a.url));

  for (const source of KR_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 5)) {
        if (existingUrls.has(item.link)) continue;
        const content = item.contentSnippet || item.content || '';
        if (!content || content.trim().length < 50) continue;
        const result = await krSummarizeAndScore(item.title, content);
        const lines = result.split('\n').filter(l => l.trim());
        const summary = lines.find(l => l.startsWith('요약:'))?.replace('요약:', '').trim();
        const score = parseInt(lines.find(l => l.startsWith('중요도:'))?.replace('중요도:', '').trim()) || 3;
        const signal = lines.find(l => l.startsWith('시그널:'))?.replace('시그널:', '').trim();
        const tagText = lines.find(l => l.startsWith('태그:'))?.replace('태그:', '').trim();
        const tags = tagText && tagText !== '없음' ? tagText.split(',').map(t => t.trim()) : [];
        await supabase.from('kr_articles').insert({
          url: item.link, original_title: item.title, korean_title: item.title,
          summary, source: source.name, score, signal, tags,
          pub_date: item.pubDate || item.isoDate || new Date().toISOString()
        });
      }
    } catch (e) { console.log(`${source.name} RSS 실패:`, e.message); }
  }

  const { data: allArticles } = await supabase.from('kr_articles').select('*')
    .order('score', { ascending: false }).order('pub_date', { ascending: false }).limit(50);

  krState.memoryCache = (allArticles || []).map(a => ({
    originalTitle: a.original_title, koreanTitle: a.korean_title, summary: a.summary,
    link: a.url, date: a.pub_date, source: a.source, score: a.score, signal: a.signal, tags: a.tags || []
  }));
  krState.lastFetched = now;
  return krState.memoryCache;
}

async function krGenerateAnalysis(news, vkospi) {
  const signalCount = {
    긍정: news.filter(n => n.signal === '긍정').length,
    부정: news.filter(n => n.signal === '부정').length,
    중립: news.filter(n => n.signal === '중립').length
  };
  const topNews = news.slice(0, 5).map((n, i) => `${i + 1}. [${n.signal}] ${n.koreanTitle}`).join('\n');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    messages: [{ role: 'user', content: `아래 데이터를 기반으로 한국 주식 시장 단기 방향성을 분석해줘.

VKOSPI(변동성지수): ${vkospi?.value || '알 수 없음'} (${vkospi?.classification || ''})
뉴스 시그널: 긍정 ${signalCount.긍정}건, 부정 ${signalCount.부정}건, 중립 ${signalCount.중립}건
주요 뉴스:
${topNews}

아래 형식으로만 출력해줘:
방향성: (강한상승 또는 약한상승 또는 중립 또는 약한하락 또는 강한하락 중 하나)
분석: (2~3문장으로 핵심만. 왜 이런 방향성인지 근거 포함)
주목변수: (오늘 가장 주목해야 할 변수 한 줄)` }]
  });
  return message.content[0].text;
}

async function krGenerateBrief(news) {
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase.from('kr_briefs').select('*').eq('brief_date', today).single();
  const latestArticleTime = news[0]?.date ? new Date(news[0].date).getTime() : 0;
  if (existing && new Date(existing.created_at).getTime() > latestArticleTime) {
    return { briefText: existing.brief_text, picks: existing.picks };
  }
  const articleSummaries = news.slice(0, 5).map((item, i) => `${i + 1}. ${item.koreanTitle} (${item.source}, ${item.signal})`).join('\n');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 500,
    messages: [{ role: 'user', content: `아래는 오늘의 주요 한국 주식 뉴스야.

${articleSummaries}

아래 형식으로만 출력해줘:
브리핑: (오늘 한국 주식 시장 전반을 3~4문장으로 핵심만 요약. 날카롭고 임팩트 있게)
픽1: (꼭 읽어야 할 기사 제목 1개)
픽2: (꼭 읽어야 할 기사 제목 1개)
픽3: (꼭 읽어야 할 기사 제목 1개)` }]
  });
  const brief = message.content[0].text;
  const briefLines = brief.split('\n').filter(l => l.trim());
  const briefText = briefLines.find(l => l.startsWith('브리핑:'))?.replace('브리핑:', '').trim();
  const picks = [1, 2, 3].map(i => briefLines.find(l => l.startsWith(`픽${i}:`))?.replace(`픽${i}:`, '').trim()).filter(Boolean);
  await supabase.from('kr_briefs').upsert({ brief_date: today, brief_text: briefText, picks, created_at: new Date().toISOString() }, { onConflict: 'brief_date' });
  return { briefText, picks };
}

// DART 공시
const TRACKED_CORPS = {
  '00126380': { name: '삼성전자', ticker: '005930' },
  '00164779': { name: 'SK하이닉스', ticker: '000660' },
  '01634089': { name: 'LG에너지솔루션', ticker: '373220' },
  '00164742': { name: '현대차', ticker: '005380' },
  '00266961': { name: 'NAVER', ticker: '035420' },
  '00258801': { name: '카카오', ticker: '035720' },
  '00126362': { name: '삼성SDI', ticker: '006400' }
};

function getDateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

async function krFetchDartDocument(rceptNo) {
  try {
    const cleanRceptNo = String(rceptNo).trim();
    const mainRes = await axios.get(`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${cleanRceptNo}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    const html = mainRes.data;
    const nodeRegex = /node1\['text'\]\s*=\s*"([^"]+)"[\s\S]*?node1\['dcmNo'\]\s*=\s*"(\d+)"[\s\S]*?node1\['eleId'\]\s*=\s*"(\d+)"[\s\S]*?node1\['offset'\]\s*=\s*"(\d+)"[\s\S]*?node1\['length'\]\s*=\s*"(\d+)"[\s\S]*?node1\['dtd'\]\s*=\s*"([^"]+)"/g;
    const nodes = [];
    let match;
    while ((match = nodeRegex.exec(html)) !== null) {
      nodes.push({ text: match[1], dcmNo: match[2], eleId: match[3], offset: match[4], length: match[5], dtd: match[6] });
    }
    if (nodes.length === 0) return '';
    const skipPatterns = /대표이사|확인서|표지|목차|이사회의사록|증빙서류|주요사항보고서|사\s*업\s*보\s*고\s*서|감\s*사\s*보\s*고\s*서|첨부/;
    const candidates = nodes.filter(n => !skipPatterns.test(n.text) && parseInt(n.length) > 500);
    const contentNode = candidates.sort((a, b) => parseInt(b.length) - parseInt(a.length))[0]
      || nodes.find(n => parseInt(n.length) > 1000)
      || nodes[Math.min(1, nodes.length - 1)];
    const viewerUrl = `https://dart.fss.or.kr/report/viewer.do?rcpNo=${cleanRceptNo}&dcmNo=${contentNode.dcmNo}&eleId=${contentNode.eleId}&offset=${contentNode.offset}&length=${contentNode.length}&dtd=${contentNode.dtd}`;
    const viewerRes = await axios.get(viewerUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    const text = viewerRes.data.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 3000);
  } catch (e) {
    return '';
  }
}

async function krSummarizeDart(company, title, rceptNo) {
  try {
    const docText = await krFetchDartDocument(rceptNo);
    const prompt = docText
      ? `회사: ${company}\n공시제목: ${title}\n공시본문(일부): ${docText}\n\n위 DART 공시의 핵심 내용을 투자자 관점에서 한 줄(50자 이내)로 요약해줘.\n구체적인 수치(금액, 주수, 비율 등)가 있으면 반드시 포함해.\n"~입니다", "~됩니다" 같은 어미 없이 간결한 명사형으로 끝내.\n예시: "자기주식 500만주 처분 결정, 약 3,500억원 규모"\n설명만 출력해.`
      : `회사: ${company}\n공시제목: ${title}\n\n위 DART 공시 제목을 투자자가 이해하기 쉽게 한 줄(40자 이내)로 풀어써줘.\n간결한 명사형으로 끝내. 설명만 출력해.`;
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });
    return message.content[0].text.trim();
  } catch (e) { return ''; }
}

async function krFetchDartDisclosures() {
  const now = Date.now();
  if (krState.dartLastFetched && now - krState.dartLastFetched < CACHE_DURATION && krState.dartCache) {
    return krState.dartCache;
  }
  const dartApiKey = process.env.DART_API_KEY;
  if (!dartApiKey) return [];
  try {
    const disclosures = [];
    for (const [corpCode, info] of Object.entries(TRACKED_CORPS)) {
      try {
        const response = await axios.get(
          `https://opendart.fss.or.kr/api/list.json?crtfc_key=${dartApiKey}&corp_code=${corpCode}&bgn_de=${getDateStr(-30)}&end_de=${getDateStr(0)}&page_count=3`,
          { headers: { 'User-Agent': 'StockDashboard/1.0' } }
        );
        for (const item of (response.data?.list || [])) {
          disclosures.push({
            ticker: info.ticker, company: info.name, title: item.report_nm,
            date: item.rcept_dt, type: item.pblntf_ty,
            rceptNo: String(item.rcept_no).trim(),
            url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`
          });
        }
      } catch (e) { /* skip */ }
    }
    const sorted = disclosures.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
    for (const d of sorted.slice(0, 10)) {
      d.summary = await krSummarizeDart(d.company, d.title, d.rceptNo);
    }
    krState.dartCache = sorted;
    krState.dartLastFetched = now;
    return krState.dartCache;
  } catch (e) {
    console.log('DART 실패:', e.message);
    return [];
  }
}

// ==========================================
// API ROUTES
// ==========================================

// Helper: parse analysis response
function parseAnalysis(text) {
  const lines = text.split('\n').filter(l => l.trim());
  return {
    direction: lines.find(l => l.startsWith('방향성:'))?.replace('방향성:', '').trim(),
    comment: lines.find(l => l.startsWith('분석:'))?.replace('분석:', '').trim(),
    watchout: lines.find(l => l.startsWith('주목변수:'))?.replace('주목변수:', '').trim()
  };
}

// Crypto routes
app.get('/api/crypto/news', async (req, res) => res.json(await cryptoFetchAllNews()));
app.get('/api/crypto/market', async (req, res) => {
  const [market, fearGreed] = await Promise.all([cryptoFetchMarket(), cryptoFetchFearGreed()]);
  res.json({ market, fearGreed });
});
app.get('/api/crypto/analysis', async (req, res) => {
  const [news, fearGreed] = await Promise.all([cryptoFetchAllNews(), cryptoFetchFearGreed()]);
  res.json(parseAnalysis(await cryptoGenerateAnalysis(news, fearGreed)));
});
app.get('/api/crypto/brief', async (req, res) => {
  const news = await cryptoFetchAllNews();
  res.json(await cryptoGenerateBrief(news));
});

// US Stock routes
app.get('/api/us/news', async (req, res) => res.json(await usFetchAllNews()));
app.get('/api/us/market', async (req, res) => {
  const [market, fearGreed] = await Promise.all([usFetchMarket(), usFetchFearGreed()]);
  res.json({ market, fearGreed });
});
app.get('/api/us/analysis', async (req, res) => {
  const [news, fearGreed] = await Promise.all([usFetchAllNews(), usFetchFearGreed()]);
  res.json(parseAnalysis(await usGenerateAnalysis(news, fearGreed)));
});
app.get('/api/us/brief', async (req, res) => {
  const news = await usFetchAllNews();
  res.json(await usGenerateBrief(news));
});
app.get('/api/us/insider', async (req, res) => res.json(await usFetchInsiderTrades()));

// KR Stock routes
app.get('/api/kr/news', async (req, res) => res.json(await krFetchAllNews()));
app.get('/api/kr/market', async (req, res) => {
  const [market, vkospi] = await Promise.all([krFetchMarket(), krFetchVKOSPI()]);
  res.json({ market, fearGreed: vkospi });
});
app.get('/api/kr/analysis', async (req, res) => {
  const [news, vkospi] = await Promise.all([krFetchAllNews(), krFetchVKOSPI()]);
  res.json(parseAnalysis(await krGenerateAnalysis(news, vkospi)));
});
app.get('/api/kr/brief', async (req, res) => {
  const news = await krFetchAllNews();
  res.json(await krGenerateBrief(news));
});
app.get('/api/kr/dart', async (req, res) => res.json(await krFetchDartDisclosures()));

// Server
if (!IS_VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`서버 실행 중 → http://localhost:${port}`));
}

module.exports = app;
