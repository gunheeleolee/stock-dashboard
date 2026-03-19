const SCORE_LABEL = {
  5: { text: '긴급', color: '#ff3b30' },
  4: { text: '주요', color: '#ff9500' },
  3: { text: '일반', color: '#34c759' },
  2: { text: '참고', color: '#007aff' },
  1: { text: '정보', color: '#8e8e93' }
};

const SIGNAL_STYLE = {
  '긍정': { text: '🟢 긍정', color: '#34c759' },
  '부정': { text: '🔴 부정', color: '#ff3b30' },
  '중립': { text: '🟡 중립', color: '#ff9500' }
};

let currentTab = 'crypto';
let allNews = [];
let filters = { source: 'all', score: 'all', signal: 'all', tag: 'all' };

// 탭별 데이터 캐시
const cache = { crypto: {}, us: {}, kr: {} };

// 탭 설정
const TAB_CONFIG = {
  crypto: {
    title: 'Crypto News',
    subtitle: 'AI 번역 및 요약',
    prefix: '/api/crypto',
    currency: '$',
    fearGreedLabel: '공포탐욕지수',
    fearGreedReversed: false,
    hasInsider: false,
    hasOriginalTitle: true,
    tagLabel: '코인',
    formatPrice: (item) => '$' + item.price?.toLocaleString(),
    fearGreedColor: (v) => v <= 25 ? '#ff3b30' : v <= 50 ? '#ff9500' : v <= 75 ? '#34c759' : '#00c7be',
    translateFG: (c) => {
      const map = { 'Extreme Fear': '극도의 공포', 'Fear': '공포', 'Neutral': '중립', 'Greed': '탐욕', 'Extreme Greed': '극도의 탐욕' };
      return map[c] || c || '';
    }
  },
  us: {
    title: 'US Stock News',
    subtitle: 'AI 번역 및 요약',
    prefix: '/api/us',
    currency: '$',
    fearGreedLabel: '공포탐욕지수',
    fearGreedReversed: false,
    hasInsider: true,
    insiderTitle: '🔍 내부자 거래 (Form 4)',
    hasOriginalTitle: true,
    tagLabel: '종목 · 섹터',
    formatPrice: (item) => item.isIndex
      ? item.price?.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
      : '$' + item.price?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    fearGreedColor: (v) => v <= 25 ? '#ff3b30' : v <= 50 ? '#ff9500' : v <= 75 ? '#34c759' : '#00c7be',
    translateFG: (c) => {
      if (!c) return '';
      const map = { 'extreme fear': '극도의 공포', 'fear': '공포', 'neutral': '중립', 'greed': '탐욕', 'extreme greed': '극도의 탐욕' };
      return map[c.toLowerCase()] || c;
    }
  },
  kr: {
    title: 'KR Stock News',
    subtitle: 'AI 요약 및 분석',
    prefix: '/api/kr',
    currency: '₩',
    fearGreedLabel: 'VKOSPI 변동성',
    fearGreedReversed: true,
    hasInsider: true,
    insiderTitle: '🔍 주요 공시 (DART)',
    hasOriginalTitle: false,
    tagLabel: '종목 · 섹터',
    formatPrice: (item) => item.isIndex
      ? item.price?.toLocaleString('ko-KR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
      : '₩' + Math.round(item.price)?.toLocaleString('ko-KR'),
    fearGreedColor: (v) => v >= 35 ? '#ff3b30' : v >= 25 ? '#ff9500' : v >= 20 ? '#34c759' : '#00c7be',
    translateFG: (c) => {
      if (!c) return '';
      const map = { 'extreme fear': '극도의 공포', 'fear': '공포', 'neutral': '중립', 'greed': '안정', 'extreme greed': '매우 안정' };
      return map[c.toLowerCase()] || c;
    }
  }
};

// 탭 전환
function switchTab(tab) {
  currentTab = tab;
  filters = { source: 'all', score: 'all', signal: 'all', tag: 'all' };

  // 탭 버튼 활성화
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // 헤더 업데이트
  const config = TAB_CONFIG[tab];
  document.getElementById('page-title').textContent = config.title;
  document.getElementById('page-subtitle').textContent = config.subtitle;

  // 콘텐츠 초기화
  document.getElementById('brief-text').textContent = '브리핑 불러오는 중...';
  document.getElementById('picks-list').innerHTML = '';
  document.getElementById('market-analysis').innerHTML = '<div class="analysis-comment">분석 불러오는 중...</div>';
  document.getElementById('market-bar').innerHTML = '불러오는 중...';
  document.getElementById('news-list').innerHTML = '<div class="empty">기사 불러오는 중...</div>';

  // 특수 섹션
  const insiderSection = document.getElementById('insider-section');
  if (config.hasInsider) {
    insiderSection.style.display = '';
    document.getElementById('insider-title').textContent = config.insiderTitle;
    document.getElementById('insider-list').innerHTML = '불러오는 중...';
  } else {
    insiderSection.style.display = 'none';
  }

  loadAll(tab);
}

async function loadAll(tab) {
  const config = TAB_CONFIG[tab];
  const c = cache[tab];

  // 뉴스 (캐시 확인)
  if (c.news) {
    allNews = c.news;
    renderNews();
    renderFilters(allNews);
  } else {
    const res = await fetch(config.prefix + '/news');
    allNews = await res.json();
    c.news = allNews;
    if (currentTab === tab) { renderNews(); renderFilters(allNews); }
  }

  // 나머지 병렬 로딩
  loadMarket(tab);
  loadBrief(tab);
  loadAnalysis(tab);

  if (tab === 'us') loadInsider();
  if (tab === 'kr') loadDart();
}

async function loadMarket(tab) {
  const config = TAB_CONFIG[tab];
  const c = cache[tab];

  let data;
  if (c.market) {
    data = c.market;
  } else {
    const res = await fetch(config.prefix + '/market');
    data = await res.json();
    c.market = data;
  }

  if (currentTab !== tab) return;
  const { market, fearGreed } = data;
  const bar = document.getElementById('market-bar');

  bar.innerHTML = market.map(item => {
    const change = item.change?.toFixed(2);
    const isUp = item.change >= 0;
    return `
      <div class="market-item">
        <span class="market-symbol">${item.symbol}</span>
        <span class="market-price">${config.formatPrice(item)}</span>
        <span class="market-change ${isUp ? 'up' : 'down'}">
          ${isUp ? '▲' : '▼'}&nbsp;${Math.abs(change)}%
        </span>
      </div>
    `;
  }).join('');

  if (fearGreed) {
    const fgColor = config.fearGreedColor(fearGreed.value);
    bar.innerHTML += `
      <div class="fear-greed">
        <div class="fear-greed-label">${config.fearGreedLabel}</div>
        <div class="fear-greed-value" style="color: ${fgColor}">
          ${fearGreed.value}
          <span class="fear-greed-text">${config.translateFG(fearGreed.classification)}</span>
        </div>
      </div>
    `;
  }
}

async function loadBrief(tab) {
  const config = TAB_CONFIG[tab];
  const c = cache[tab];

  let data;
  if (c.brief) {
    data = c.brief;
  } else {
    const res = await fetch(config.prefix + '/brief');
    data = await res.json();
    c.brief = data;
  }

  if (currentTab !== tab) return;
  const { briefText, picks } = data;

  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  document.getElementById('brief-date').textContent = `📅 ${today}`;
  document.getElementById('brief-text').textContent = briefText || '';

  const picksList = document.getElementById('picks-list');
  picksList.innerHTML = (picks || []).map((pick, i) => {
    const matchIndex = allNews.findIndex(item => item.koreanTitle === pick);
    const anchor = matchIndex >= 0 ? `href="#article-${matchIndex}"` : '';
    return `<div class="pick-item"><a class="pick-link" ${anchor}>${i + 1}. ${pick}</a></div>`;
  }).join('');
}

async function loadAnalysis(tab) {
  const config = TAB_CONFIG[tab];
  const c = cache[tab];

  let data;
  if (c.analysis) {
    data = c.analysis;
  } else {
    const res = await fetch(config.prefix + '/analysis');
    data = await res.json();
    c.analysis = data;
  }

  if (currentTab !== tab) return;
  const { direction, comment, watchout } = data;

  const directionColor = {
    '강한상승': '#ff3b30', '약한상승': '#ff9500', '중립': '#8e8e93',
    '약한하락': '#007aff', '강한하락': '#5856d6'
  };

  document.getElementById('market-analysis').innerHTML = `
    <div class="analysis-direction" style="color: ${directionColor[direction] || '#1a1a1a'}">
      ${direction || '분석 중...'}
    </div>
    <div class="analysis-comment">${comment || ''}</div>
    <div class="analysis-watchout">
      <span class="watchout-label">주목변수</span> ${watchout || ''}
    </div>
  `;
}

async function loadInsider() {
  const c = cache.us;
  let trades;
  if (c.insider) {
    trades = c.insider;
  } else {
    const res = await fetch('/api/us/insider');
    trades = await res.json();
    c.insider = trades;
  }

  if (currentTab !== 'us') return;
  const list = document.getElementById('insider-list');
  if (!trades || trades.length === 0) {
    list.innerHTML = '<div class="insider-empty">최근 30일간 주요 종목 내부자 거래 없음</div>';
    return;
  }

  list.innerHTML = trades.map(t => {
    const isBuy = t.type === '매수';
    const valueStr = t.totalValue >= 1000000
      ? '$' + (t.totalValue / 1000000).toFixed(1) + 'M'
      : '$' + t.totalValue.toLocaleString('en-US');
    return `
      <div class="insider-item">
        <div class="insider-header">
          <span class="insider-ticker">${t.ticker}</span>
          <span class="insider-type ${isBuy ? 'buy' : 'sell'}">${t.type}</span>
          <span class="insider-date">${t.date}</span>
        </div>
        <div class="insider-detail">
          <span class="insider-owner">${t.owner}</span>
          <span class="insider-role">${t.title}</span>
        </div>
        <div class="insider-amount">
          ${t.shares.toLocaleString('en-US')}주 × $${t.price.toFixed(2)} = <strong>${valueStr}</strong>
        </div>
      </div>
    `;
  }).join('');
}

async function loadDart() {
  const c = cache.kr;
  let disclosures;
  if (c.dart) {
    disclosures = c.dart;
  } else {
    const res = await fetch('/api/kr/dart');
    disclosures = await res.json();
    c.dart = disclosures;
  }

  if (currentTab !== 'kr') return;
  const list = document.getElementById('insider-list');
  if (!disclosures || disclosures.length === 0) {
    list.innerHTML = '<div class="insider-empty">최근 30일간 주요 종목 공시 없음</div>';
    return;
  }

  list.innerHTML = disclosures.map(d => `
    <div class="insider-item">
      <div class="insider-header">
        <span class="insider-ticker">${d.company}</span>
        <span class="insider-date">${d.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}</span>
      </div>
      <div class="insider-detail">
        <a href="${d.url}" target="_blank" class="dart-title">${d.title}</a>
      </div>
      ${d.summary ? `<div class="dart-summary">${d.summary}</div>` : ''}
    </div>
  `).join('');
}

// 필터 렌더링
function renderFilters(news) {
  const config = TAB_CONFIG[currentTab];
  const sources = ['all', ...new Set(news.map(i => i.source))];
  const allTags = [...new Set(news.flatMap(i => i.tags))].filter(Boolean);

  const container = document.getElementById('filters');
  container.innerHTML = `
    <div class="filter-group">
      <div class="filter-group-label">매체</div>
      <div class="filter-btns">
        ${sources.map(s => `
          <a class="filter-btn ${filters.source === s ? 'active' : ''}"
             onclick="setFilter('source', '${s}')">
            ${s === 'all' ? 'All' : s}
          </a>
        `).join('')}
      </div>
    </div>

    <div class="filter-group">
      <div class="filter-group-label">중요도</div>
      <div class="filter-btns">
        <a class="filter-btn ${filters.score === 'all' ? 'active' : ''}"
           onclick="setFilter('score', 'all')">All</a>
        ${[5,4,3,2,1].map(s => `
          <a class="filter-btn score-${s} ${filters.score === String(s) ? 'active' : ''}"
             onclick="setFilter('score', '${s}')">
            ${SCORE_LABEL[s].text}
          </a>
        `).join('')}
      </div>
    </div>

    <div class="filter-group">
      <div class="filter-group-label">시그널</div>
      <div class="filter-btns">
        ${['all','긍정','부정','중립'].map(s => `
          <a class="filter-btn ${filters.signal === s ? 'active' : ''}"
             onclick="setFilter('signal', '${s}')">
            ${s === 'all' ? 'All' : SIGNAL_STYLE[s]?.text || s}
          </a>
        `).join('')}
      </div>
    </div>

    ${allTags.length > 0 ? `
    <div class="filter-group">
      <div class="filter-group-label">${config.tagLabel}</div>
      <div class="filter-btns">
        <a class="filter-btn ${filters.tag === 'all' ? 'active' : ''}"
           onclick="setFilter('tag', 'all')">All</a>
        ${allTags.map(t => `
          <a class="filter-btn ${filters.tag === t ? 'active' : ''}"
             onclick="setFilter('tag', '${t}')">
            ${t}
          </a>
        `).join('')}
      </div>
    </div>
    ` : ''}
  `;
}

function setFilter(type, value) {
  filters[type] = value;
  renderNews();
  renderFilters(allNews);
}

function renderNews() {
  const config = TAB_CONFIG[currentTab];
  let filtered = allNews;
  if (filters.source !== 'all') filtered = filtered.filter(i => i.source === filters.source);
  if (filters.score !== 'all') filtered = filtered.filter(i => i.score === parseInt(filters.score));
  if (filters.signal !== 'all') filtered = filtered.filter(i => i.signal === filters.signal);
  if (filters.tag !== 'all') filtered = filtered.filter(i => i.tags.includes(filters.tag));

  const list = document.getElementById('news-list');
  const isMobile = window.innerWidth <= 768;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">해당하는 기사가 없어요.</div>';
    return;
  }

  list.innerHTML = filtered.map((item, index) => `
    <div class="news-card" id="article-${index}">
      <div class="card-header">
        <span class="score-badge" style="background:${SCORE_LABEL[item.score]?.color || '#8e8e93'}">
          ${SCORE_LABEL[item.score]?.text || '정보'}
        </span>
        ${item.signal && SIGNAL_STYLE[item.signal] ? `
          <span class="signal-badge" style="background:${SIGNAL_STYLE[item.signal].color}">
            ${SIGNAL_STYLE[item.signal].text}
          </span>
        ` : ''}
        <span class="source-badge">${item.source}</span>
        <span class="date">${new Date(item.date).toLocaleDateString('ko-KR')}</span>
      </div>
      <div class="korean-title ${isMobile ? 'accordion-title' : ''}"
           ${isMobile ? `onclick="toggleAccordion(this)"` : ''}>
        ${item.koreanTitle || '제목 없음'}
      </div>
      <div class="accordion-body ${isMobile ? 'collapsed' : ''}">
        ${config.hasOriginalTitle && item.originalTitle !== item.koreanTitle ? `<div class="original-title">${item.originalTitle}</div>` : ''}
        <div class="summary">${item.summary || '요약 없음'}</div>
        ${item.tags && item.tags.length > 0 ? `
          <div class="coin-tags">
            ${item.tags.map(tag => `
              <a class="coin-tag" onclick="setFilter('tag', '${tag}')">${tag}</a>
            `).join('')}
          </div>
        ` : ''}
        <a href="${item.link}" target="_blank" class="read-more">원문 보기 →</a>
      </div>
    </div>
  `).join('');
}

function toggleAccordion(titleEl) {
  const body = titleEl.nextElementSibling;
  body.classList.toggle('collapsed');
}

// 모바일 메뉴
document.getElementById('mobile-menu-btn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('show');
});

document.getElementById('overlay').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
});

// 탭 이벤트 바인딩
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// 초기 로딩
switchTab('crypto');
