const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const LEAGUES = [
  { sport: 'football', league: 'college-football', label: 'Football', gender: 'Men', periods: 4, keys: ['Q1', 'Q2', 'Q3', 'Q4', 'OT'] },
  { sport: 'basketball', league: 'mens-college-basketball', label: 'Basketball', gender: 'Men', periods: 2, keys: ['1H', '2H', 'OT'] },
  { sport: 'basketball', league: 'womens-college-basketball', label: 'Basketball', gender: 'Women', periods: 4, keys: ['Q1', 'Q2', 'Q3', 'Q4', 'OT'] }
];
const IOWA_ID = '2294';
const ZONES = { ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', PT: 'America/Los_Angeles' };
const $ = (selector, root = document) => root.querySelector(selector);
const gameList = $('#game-list');
const dateInput = $('#game-date');
let timezone = localStorage.getItem('hawkeye-sideline-zone') || localStorage.getItem('gywens-sideline-zone') || 'CT';
let requestId = 0;
let pullStart = null;
let refreshTimer;
let selectedDateMode = false;
const rosterStatsCache = new Map();
const visibleLeagues = new Set(LEAGUES.map(config => config.league));
let feedGames = [];
let feedErrors = [];
let feedReady = false;

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function safeText(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function formatDate(date) { return new Intl.DateTimeFormat('en-US', { timeZone: ZONES[timezone], weekday: 'short', month: 'short', day: 'numeric' }).format(date); }
function formatTime(date) { return new Intl.DateTimeFormat('en-US', { timeZone: ZONES[timezone], hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date); }
function localDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ZONES[timezone], year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function formatDateHeading(date) {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone: ZONES[timezone], weekday: 'long', month: 'long', day: 'numeric' }).format(date);
  return localDateKey(date) === localDateKey(new Date()) ? `TODAY · ${formatted}` : formatted.toUpperCase();
}
function renderGameFeed(games, groupByDate) {
  let previousDate = '';
  return games.map(({ event, config }) => {
    const date = new Date(event.date || event.competitions?.[0]?.date);
    const key = localDateKey(date);
    const divider = groupByDate && key !== previousDate ? `<div class="date-divider"><span>${safeText(formatDateHeading(date))}</span></div>` : '';
    previousDate = key;
    return `${divider}${renderGame(event, config)}`;
  }).join('');
}
function renderFilteredFeed(groupByDate) {
  if (!feedReady) return;
  if (!visibleLeagues.size) {
    gameList.innerHTML = '<div class="empty-card"><strong>No teams selected</strong><small>Tap a team above to show its games.</small></div>';
    return;
  }
  const games = feedGames.filter(({ config }) => visibleLeagues.has(config.league));
  if (games.length) {
    gameList.innerHTML = renderGameFeed(games, groupByDate);
    if (feedErrors.length) gameList.insertAdjacentHTML('beforeend', '<div class="error-card">Some ESPN scoreboards could not be reached. Showing available games.</div>');
  } else if (feedErrors.length === LEAGUES.length) {
    gameList.innerHTML = '<div class="error-card">Scores could not be loaded from ESPN. Check your connection and pull down to retry.</div>';
  } else {
    gameList.innerHTML = `<div class="empty-card"><strong>No games for the selected teams</strong><small>${selectedDateMode ? 'Pick another day to check the schedule.' : 'Upcoming Hawkeye games will appear here.'}</small></div>`;
  }
}
function getTeam(event, homeAway) { return event.competitions?.[0]?.competitors?.find(c => c.homeAway === homeAway) || {}; }
function hasIowa(event) { return event.competitions?.[0]?.competitors?.some(c => c.team?.id === IOWA_ID); }

async function fetchScoreboard(config, date) {
  // ESPN's scoreboard endpoint can omit scheduled games for future dates.
  // The team schedule is the reliable source for this Iowa-only feed.
  const url = `${ESPN}/${config.sport}/${config.league}/teams/${IOWA_ID}/schedule`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
  const data = await response.json();
  return (data.events || []).map(event => {
    const competition = event.competitions?.[0] || {};
    for (const competitor of competition.competitors || []) {
      const team = competitor.team || {};
      team.logo ||= team.logos?.[0]?.href;
    }
    return { event: { ...event, status: event.status || competition.status }, config };
  }).filter(({ event }) => {
    const gameDate = new Date(event.date || event.competitions?.[0]?.date);
    return hasIowa(event) && Number.isFinite(gameDate.getTime()) && localDateKey(gameDate) === date;
  });
}
async function fetchUpcomingSchedule(config) {
  const url = `${ESPN}/${config.sport}/${config.league}/teams/${IOWA_ID}/schedule`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
  const data = await response.json();
  return (data.events || []).map(event => {
    const competition = event.competitions?.[0] || {};
    for (const competitor of competition.competitors || []) {
      const team = competitor.team || {};
      team.logo ||= team.logos?.[0]?.href;
    }
    return { event: { ...event, status: event.status || competition.status }, config };
  }).filter(({ event }) => isLiveOrUpcoming(event));
}
function isLiveOrUpcoming(event) {
  const state = event.status?.type?.state || event.competitions?.[0]?.status?.type?.state;
  const gameDate = new Date(event.date || event.competitions?.[0]?.date);
  if (!Number.isFinite(gameDate.getTime())) return false;
  const isToday = localDateKey(gameDate) === localDateKey(new Date());
  if (state === 'in') return true;
  // Keep completed games from today in the feed alongside today's live/upcoming games.
  if (state === 'post') return isToday;
  if (state && state !== 'pre') return false;
  return gameDate >= new Date() || isToday;
}
async function loadGames() {
  const thisRequest = ++requestId;
  $('#refresh-message').textContent = 'Checking ESPN for scores…';
  gameList.setAttribute('aria-busy', 'true');
  if (!gameList.children.length || $('.loading-card', gameList)) {
    gameList.innerHTML = '<div class="loading-card"><span class="refresh-spinner"></span><span>Finding the Hawkeyes’ games…</span></div>';
  }
  const results = await Promise.allSettled(LEAGUES.map(config => selectedDateMode ? fetchScoreboard(config, dateInput.value) : fetchUpcomingSchedule(config)));
  if (thisRequest !== requestId) return;
  const games = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  $('.live-indicator').hidden = !games.some(({ event }) => {
    const state = event.status?.type?.state || event.competitions?.[0]?.status?.type?.state;
    return state === 'in' && hasIowa(event);
  });
  games.sort((a, b) => new Date(a.event.date || a.event.competitions?.[0]?.date) - new Date(b.event.date || b.event.competitions?.[0]?.date));
  const errors = results.filter(r => r.status === 'rejected');
  feedGames = games;
  feedErrors = errors;
  feedReady = true;
  renderFilteredFeed(!selectedDateMode);
  $('#updated-time').textContent = new Intl.DateTimeFormat('en-US', { timeZone: ZONES[timezone], hour: 'numeric', minute: '2-digit' }).format(new Date());
  $('#refresh-message').textContent = 'Scores are up to date';
  gameList.setAttribute('aria-busy', 'false');
  if (!selectedDateMode || dateInput.value === todayString()) scheduleRefresh();
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadGames, 60000);
}
function periodScores(competition, competitor, config) {
  const lines = competitor.linescores || [];
  const periodCount = Math.max(config.periods, lines.length);
  return { periodCount, values: Array.from({ length: periodCount }, (_, index) => lines[index]?.displayValue ?? lines[index]?.value ?? '—') };
}
function displayScore(score) {
  if (score && typeof score === 'object') return score.displayValue ?? score.value ?? '—';
  return score ?? '—';
}
function renderGame(event, config) {
  const competition = event.competitions?.[0] || {};
  const away = getTeam(event, 'away');
  const home = getTeam(event, 'home');
  const awayScores = periodScores(competition, away, config);
  const homeScores = periodScores(competition, home, config);
  const periods = Math.max(awayScores.periodCount, homeScores.periodCount);
  const state = event.status?.type?.state || 'pre';
  const label = state === 'in' ? (event.status?.type?.shortDetail || 'LIVE') : state === 'post' ? 'FINAL' : formatTime(new Date(event.date));
  const leagueCode = config.league === 'womens-college-basketball' ? 'NCAAW' : config.league === 'mens-college-basketball' ? 'NCAAM' : 'NCCAF';
  const broadcast = [...new Set([
    ...(competition.broadcasts || []).flatMap(b => Array.isArray(b.names) ? b.names : [b.names || b.media?.shortName || b.media?.name || b.name]),
    ...(competition.geoBroadcasts || []).map(b => b.media?.shortName || b.media?.name || b.name)
  ].filter(Boolean))].join(' · ');
  const date = formatDate(new Date(event.date));
  const periodHeaders = Array.from({ length: periods }, (_, i) => config.keys[i] || (config.periods === 4 ? `OT${i - 3}` : `OT${i - 1}`));
  const eventId = safeText(event.id);
  const defaultTab = config.sport === 'football' || config.sport === 'basketball' ? 'players' : 'game';
  return `<article class="game-card" data-event="${eventId}" data-sport="${config.sport}" data-league="${config.league}" data-state="${safeText(state)}" data-home-team="${safeText(home.team?.id || '')}" data-away-team="${safeText(away.team?.id || '')}">
    <div class="game-meta"><div class="meta-left"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13H4V6a1 1 0 0 1 1-1Z"/></svg><span>${safeText(date)}</span><span class="status ${state === 'in' ? 'live' : ''}">${safeText(label)}</span></div><div class="meta-right"><span class="league-tag">${leagueCode}</span>${broadcast ? `<span class="channel">${safeText(broadcast)}</span>` : ''}</div></div>
    <div class="score-wrap"><div class="score-head" style="--periods:${periods}"><span></span>${periodHeaders.map(h => `<span>${safeText(h)}</span>`).join('')}<span>T</span></div>
      ${renderTeamRow(away, awayScores.values, periods, config, false)}${renderTeamRow(home, homeScores.values, periods, config, true)}
    </div>
    <details class="game-detail"><summary><span class="detail-label"><span class="detail-icon">▤</span> GAME &amp; PLAYER STATS</span><span class="chevron">⌄</span></summary><div class="stats-content"><div class="stats-tabs"><button class="${defaultTab === 'game' ? 'selected' : ''}" data-tab="game">Game stats</button><button class="${defaultTab === 'players' ? 'selected' : ''}" data-tab="players">Player stats</button></div><div class="stats-pane ${defaultTab === 'game' ? 'selected' : ''}" data-pane="game"><p class="empty-stats">Open to load this game’s box score.</p></div><div class="stats-pane ${defaultTab === 'players' ? 'selected' : ''}" data-pane="players"><p class="empty-stats">Player stats will appear when ESPN provides a box score.</p></div></div></details>
  </article>`;
}
function renderTeam(competitor) {
  const team = competitor.team || {};
  const logoSrc = String(team.id) === IOWA_ID ? './assets/iowa-hawkeyes-logo-goldTransparent.png' : team.logo;
  const logo = logoSrc ? `<img src="${safeText(logoSrc)}" alt="" loading="lazy" />` : `<span class="team-monogram">${safeText(team.abbreviation || team.shortDisplayName?.slice(0, 2) || '—')}</span>`;
  const isIowa = String(team.id) === IOWA_ID;
  const displayName = team.displayName || team.name || '';
  const teamLabel = isIowa ? 'Iowa' : team.location || team.shortDisplayName || team.abbreviation || '';
  const mascotFromDisplayName = teamLabel && displayName.toLowerCase().startsWith(teamLabel.toLowerCase())
    ? displayName.slice(teamLabel.length).trim()
    : '';
  const teamName = isIowa ? 'Hawkeyes' : mascotFromDisplayName || team.nickname || team.name || team.shortDisplayName || displayName || 'Team';
  const ranking = [competitor.curatedRank?.current, competitor.rank, team.curatedRank?.current, team.rank]
    .map(value => Number(value)).find(value => Number.isInteger(value) && value >= 1 && value <= 25);
  const rankBadge = ranking ? `<span class="team-rank" aria-label="Ranked number ${ranking}">#${ranking}</span>` : '';
  return `<div class="team-info">${logo}${rankBadge}<span class="team-name">${safeText(teamName)}<small>${safeText(teamLabel)}</small></span></div>`;
}
function renderTeamRow(competitor, scores, periods, config, isHome) {
  const total = displayScore(competitor.score);
  const winner = competitor.winner;
  const cells = Array.from({ length: periods }, (_, i) => `<span class="period-score">${safeText(scores[i] ?? '—')}</span>`).join('');
  return `<div class="team-row ${winner ? 'winner' : ''}" style="--periods:${periods}">${renderTeam(competitor)}${cells}<span class="period-score total">${safeText(total)}</span></div>`;
}

function statsTable(rows, columns) {
  if (!rows?.length) return '<p class="empty-stats">No detailed stats are available for this game yet.</p>';
  return `<table class="stats-table"><thead><tr><th>TEAM</th>${columns.map(c => `<th>${safeText(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><td>${safeText(row.name)}</td>${columns.map(c => `<td>${safeText(row.stats?.[c] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function normalizedStatLabel(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function comparisonNumber(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  const pair = text.match(/^([+-]?\d+(?:\.\d+)?)-\d+(?:\.\d+)?/);
  if (pair) return Number(pair[1]);
  const number = text.match(/[+-]?\d+(?:\.\d+)?/);
  return number ? Math.abs(Number(number[0])) : 0;
}
function teamStatMap(team) {
  return new Map((team.statistics || []).map(stat => [normalizedStatLabel(stat.label || stat.name), {
    label: stat.label || stat.name || 'Stat',
    display: stat.displayValue ?? stat.value ?? '—',
    numeric: comparisonNumber(stat.displayValue ?? stat.value)
  }]));
}
function renderComparisonTeam(team, side) {
  const data = team?.team || {};
  const logo = data.logo ? `<img src="${safeText(data.logo)}" alt="" loading="lazy" />` : '';
  const hawkeye = String(data.id) === IOWA_ID ? ' hawkeye' : '';
  return `<div class="comparison-team ${side}${hawkeye}">${logo}<span>${safeText(data.shortDisplayName || data.displayName || data.name || 'Team')}</span></div>`;
}
function renderGameStatComparison(summary, card) {
  const teams = summary.boxscore?.teams || [];
  if (!teams.length) return '<p class="empty-stats">Game stats are not available for this game yet.</p>';
  const away = findTeamPlayerGroup(teams, card.dataset.awayTeam, 0);
  const home = findTeamPlayerGroup(teams, card.dataset.homeTeam, 1);
  const awayStats = teamStatMap(away || {});
  const homeStats = teamStatMap(home || {});
  const awayClass = String(away?.team?.id) === IOWA_ID ? 'away-iowa' : '';
  const homeClass = String(home?.team?.id) === IOWA_ID ? 'home-iowa' : '';
  const keys = [...new Set([...awayStats.keys(), ...homeStats.keys()])].filter(Boolean);
  const rows = keys.map(key => {
    const left = awayStats.get(key);
    const right = homeStats.get(key);
    const max = Math.max(left?.numeric || 0, right?.numeric || 0);
    const leftWidth = max ? Math.max(2, (left?.numeric || 0) / max * 100) : 0;
    const rightWidth = max ? Math.max(2, (right?.numeric || 0) / max * 100) : 0;
    const label = left?.label || right?.label || key;
    return `<div class="comparison-row"><div class="comparison-value away-value">${safeText(left?.display ?? '—')}</div><div class="comparison-track away-track"><span style="--bar-width:${leftWidth}%"></span></div><div class="comparison-category">${safeText(label)}</div><div class="comparison-track home-track"><span style="--bar-width:${rightWidth}%"></span></div><div class="comparison-value home-value">${safeText(right?.display ?? '—')}</div></div>`;
  }).join('');
  return `<div class="game-comparison ${awayClass} ${homeClass}"><div class="comparison-team-headings">${renderComparisonTeam(away, 'away')}<span class="comparison-title">TEAM STATS</span>${renderComparisonTeam(home, 'home')}</div>${rows || '<p class="empty-stats">No comparable team stats are available.</p>'}</div>`;
}
function extractGameStats(summary, card) {
  return renderGameStatComparison(summary, card);
}
const BASKETBALL_COLUMNS = [
  { label: 'MIN', keys: ['min', 'minutes'] },
  { label: 'PTS', keys: ['pts', 'points'] },
  { label: 'FG', keys: ['fg', 'fieldgoalsmadefieldgoalsattempted', 'fieldgoals'] },
  { label: '3PT', keys: ['3pt', 'threepointfieldgoalsmadethreepointfieldgoalsattempted', 'threepointfieldgoals'] },
  { label: 'FT', keys: ['ft', 'freethrowsmadefreethrowsattempted', 'freethrows'] },
  { label: 'REB', keys: ['reb', 'rebounds', 'totalrebounds'] },
  { label: 'AST', keys: ['ast', 'assists'] },
  { label: 'TO', keys: ['to', 'turnovers'] },
  { label: 'STL', keys: ['stl', 'steals'] },
  { label: 'BLK', keys: ['blk', 'blocks'] },
  { label: 'PF', keys: ['pf', 'fouls', 'personalfouls'] },
  { label: '+/-', keys: ['+/-', 'plusminus', 'plusminuspoints'] }
];

function normalizedStatKey(value) {
  const text = String(value || '').toLowerCase();
  if (text === '+/-' || text === 'plus/minus') return 'plusminus';
  return text.replace(/[^a-z0-9]/g, '');
}
function basketballStatValue(player, column) {
  const statEntries = player.statEntries || [];
  for (const entry of statEntries) {
    const group = entry.statGroup;
    const names = group.names || group.keys || [];
    const labels = group.labels || [];
    const index = names.findIndex((name, i) => {
      const nameKey = normalizedStatKey(name);
      const labelKey = normalizedStatKey(labels[i]);
      return column.keys.some(key => normalizedStatKey(key) === nameKey || normalizedStatKey(key) === labelKey);
    });
    if (index >= 0 && entry.stats?.[index] !== undefined) return entry.stats[index];
  }
  return '—';
}
function basketballPlayers(teamGroup) {
  const players = new Map();
  for (const statGroup of teamGroup?.statistics || []) {
    for (const entry of statGroup.athletes || []) {
      const id = entry.athlete?.id || entry.athlete?.displayName || `${players.size}`;
      const player = players.get(id) || { ...entry, statEntries: [] };
      player.statEntries.push({ statGroup, stats: entry.stats || [] });
      players.set(id, player);
    }
  }
  return [...players.values()];
}
function isStarter(player) {
  const starter = player.starter ?? player.athlete?.starter;
  return starter === true || String(starter).toLowerCase() === 'true';
}
function playerDisplayName(player) {
  const athlete = player.athlete || {};
  const name = athlete.shortName || athlete.displayName || athlete.fullName || player.shortName || player.displayName || player.fullName || 'Player';
  const jersey = athlete.jersey || player.jersey;
  const position = athlete.position?.abbreviation || athlete.position?.displayName || player.position?.abbreviation;
  return `${name}${jersey ? ` #${jersey}` : ''}${position ? ` ${position}` : ''}`;
}
function findTeamPlayerGroup(groups, teamId, fallbackIndex) {
  return groups.find(group => String(group.team?.id) === String(teamId)) || groups[fallbackIndex];
}
function playerTeamTable(label, players) {
  const headers = BASKETBALL_COLUMNS.map(column => `<th>${column.label}</th>`).join('');
  if (!players.length) return `<div class="basketball-table-wrap"><table class="basketball-stats-table"><thead><tr><th class="player-heading">${label}</th>${headers}</tr></thead><tbody><tr><td colspan="${BASKETBALL_COLUMNS.length + 1}" class="empty-stats">No ${label.toLowerCase()} available.</td></tr></tbody></table></div>`;
  const rows = players.map(player => `<tr><td class="player-name">${safeText(playerDisplayName(player))}</td>${BASKETBALL_COLUMNS.map(column => `<td>${safeText(basketballStatValue(player, column))}</td>`).join('')}</tr>`).join('');
  return `<div class="basketball-table-wrap"><table class="basketball-stats-table"><thead><tr><th class="player-heading">${label}</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function basketballTeamTotals(teamGroup, players, aggregateTeam) {
  const statGroups = teamGroup?.statistics || [];
  const totals = {};
  for (const column of BASKETBALL_COLUMNS) {
    let value = '—';
    const teamStat = (aggregateTeam?.statistics || []).find(stat => {
      const candidates = [stat.label, stat.name, stat.abbreviation];
      return candidates.some(candidate => column.keys.some(key => normalizedStatKey(candidate) === normalizedStatKey(key)));
    });
    if (teamStat) value = teamStat.displayValue ?? teamStat.value ?? value;
    for (const group of statGroups) {
      if (value !== '—') break;
      const names = group.names || group.keys || [];
      const labels = group.labels || [];
      const index = names.findIndex((name, i) => {
        const nameKey = normalizedStatKey(name);
        const labelKey = normalizedStatKey(labels[i]);
        return column.keys.some(key => normalizedStatKey(key) === nameKey || normalizedStatKey(key) === labelKey);
      });
      const teamValue = group.team?.stats?.[index] ?? group.team?.statistics?.[index];
      if (index >= 0 && teamValue !== undefined) { value = teamValue; break; }
    }
    if (value === '—') {
      const playerValues = players.map(player => basketballStatValue(player, column)).filter(item => item !== '—');
      if (playerValues.length && playerValues.every(item => /^\d+-\d+$/.test(String(item)))) {
        const totals = playerValues.map(item => String(item).split('-').map(Number)).reduce((sum, item) => [sum[0] + item[0], sum[1] + item[1]], [0, 0]);
        value = `${totals[0]}-${totals[1]}`;
      } else if (column.label === 'MIN' && playerValues.length && playerValues.every(item => /^\d+:\d{2}$/.test(String(item)))) {
        const seconds = playerValues.reduce((sum, item) => {
          const [minutes, remainder] = String(item).split(':').map(Number);
          return sum + minutes * 60 + remainder;
        }, 0);
        value = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      } else if (playerValues.length && playerValues.every(item => /^[+-]?\d+(\.\d+)?$/.test(String(item)))) {
        value = String(playerValues.reduce((sum, item) => sum + Number(item), 0));
      }
    }
    totals[column.label] = value;
  }
  return totals;
}
function basketballTeamSection(teamGroup, aggregateTeams) {
  if (!teamGroup) return '';
  const players = basketballPlayers(teamGroup);
  const starters = players.filter(isStarter);
  const bench = players.filter(player => !isStarter(player));
  const aggregateTeam = aggregateTeams?.find(team => String(team.team?.id) === String(teamGroup.team?.id));
  const totals = basketballTeamTotals(teamGroup, players, aggregateTeam);
  return `<section class="basketball-team-stats"><h4>${safeText(teamGroup.team?.displayName || teamGroup.team?.name || 'Team')}</h4>${playerTeamTable('STARTERS', starters)}${playerTeamTable('BENCH', bench)}<div class="basketball-table-wrap"><table class="basketball-stats-table totals-table"><tbody><tr><th scope="row" class="player-heading">TEAM</th>${BASKETBALL_COLUMNS.map(column => `<td>${safeText(totals[column.label])}</td>`).join('')}</tr></tbody></table></div></section>`;
}
function extractBasketballPlayerStats(summary, card) {
  const groups = summary.boxscore?.players || [];
  if (!groups.length) return '<p class="empty-stats">Player stats are not available yet. They usually appear after the game begins.</p>';
  const home = findTeamPlayerGroup(groups, card.dataset.homeTeam, 1);
  const away = findTeamPlayerGroup(groups, card.dataset.awayTeam, 0);
  const hawkeyesFirst = String(card.dataset.homeTeam) === IOWA_ID ? [home, away] : [away, home];
  return hawkeyesFirst.map(team => basketballTeamSection(team, summary.boxscore?.teams)).join('');
}
const SEASON_AVERAGE_KEYS = {
  MIN: 'avgMinutes', PTS: 'avgPoints', FG: 'avgFieldGoalsMade-avgFieldGoalsAttempted',
  '3PT': 'avgThreePointFieldGoalsMade-avgThreePointFieldGoalsAttempted',
  FT: 'avgFreeThrowsMade-avgFreeThrowsAttempted', REB: 'avgRebounds', AST: 'avgAssists',
  TO: 'avgTurnovers', STL: 'avgSteals', BLK: 'avgBlocks', PF: 'avgFouls'
};
function renderSeasonRosterTeam(team, players) {
  const headers = BASKETBALL_COLUMNS.map(column => `<th>${column.label}</th>`).join('');
  const rows = players.length ? players.map(player => `<tr><td class="player-name">${safeText(playerDisplayName(player))}</td>${BASKETBALL_COLUMNS.map(column => `<td>${safeText(player.averages?.[SEASON_AVERAGE_KEYS[column.label]] ?? '—')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${BASKETBALL_COLUMNS.length + 1}" class="empty-stats">Roster averages are not available yet.</td></tr>`;
  return `<section class="basketball-team-stats"><h4>${safeText(team.displayName || team.name || 'Team')} · SEASON PER-GAME AVERAGES</h4><div class="basketball-table-wrap"><table class="basketball-stats-table"><thead><tr><th class="player-heading">ROSTER</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
async function fetchRosterSeasonAverages(league, teamId) {
  const cacheKey = `${league}:${teamId}`;
  if (rosterStatsCache.has(cacheKey)) return rosterStatsCache.get(cacheKey);
  const request = (async () => {
    const rosterResponse = await fetch(`${ESPN}/basketball/${league}/teams/${teamId}/roster`);
    if (!rosterResponse.ok) throw new Error(`ESPN roster returned ${rosterResponse.status}`);
    const roster = await rosterResponse.json();
    const seasonYear = roster.season?.year;
    const athletes = roster.athletes || [];
    const players = [];
    for (let start = 0; start < athletes.length; start += 5) {
      const batch = athletes.slice(start, start + 5);
      const results = await Promise.allSettled(batch.map(async athlete => {
        const response = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/${league}/athletes/${athlete.id}/stats`);
        if (!response.ok) throw new Error(`ESPN player stats returned ${response.status}`);
        const data = await response.json();
        const averages = data.categories?.find(category => category.name === 'averages');
        const seasonStats = averages?.statistics || [];
        const row = seasonStats.find(item => item.season?.year === seasonYear && String(item.teamId) === String(teamId))
          || seasonStats.find(item => item.season?.year === seasonYear);
        return { ...athlete, averages: Object.fromEntries((averages?.names || []).map((name, index) => [name, row?.stats?.[index] ?? '—'])) };
      }));
      players.push(...results.map((result, index) => result.status === 'fulfilled' ? result.value : ({ ...batch[index], averages: {} })));
    }
    return { team: roster.team || {}, players };
  })();
  rosterStatsCache.set(cacheKey, request);
  try { return await request; }
  catch (error) { rosterStatsCache.delete(cacheKey); throw error; }
}
async function extractUpcomingBasketballRoster(card) {
  const { league, homeTeam, awayTeam } = card.dataset;
  const [home, away] = await Promise.all([
    fetchRosterSeasonAverages(league, homeTeam),
    fetchRosterSeasonAverages(league, awayTeam)
  ]);
  const hawkeyesFirst = String(homeTeam) === IOWA_ID ? [home, away] : [away, home];
  return hawkeyesFirst.map(roster => renderSeasonRosterTeam(roster.team, roster.players)).join('');
}
const FOOTBALL_CATEGORIES = [
  { name: 'Passing', groups: ['passing'], positions: ['QB'], columns: [
    ['GP', ['gp', 'gamesplayed']], ['C/ATT', ['catt', 'completionspassingattempts']], ['YDS', ['yds', 'passingyards']], ['AVG', ['avg', 'yardsperpassattempt']], ['TD', ['td', 'passingtouchdowns']], ['INT', ['int', 'interceptions']], ['SACKS', ['sacks', 'sacked']], ['QBR', ['qbr', 'adjqbr']], ['RTG', ['rtg', 'passerrating', 'quarterbackrating']]
  ] },
  { name: 'Rushing', groups: ['rushing'], positions: ['RB', 'FB'], columns: [
    ['GP', ['gp', 'gamesplayed']], ['CAR', ['car', 'rushingattempts']], ['YDS', ['yds', 'rushingyards']], ['AVG', ['avg', 'yardsperrushattempt']], ['TD', ['td', 'rushingtouchdowns']], ['LONG', ['long', 'longrushing']]
  ] },
  { name: 'Receiving', groups: ['receiving'], positions: ['WR', 'TE'], columns: [
    ['GP', ['gp', 'gamesplayed']], ['REC', ['rec', 'receptions']], ['YDS', ['yds', 'receivingyards']], ['LONG', ['long', 'longreception']], ['TGTS', ['tgts', 'targets']]
  ] },
  { name: 'Defense', groups: ['defensive', 'interceptions', 'fumbles'], positions: ['DB', 'DE', 'DL', 'LB', 'CB', 'S', 'DT', 'NT', 'OLB', 'ILB', 'MLB', 'EDGE'], columns: [
    ['GP', ['gp', 'gamesplayed']], ['TOT', ['tot', 'totaltackles']], ['SACKS', ['sacks']], ['TFL', ['tfl', 'tacklesforloss']], ['PD', ['pd', 'passesdefended']], ['QB HTS', ['qbhts', 'qbhur', 'hurries', 'quarterbackhurries']], ['TD', ['td', 'defensivetouchdowns']], ['INT', ['int', 'interceptions']], ['FR', ['fr', 'fumblesrecovered']]
  ] },
  { name: 'Kicking', groups: ['kicking'], positions: ['PK', 'K'], columns: [
    ['GP', ['gp', 'gamesplayed']], ['FG', ['fg', 'fieldgoalsmade']], ['PCT', ['pct', 'fieldgoalpct']], ['LONG', ['long', 'longfieldgoal', 'longfieldgoalMade']], ['XP', ['xp', 'extrapointsmade']], ['PTS', ['pts', 'totalkickingpoints']]
  ] }
];
const FOOTBALL_ROSTER_CACHE = new Map();
const FOOTBALL_SEASON_CACHE = new Map();
function footballStatKey(value) { return normalizedStatKey(value); }
function footballValue(group, entry, aliases) {
  if (!group || !entry) return '—';
  const keys = group.keys || group.names || [];
  const labels = group.labels || [];
  const labelIndex = labels.findIndex(label => aliases.includes(footballStatKey(label)));
  const index = keys.findIndex(key => aliases.includes(footballStatKey(key)));
  const statIndex = labelIndex >= 0 ? labelIndex : index;
  return statIndex >= 0 ? (entry.stats?.[statIndex] ?? '—') : '—';
}
function footballTeamTotals(group, aliases) {
  if (!group) return '—';
  const totalsEntry = { stats: group.totals || [] };
  return footballValue(group, totalsEntry, aliases);
}
function footballTeamRows(teamGroup, category) {
  const statGroups = (teamGroup.statistics || []).filter(group => category.groups.includes(group.name));
  const players = new Map();
  for (const group of statGroups) {
    for (const entry of group.athletes || []) {
      const athlete = entry.athlete || {};
      const id = String(athlete.id || athlete.displayName || players.size);
      const row = players.get(id) || { athlete, values: Object.fromEntries(category.columns.map(([label]) => [label, '—'])) };
      category.columns.forEach(([label, aliases]) => {
        if (label === 'GP') { row.values[label] = '1'; return; }
        const value = footballValue(group, entry, aliases);
        if (value !== '—') row.values[label] = value;
      });
      players.set(id, row);
    }
  }
  const totals = Object.fromEntries(category.columns.map(([label, aliases]) => {
    if (label === 'GP') return [label, '1'];
    const sources = statGroups.filter(group => group.athletes?.length || group.totals?.length);
    const source = sources.find(group => footballTeamTotals(group, aliases) !== '—');
    return [label, source ? footballTeamTotals(source, aliases) : '—'];
  }));
  const orderedPlayers = [...players.values()].sort((a, b) => Number(b.values.GP || 0) - Number(a.values.GP || 0));
  return { players: orderedPlayers, totals };
}
function renderFootballCategory(category, data, seasonAverages = false) {
  const headers = category.columns.map(([label]) => `<th>${safeText(label)}</th>`).join('');
  const rows = data.players.length ? data.players.map(({ athlete, values }) => `<tr><td class="player-name">${safeText(playerDisplayName({ athlete }))}</td>${category.columns.map(([label]) => `<td>${safeText(values[label] ?? '—')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${category.columns.length + 1}" class="empty-stats">${seasonAverages ? 'No matching players found on this roster.' : 'No player stats available.'}</td></tr>`;
  const totals = `<tr class="football-total-row"><th scope="row" class="player-heading">TEAM</th>${category.columns.map(([label]) => `<td>${safeText(data.totals[label] ?? '—')}</td>`).join('')}</tr>`;
  return `<section class="football-stat-section"><h5>${safeText(category.name)}${seasonAverages ? ' · SEASON PER-GAME' : ''}</h5><div class="basketball-table-wrap"><table class="basketball-stats-table football-stats-table"><thead><tr><th class="player-heading">PLAYER</th>${headers}</tr></thead><tbody>${rows}${totals}</tbody></table></div></section>`;
}
function renderFootballTeam(team, categories, seasonAverages = false) {
  return `<section class="football-team-stats"><h4>${safeText(team.displayName || team.name || 'Team')}</h4>${FOOTBALL_CATEGORIES.map(category => renderFootballCategory(category, categories[category.name], seasonAverages)).join('')}</section>`;
}
function extractFootballPlayerStats(summary, card) {
  const groups = summary.boxscore?.players || [];
  if (!groups.length) return '<p class="empty-stats">Football player stats are not available for this game yet.</p>';
  const home = groups.find(group => String(group.team?.id) === String(card.dataset.homeTeam));
  const away = groups.find(group => String(group.team?.id) === String(card.dataset.awayTeam));
  return [home, away].filter(Boolean).map(team => renderFootballTeam(team.team, Object.fromEntries(FOOTBALL_CATEGORIES.map(category => [category.name, footballTeamRows(team, category)])))).join('');
}
function footballAthletes(roster) {
  return (roster.athletes || []).flatMap(group => group.items || []);
}
function rosterFootballRows(players, category) {
  const matchingPlayers = players.filter(player => category.positions.includes(player.position?.abbreviation));
  const rows = matchingPlayers.map(player => {
    const stats = player.seasonStats || {};
    const values = Object.fromEntries(category.columns.map(([label, aliases]) => {
      const value = label === 'GP'
        ? player.footballAverages?.[category.name]?.GP ?? stats.GP ?? 0
        : player.footballAverages?.[category.name]?.[label] ?? aliases.map(key => stats[key]).find(item => item !== undefined && item !== null);
      return [label, value ?? '—'];
    }));
    return { athlete: player, values };
  });
  if (rows.some(row => Number(row.values.GP) > 0)) {
    for (let index = rows.length - 1; index >= 0; index--) {
      if (!(Number(rows[index].values.GP) > 0)) rows.splice(index, 1);
    }
  }
  const totals = Object.fromEntries(category.columns.map(([label]) => {
    const values = rows.map(row => String(row.values[label] ?? '—')).filter(value => value !== '—');
    if (!values.length || ['QBR', 'RTG'].includes(label)) return [label, '—'];
    if (label === 'GP') return [label, String(Math.max(...values.map(Number).filter(Number.isFinite), 0))];
    if (label === 'LONG') return [label, String(Math.max(...values.map(Number).filter(Number.isFinite)))];
    if (label === 'AVG' && category.name === 'Rushing') {
      const carries = rows.reduce((sum, row) => sum + (Number(row.values.CAR) || 0), 0);
      const yards = rows.reduce((sum, row) => sum + (Number(row.values.YDS) || 0), 0);
      return [label, carries ? (yards / carries).toFixed(1) : '—'];
    }
    if (label === 'AVG' && category.name === 'Passing') {
      const attempts = rows.reduce((sum, row) => sum + (Number(String(row.values['C/ATT']).split('/')[1]) || 0), 0);
      const yards = rows.reduce((sum, row) => sum + (Number(row.values.YDS) || 0), 0);
      return [label, attempts ? (yards / attempts).toFixed(1) : '—'];
    }
    if (label === 'PCT' && category.name === 'Kicking') {
      const made = rows.reduce((sum, row) => sum + (Number(String(row.values.FG).split('/')[0]) || 0), 0);
      const attempts = rows.reduce((sum, row) => sum + (Number(String(row.values.FG).split('/')[1]) || 0), 0);
      return [label, attempts ? ((made / attempts) * 100).toFixed(1) : '—'];
    }
    if (!values.length) return [label, '—'];
    if (values.every(value => /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(value))) {
      const sums = values.map(value => value.split('/').map(Number)).reduce((sum, value) => [sum[0] + value[0], sum[1] + value[1]], [0, 0]);
      return [label, `${sums[0].toFixed(1).replace(/\.0$/, '')}/${sums[1].toFixed(1).replace(/\.0$/, '')}`];
    }
    const numeric = values.map(value => Number(value));
    return [label, numeric.every(Number.isFinite) ? numeric.reduce((sum, value) => sum + value, 0).toFixed(1).replace(/\.0$/, '') : '—'];
  }));
  rows.sort((a, b) => Number(b.values.GP || 0) - Number(a.values.GP || 0));
  return { players: rows, totals };
}
async function fetchFootballRoster(teamId) {
  const key = `football:${teamId}`;
  if (FOOTBALL_ROSTER_CACHE.has(key)) return FOOTBALL_ROSTER_CACHE.get(key);
  const request = (async () => {
    const response = await fetch(`${ESPN}/football/college-football/teams/${teamId}/roster`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`ESPN roster returned ${response.status}`);
    const roster = await response.json();
    const athletes = footballAthletes(roster);
    return { team: roster.team || {}, athletes };
  })();
  FOOTBALL_ROSTER_CACHE.set(key, request);
  try { return await request; }
  catch (error) { FOOTBALL_ROSTER_CACHE.delete(key); throw error; }
}
async function extractUpcomingFootballRoster(card) {
  const [home, away] = await Promise.all([fetchFootballRoster(card.dataset.homeTeam), fetchFootballRoster(card.dataset.awayTeam)]);
  return { rosters: [home, away], html: [home, away].map(roster => renderFootballTeam(roster.team, Object.fromEntries(FOOTBALL_CATEGORIES.map(category => [category.name, rosterFootballRows(roster.athletes, category)])), true)).join('') };
}
function footballPerGameAverages(games, teamId) {
  const statsByCategory = Object.fromEntries(FOOTBALL_CATEGORIES.map(category => [category.name, new Map()]));
  for (const { event, summary } of games) {
    const team = (summary.boxscore?.players || []).find(group => String(group.team?.id) === String(teamId));
    if (!team) continue;
    for (const category of FOOTBALL_CATEGORIES) {
      const { players } = footballTeamRows(team, category);
      const seasonPlayers = statsByCategory[category.name];
      for (const { athlete, values } of players) {
        const id = String(athlete.id || athlete.displayName);
        const player = seasonPlayers.get(id) || { athlete, games: new Set(), sums: {}, pairs: {}, highs: {}, means: {} };
        player.games.add(event.id);
        for (const [label] of category.columns) {
          const value = String(values[label] ?? '—');
          if (value === '—' || value === '--') continue;
          if (/^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(value)) {
            const [first, second] = value.split('/').map(Number);
            const pair = player.pairs[label] || [0, 0];
            pair[0] += first; pair[1] += second;
            player.pairs[label] = pair;
          } else if (Number.isFinite(Number(value))) {
            const number = Number(value);
            if (label === 'LONG') player.highs[label] = Math.max(player.highs[label] ?? -Infinity, number);
            else {
              player.sums[label] = (player.sums[label] || 0) + number;
              if (['AVG', 'PCT', 'QBR', 'RTG'].includes(label)) {
                const mean = player.means[label] || { sum: 0, count: 0 };
                mean.sum += number; mean.count++;
                player.means[label] = mean;
              }
            }
          }
        }
        seasonPlayers.set(id, player);
      }
    }
  }
  return Object.fromEntries(FOOTBALL_CATEGORIES.map(category => {
    const values = new Map();
    for (const [id, player] of statsByCategory[category.name]) {
      const gamesPlayed = Math.max(player.games.size, 1);
      const perGame = {};
      perGame.GP = gamesPlayed;
      for (const [label] of category.columns) {
        if (label === 'GP') continue;
        if (player.pairs[label]) perGame[label] = player.pairs[label].map(value => (value / gamesPlayed).toFixed(1)).join('/');
        else if (label === 'LONG' && player.highs[label] !== undefined) perGame[label] = String(player.highs[label]);
        else if (label === 'AVG' && category.name === 'Rushing' && player.sums.CAR) perGame[label] = (player.sums.YDS / player.sums.CAR).toFixed(1);
        else if (label === 'AVG' && category.name === 'Passing' && player.pairs['C/ATT']?.[1]) perGame[label] = (player.sums.YDS / player.pairs['C/ATT'][1]).toFixed(1);
        else if (label === 'PCT' && player.pairs.FG?.[1]) perGame[label] = ((player.pairs.FG[0] / player.pairs.FG[1]) * 100).toFixed(1);
        else if (player.means[label]?.count) perGame[label] = (player.means[label].sum / player.means[label].count).toFixed(1);
        else if (player.sums[label] !== undefined) perGame[label] = (player.sums[label] / gamesPlayed).toFixed(1);
        else perGame[label] = '—';
      }
      values.set(id, perGame);
    }
    return [category.name, values];
  }));
}
async function fetchFootballSeasonAverages(teamId) {
  const cacheKey = String(teamId);
  if (FOOTBALL_SEASON_CACHE.has(cacheKey)) return FOOTBALL_SEASON_CACHE.get(cacheKey);
  const request = (async () => {
    const scheduleResponse = await fetch(`${ESPN}/football/college-football/teams/${teamId}/schedule`, { signal: AbortSignal.timeout(12000) });
    if (!scheduleResponse.ok) throw new Error(`ESPN schedule returned ${scheduleResponse.status}`);
    const schedule = await scheduleResponse.json();
    const completed = (schedule.events || []).filter(event => {
      const state = event.status?.type?.state || event.competitions?.[0]?.status?.type?.state;
      return state === 'post' && new Date(event.date) <= new Date();
    });
    const results = await Promise.allSettled(completed.map(async event => {
      const response = await fetch(`${ESPN}/football/college-football/summary?event=${event.id}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`ESPN summary returned ${response.status}`);
      return { event, summary: await response.json() };
    }));
    return footballPerGameAverages(results.filter(result => result.status === 'fulfilled').map(result => result.value), teamId);
  })();
  FOOTBALL_SEASON_CACHE.set(cacheKey, request);
  try { return await request; }
  catch (error) { FOOTBALL_SEASON_CACHE.delete(cacheKey); throw error; }
}
async function loadUpcomingFootballAverages(card, rosters) {
  for (const roster of rosters) {
    const categoryAverages = await fetchFootballSeasonAverages(roster.team.id);
    for (const athlete of roster.athletes) {
      const id = String(athlete.id);
      athlete.footballAverages = Object.fromEntries(FOOTBALL_CATEGORIES.map(category => [category.name, categoryAverages[category.name]?.get(id) || {}]));
    }
  }
  if (!card.isConnected || card.dataset.state !== 'pre') return;
  const pane = card.querySelector('.stats-pane[data-pane="players"]');
  if (!pane) return;
  pane.innerHTML = rosters.map(roster => renderFootballTeam(roster.team, Object.fromEntries(FOOTBALL_CATEGORIES.map(category => [category.name, rosterFootballRows(roster.athletes, category)])), true)).join('');
}
function extractPlayerStats(summary, card) {
  if (card.dataset.sport === 'basketball') return extractBasketballPlayerStats(summary, card);
  return extractFootballPlayerStats(summary, card);
}
async function loadSummary(card) {
  if (card.dataset.loaded === 'true' || card.dataset.loading === 'true') return;
  card.dataset.loading = 'true';
  const panes = card.querySelectorAll('.stats-pane');
  panes.forEach(pane => { pane.innerHTML = '<p class="empty-stats"><span class="refresh-spinner"></span> Loading game stats…</p>'; });
  const { sport, league, event } = card.dataset;
  const useRosterAverages = card.dataset.state === 'pre';
  let summary = null;
  try {
    const response = await fetch(`${ESPN}/${sport}/${league}/summary?event=${event}`);
    if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
    summary = await response.json();
  } catch {
    if (!useRosterAverages) {
      panes.forEach(pane => { pane.innerHTML = '<p class="empty-stats">Could not load stats from ESPN. Close and reopen to try again.</p>'; });
      card.dataset.loading = 'false';
      return;
    }
  }
  panes[0].innerHTML = summary ? extractGameStats(summary, card) : '<p class="empty-stats">Game stats are available after the game begins.</p>';
  if (useRosterAverages) {
    try {
      if (sport === 'basketball') panes[1].innerHTML = await extractUpcomingBasketballRoster(card);
      else {
        const { rosters, html } = await extractUpcomingFootballRoster(card);
        panes[1].innerHTML = html;
        loadUpcomingFootballAverages(card, rosters).catch(() => {});
      }
    }
    catch { panes[1].innerHTML = '<p class="empty-stats">Roster averages could not be loaded right now.</p>'; }
  } else {
    panes[1].innerHTML = extractPlayerStats(summary, card);
  }
  card.dataset.loaded = 'true';
  card.dataset.loading = 'false';
}

dateInput.value = todayString();
$('#timezone-select').value = timezone;
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$('#timezone-select').addEventListener('change', event => {
  timezone = event.target.value;
  localStorage.setItem('hawkeye-sideline-zone', timezone);
  loadGames();
});
dateInput.addEventListener('change', () => {
  selectedDateMode = true;
  $('#upcoming-button').hidden = false;
  loadGames();
});
$('#upcoming-button').addEventListener('click', () => {
  selectedDateMode = false;
  dateInput.value = todayString();
  $('#upcoming-button').hidden = true;
  loadGames();
});
gameList.addEventListener('toggle', event => {
  const details = event.target.closest('details.game-detail');
  if (details?.open) loadSummary(details.closest('.game-card'));
}, true);
gameList.addEventListener('click', event => {
  const button = event.target.closest('.stats-tabs button');
  if (!button) return;
  const content = button.closest('.stats-content');
  content.querySelectorAll('.stats-tabs button').forEach(item => item.classList.toggle('selected', item === button));
  content.querySelectorAll('.stats-pane').forEach(pane => pane.classList.toggle('selected', pane.dataset.pane === button.dataset.tab));
});
$('.team-pills').addEventListener('click', event => {
  const button = event.target.closest('.team-pill');
  if (!button) return;
  const { league } = button.dataset;
  if (visibleLeagues.size === LEAGUES.length) {
    visibleLeagues.clear();
    visibleLeagues.add(league);
  } else if (visibleLeagues.size === 1 && visibleLeagues.has(league)) {
    LEAGUES.forEach(config => visibleLeagues.add(config.league));
  } else {
    visibleLeagues.clear();
    visibleLeagues.add(league);
  }
  $('.team-pills').querySelectorAll('.team-pill').forEach(pill => {
    const active = visibleLeagues.has(pill.dataset.league);
    pill.classList.toggle('active', active);
    pill.setAttribute('aria-pressed', String(active));
  });
  renderFilteredFeed(!selectedDateMode);
});
window.addEventListener('touchstart', event => { if (window.scrollY === 0) pullStart = event.touches[0].clientY; }, { passive: true });
window.addEventListener('touchmove', event => {
  if (pullStart === null || window.scrollY !== 0) return;
  const distance = event.touches[0].clientY - pullStart;
  if (distance > 35) $('#pull-indicator').classList.add('visible');
  if (distance > 80) $('#pull-indicator').classList.add('ready');
}, { passive: true });
window.addEventListener('touchend', () => {
  if ($('#pull-indicator').classList.contains('ready')) {
    $('#pull-indicator').innerHTML = '<span class="refresh-spinner"></span> Refreshing scores';
    loadGames().finally(() => setTimeout(() => $('#pull-indicator').classList.remove('visible', 'ready'), 600));
  } else $('#pull-indicator').classList.remove('visible', 'ready');
  pullStart = null;
}, { passive: true });
loadGames();
