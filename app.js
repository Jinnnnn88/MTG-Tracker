// Replace these with your actual Supabase Project URL and Anon Key
const SUPABASE_URL = 'https://dgjyqxidptjeoyujdbnu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnanlxeGlkcHRqZW95dWpkYm51Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NDM1NjQsImV4cCI6MjA5NzExOTU2NH0.KJkUAUpO5KQ5KoTvDrtM_fekLc5fZjn6_CMN6e9YitE';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const THEME_KEY = 'mtgGameTracker.theme.dev'; // Theme stays in localStorage

const seatFields = [
  { key: 'first', seat: 1 },
  { key: 'second', seat: 2 },
  { key: 'third', seat: 3 },
  { key: 'last', seat: 4 }
];
const legacyPositionMap = { first: 1, second: 2, third: 3, last: 4 };
const colorNames = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

let currentGame = { date: null, players: [], index: null };
let games = [];
let commanderData = {};
let rageQuits = [];
let currentRageQuitIndex = null;
let pendingFetches = new Set();
let chartInstances = {};
let chartViewMode = 'weekly'; // Track current chart view state
let commanderSearchQuery = '';
let colorSearchQuery = '';

// --- UI Feedback Helpers ---
let loadingCount = 0;
function showLoading() {
  loadingCount++;
  document.getElementById('loading-overlay').style.display = 'flex';
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) document.getElementById('loading-overlay').style.display = 'none';
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  
  container.appendChild(toast);
  
  // Auto-remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.5s ease-out forwards';
    setTimeout(() => toast.remove(), 500);
  }, 3000);
}

// Replacing standard alerts with toasts
function notifyError(msg) {
    console.error(msg);
    showToast(msg, 'error');
}
function notifySuccess(msg) {
    showToast(msg, 'success');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function ordinal(value) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[Number(value)] || 'N/A';
}

function keyForSeat(seat) {
  return (seatFields.find(field => field.seat === Number(seat)) || seatFields[0]).key;
}

function titleCase(text) {
  return (text || '').trim().replace(/\b\w+/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function formatDateUK(dateStr) {
  if (!dateStr || !dateStr.includes('-')) return dateStr;
  return dateStr.split('-').reverse().join('/');
}

function getStartOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
  return new Date(date.setDate(diff)).toISOString().split('T')[0];
}

function normalisePlayer(player) {
  const legacyRank = legacyPositionMap[player.position] || 1;
  const seat = Number(player.seat) || legacyRank;
  const commander = titleCase(player.commander);

  return {
    seat,
    name: titleCase(player.name),
    commander,
    isWinner: !!player.isWinner
  };
}

function normaliseGames(rawGames) {
  let changed = false;
  const normalisedGames = rawGames.map(game => {
    const players = (game.players || []).map(player => {
      const normalisedPlayer = normalisePlayer(player);
      if (normalisedPlayer.seat !== player.seat || normalisedPlayer.finish !== player.finish) {
        // changed = true; // Cleanup finish positions if they exist
      }
      return normalisedPlayer;
    });
    return { date: game.date, players: players };
  });

  return { games: normalisedGames, changed: changed };
}

function ensureCommanderData(commanderName) {
  if (!commanderName) return null;
  if (!commanderData[commanderName]) commanderData[commanderName] = { image: null, colors: [], colorsFetched: false };
  if (!Array.isArray(commanderData[commanderName].colors)) commanderData[commanderName].colors = [];
  if (commanderData[commanderName].colorsFetched === undefined) {
    commanderData[commanderName].colorsFetched = commanderData[commanderName].colors.length > 0;
  }
  return commanderData[commanderName];
}

function getCommanderImage(commanderName) {
  return commanderData[commanderName] ? commanderData[commanderName].image : null;
}

function getCommanderColors(commanderName) {
    return commanderData[commanderName] ? commanderData[commanderName].colors || [] : [];
}

async function syncToSupabase(table, data, matchKey = 'id') {
    // Helper to push local changes to cloud
    const { error } = await sb.from(table).upsert(data);
    if (error) console.error(`Error syncing ${table}:`, error);
}

async function loadAllData() {
    // Load everything from Supabase instead of LocalStorage
    showLoading();
    const [gamesRes, cmdRes, rageRes] = await Promise.all([
        sb.from('games').select('*').order('date', { ascending: true }),
        sb.from('commander_data').select('*'),
        sb.from('rage_quits').select('*').order('date', { ascending: false })
    ]);

    if (gamesRes.error) console.error("Supabase Load Error (Games):", gamesRes.error.message);
    if (cmdRes.error) console.error("Supabase Load Error (Commanders):", cmdRes.error.message);
    if (rageRes.error) console.error("Supabase Load Error (Salt):", rageRes.error.message);

    const gameCount = gamesRes.data?.length || 0;
    console.log(`Fetched ${gameCount} games from Supabase`);

    if (gameCount === 0 && !gamesRes.error) {
        console.warn("Fetched 0 games. If you expected data, check if Row Level Security (RLS) policies are missing in Supabase.");
    }

    if (gamesRes.data) games = gamesRes.data;
    if (rageRes.data) rageQuits = rageRes.data;
    
    if (cmdRes.data) {
        commanderData = {};
        cmdRes.data.forEach(row => {
            commanderData[row.name] = { 
                image: row.image, 
                colors: row.colors, 
                colorsFetched: row.colors_fetched 
            };
        });
    }

    populateDataLists();
    renderCommanderLibrary();
    renderGameHistory();
    renderStats();
    renderRageQuits();
    
    hideLoading();
}

async function fetchCommanderImage(commanderName) {
  if (!commanderName) return null;
  if (pendingFetches.has(commanderName)) return null;
  const data = ensureCommanderData(titleCase(commanderName));
  
  // Skip if we have art AND have successfully fetched color info previously
  if (data.image && data.colorsFetched) return data.image;

  try {
    pendingFetches.add(commanderName);
    showLoading();
    const response = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(commanderName)}`);
    if (!response.ok) throw new Error('Card not found');
    const card = await response.json();
    let imageUrl = null;

    if (card.image_uris) {
      imageUrl = card.image_uris.art_crop;
    } else if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) {
      imageUrl = card.card_faces[0].image_uris.art_crop;
    }

    commanderData[commanderName] = {
      image: imageUrl,
      colors: Array.isArray(card.color_identity) ? card.color_identity : [],
      colorsFetched: true
    };
    
    await syncToSupabase('commander_data', {
        name: commanderName,
        image: imageUrl,
        colors: commanderData[commanderName].colors,
        colors_fetched: true
    }, 'name');

    return imageUrl;
  } catch (error) {
    console.error("Scryfall Fetch Failed. If using Brave, try lowering Shields:", error);
    // Store a placeholder or empty state to prevent constant re-fetching of invalid names
    if (!commanderData[commanderName].image) commanderData[commanderName].image = '';
  } finally {
    pendingFetches.delete(commanderName);
    hideLoading();
  }
}

async function fetchScryfallAutocomplete(query) {
  if (query.length < 3) return [];
  try {
    const url = `https://api.scryfall.com/cards/search?q=is:commander+name:${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    if (data.data && Array.isArray(data.data)) {
      return data.data.map(card => card.name);
    }
    return [];
  } catch (error) {
    return [];
  }
}

function updateCommanderDatalistWithScryfall(key, suggestions) {
  const list = document.getElementById(`commanders-${key}-list`);
  if (!list) return;
  list.innerHTML = suggestions.map(name => `<option value="${escapeHtml(name)}">`).join('');
}

function updatePortraitPreview(position) {
  const cmdInput = document.getElementById(`commander-${position}`);
  const commanderName = cmdInput ? titleCase(cmdInput.value) : '';
  const portraitDiv = document.getElementById(`portrait-${position}`);
  const image = getCommanderImage(commanderName);

  if (commanderName && image && image !== '') {
    portraitDiv.innerHTML = `
      <div class="commander-display commander-link" data-commander-detail="${escapeHtml(commanderName)}">
        <img src="${escapeHtml(image)}" alt="${escapeHtml(commanderName)}" class="commander-portrait">
        <div class="commander-name-display">${escapeHtml(commanderName)}</div>
      </div>
    `;
  } else {
    portraitDiv.innerHTML = '📷';
  }
}

function renderCommanderLibrary(filterText = '') {
  const library = document.getElementById('commander-library');
  const query = filterText.toLowerCase();
  
  // Always sort alphabetically by default
  const allCommanders = Object.keys(commanderData).sort();

  // Update datalist for autofill suggestions
  const libraryDatalist = document.getElementById('library-commander-list');
  if (libraryDatalist) {
    libraryDatalist.innerHTML = allCommanders.map(name => `<option value="${escapeHtml(name)}">`).join('');
  }

  const filteredCommanders = allCommanders.filter(name => name.toLowerCase().includes(query));

  if (filteredCommanders.length === 0) {
    library.innerHTML = `<p style="grid-column: 1/-1; color: #999;">${filterText ? 'No matches found.' : 'No commanders yet. Enter a commander to fetch art.'}</p>`;
    return;
  }

  library.innerHTML = filteredCommanders.map(name => {
    const image = getCommanderImage(name);
    return `
      <div class="commander-card">
        <div class="commander-link" data-commander-detail="${escapeHtml(name)}">
          ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name)}">` : '<div class="history-card-portrait">📷</div>'}
          <div class="commander-card-name">${escapeHtml(name)}</div>
        </div>
        <button class="delete-commander-image secondary" data-commander="${escapeHtml(name)}">Remove Art Cache</button>
      </div>
    `;
  }).join('');
}

function getCommanderOptionsForPlayer(playerName, map, globalOptions) {
  if (playerName && map[playerName]) {
    return Array.from(map[playerName]).sort().map(cmd => `<option value="${escapeHtml(cmd)}">`).join('');
  }
  return globalOptions;
}

function populatePlayerDataLists() {
  const playerNames = new Set();
  games.forEach(game => game.players.forEach(player => {
    if (player.name) playerNames.add(player.name);
  }));
  const playerOptions = Array.from(playerNames).sort().map(name => `<option value="${escapeHtml(name)}">`).join('');
  seatFields.forEach(field => {
    const list = document.getElementById(`player-${field.key}-names-list`);
    if (list) list.innerHTML = playerOptions;
  });
}

function populateCommanderDataLists() {
  const commanders = new Set(Object.keys(commanderData));
  const playerCommanderMap = {};

  games.forEach(game => {
    game.players.forEach(player => {
      if (!player.commander) return;
      commanders.add(player.commander);
      if (!playerCommanderMap[player.name]) playerCommanderMap[player.name] = new Set();
      playerCommanderMap[player.name].add(player.commander);
    });
  });

  const globalCommanderOptions = Array.from(commanders).sort().map(cmd => `<option value="${escapeHtml(cmd)}">`).join('');
  seatFields.forEach(field => {
    const nameInput = document.getElementById(`player-${field.key}-name`);
    const list = document.getElementById(`commanders-${field.key}-list`);
    if (list) list.innerHTML = getCommanderOptionsForPlayer(
      nameInput ? nameInput.value.trim() : '',
      playerCommanderMap,
      globalCommanderOptions
    );
  });
}

function populateDataLists() {
  populatePlayerDataLists();
  populateCommanderDataLists();
}

function getSeatPlayers() {
  const winnerToggle = document.querySelector('.winner-toggle.active');
  const winnerKey = winnerToggle ? winnerToggle.dataset.seatKey : null;
  return seatFields.map(field => {
    const commander = titleCase(document.getElementById(`commander-${field.key}`).value);
    ensureCommanderData(commander);
    return {
      seat: field.seat,
      name: titleCase(document.getElementById(`player-${field.key}-name`).value),
      commander,
      isWinner: field.key === winnerKey
    };
  });
}

function validateGame(players) {
  const date = document.getElementById('game-date').value;
  if (!date) {
    showToast('Please select a game date.', 'error');
    return null;
  }

  const validPlayers = players.filter(player => player.name && player.commander);
  
  // Duplicate player name validation
  const names = validPlayers.map(p => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) {
    showToast('The same player cannot be selected more than once in the same game.', 'error');
    return null;
  }

  if (validPlayers.length < 1) {
    showToast('Please enter at least 1 player.', 'error');
    return null;
  }

  const winner = players.find(p => p.isWinner);
  
  if (!winner) {
    showToast('Please select a game winner.', 'error');
    return null;
  }

  if (!winner.name || !winner.commander) {
    showToast('Selected winner needs a name/commander.', 'error');
    return null;
  }

  return validPlayers;
}

function renderGameHistory(filterText = '') {
  const container = document.getElementById('game-history-list');
  if (!container) return;
  container.innerHTML = '';

  if (games.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #999;">No games recorded yet. Start a new game to get started!</div>';
    return;
  }

  const query = filterText.toLowerCase();
  
  // If searching, show all matches. If not, show last 5.
  const displayGames = filterText 
    ? games.map((g, i) => ({ ...g, originalIndex: i })).filter(game => 
        game.players.some(p => p.name.toLowerCase().includes(query) || p.commander.toLowerCase().includes(query)) ||
        game.date.includes(query)
      ).reverse()
    : games.map((g, i) => ({ ...g, originalIndex: i })).slice(-5).reverse();

  if (displayGames.length === 0 && filterText) {
    container.innerHTML = `<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #999;">No matches found for "${escapeHtml(filterText)}"</div>`;
    return;
  }

  displayGames.forEach((game) => {
    const index = game.originalIndex;
    const winner = game.players.find(player => player.isWinner);
    const playersHtml = [...game.players].sort((a, b) => a.seat - b.seat).map(player => {
      const isWinner = player.isWinner ? ' winner' : '';
      const medal = player.isWinner ? ' 🏆' : '';
      const image = getCommanderImage(player.commander);
      const portraitHtml = image
        ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(player.commander)}">`
        : '📷';
      const seatLabel = seatFields.find(f => f.seat === player.seat)?.key || player.seat;
      return `
        <div class="history-player${isWinner}">
          <div class="history-player-portrait commander-link" data-commander-detail="${escapeHtml(player.commander)}">${portraitHtml}</div>
          <div class="history-player-info">
            <div class="history-player-position">${escapeHtml(seatLabel)}</div>
            <div class="history-player-name player-link" data-player-detail="${escapeHtml(player.name)}">${escapeHtml(player.name)}${medal}</div>
            <div class="history-player-commander commander-link" data-commander-detail="${escapeHtml(player.commander)}">${escapeHtml(player.commander)}</div>
          </div>
        </div>
      `;
    }).join('');

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="history-card-content">
        <div class="history-card-header">
          <h3>${escapeHtml(formatDateUK(game.date))}</h3>
          <div class="history-card-winner">${winner ? escapeHtml(winner.name) : 'N/A'}</div>
        </div>
        <div class="history-card-players">${playersHtml}</div>
        <div class="history-actions">
          <button class="edit-game secondary" data-index="${index}">Edit</button>
          <button class="delete-game secondary" data-index="${index}">Delete</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function emptyPlacementStats() {
  return { games: 0, wins: 0 };
}

function calculateStats() {
  const playerStats = {};
  const commanderStats = {};
  const seatStats = {};
  const colorStats = {};
  const monthlyGames = {};
  const weeklyGames = {};
  const playerMatchups = {}; // { playerA: { playerB: { gamesTogether: 0, opponentWins: 0 } } }
  const commanderMatchups = {}; // { cmdA: { cmdB: { games: 0, winsAgainst: 0 } } }
  const playerRivalries = {}; // { "PlayerA vs PlayerB": { games: 0, wins: { PlayerA: 0, PlayerB: 0 } } }
  const deckDiversityStats = {}; // { playerName: { games: 0, commanders: Set } }
  const dayOfWeekStats = { 'Sunday': 0, 'Monday': 0, 'Tuesday': 0, 'Wednesday': 0, 'Thursday': 0, 'Friday': 0, 'Saturday': 0 };

  games.forEach(game => {
    if (game.date) {
      const month = game.date.slice(0, 7);
      monthlyGames[month] = (monthlyGames[month] || 0) + 1;

      const week = getStartOfWeek(game.date);
      weeklyGames[week] = (weeklyGames[week] || 0) + 1;

      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const [y, m, d] = game.date.split('-').map(Number);
      if (y && m && d) {
        const dayIndex = new Date(y, m - 1, d).getDay();
        const dayName = days[dayIndex];
        dayOfWeekStats[dayName] = (dayOfWeekStats[dayName] || 0) + 1;
      }
    }

    // Calculate player rivalries
    const validPlayers = game.players.filter(p => p.name).map(p => titleCase(p.name));
    const winner = game.players.find(p => p.isWinner);
    const winnerName = winner && winner.name ? titleCase(winner.name) : null;
    
    for (let i = 0; i < validPlayers.length; i++) {
      for (let j = i + 1; j < validPlayers.length; j++) {
        const pA = validPlayers[i];
        const pB = validPlayers[j];
        const key = [pA, pB].sort().join(' vs ');
        
        if (!playerRivalries[key]) {
          playerRivalries[key] = { games: 0, wins: { [pA]: 0, [pB]: 0 } };
        }
        playerRivalries[key].games++;
        if (winnerName === pA) playerRivalries[key].wins[pA]++;
        if (winnerName === pB) playerRivalries[key].wins[pB]++;
      }
    }

    game.players.forEach(player => {
      if (!player.name || !player.commander) return;

      const playerKey = player.name;
      const commanderKey = player.commander;
      const seatLabel = seatFields.find(f => f.seat === player.seat)?.key || player.seat;
      const isWin = player.isWinner;

      // Track Player Matchups
      if (!playerMatchups[playerKey]) playerMatchups[playerKey] = {};
      game.players.forEach(other => {
        if (!other.name || other.name === playerKey) return;
        if (!playerMatchups[playerKey][other.name]) {
          playerMatchups[playerKey][other.name] = { gamesTogether: 0, opponentWins: 0 };
        }
        playerMatchups[playerKey][other.name].gamesTogether++;
        if (other.isWinner) {
          playerMatchups[playerKey][other.name].opponentWins++;
        }
      });

      // Track Matchups
      if (!commanderMatchups[commanderKey]) commanderMatchups[commanderKey] = {};
      game.players.forEach(other => {
        if (!other.commander || other.commander === commanderKey) return;
        const otherKey = other.commander;
        if (!commanderMatchups[commanderKey][otherKey]) {
          commanderMatchups[commanderKey][otherKey] = { games: 0, winsAgainst: 0 };
        }
        commanderMatchups[commanderKey][otherKey].games++;
        if (isWin) {
          commanderMatchups[commanderKey][otherKey].winsAgainst++;
        }
      });

      if (!playerStats[playerKey]) playerStats[playerKey] = { ...emptyPlacementStats(), currentStreak: 0, maxStreak: 0, giantSlays: 0, commanders: {} };
      if (!commanderStats[commanderKey]) commanderStats[commanderKey] = emptyPlacementStats();
      if (!seatStats[seatLabel]) seatStats[seatLabel] = { games: 0, wins: 0 };
      if (!deckDiversityStats[playerKey]) deckDiversityStats[playerKey] = { games: 0, commanders: new Set() };

      playerStats[playerKey].commanders[commanderKey] = (playerStats[playerKey].commanders[commanderKey] || 0) + 1;
      deckDiversityStats[playerKey].games += 1;
      deckDiversityStats[playerKey].commanders.add(commanderKey);

      [playerStats[playerKey], commanderStats[commanderKey]].forEach(stats => {
        stats.games += 1;
        if (isWin) stats.wins += 1;
      });
      
      seatStats[seatLabel].games += 1;
      if (isWin) {
        seatStats[seatLabel].wins += 1;
      }

      const colors = getCommanderColors(player.commander);
      const identity = colors.length > 0
        ? ['W', 'U', 'B', 'R', 'G']
            .filter(c => colors.includes(c))
            .map(c => colorNames[c])
            .join(', ')
        : 'Colourless';

      if (!colorStats[identity]) colorStats[identity] = { appearances: 0, wins: 0 };
      colorStats[identity].appearances += 1;
      if (isWin) colorStats[identity].wins += 1;
    });
  });

  // Calculate current win streaks (chronological order)
  const chronologicalGames = [...games].sort((a, b) => a.date.localeCompare(b.date));
  chronologicalGames.forEach(game => {
    // Capture streaks before this game's results are applied
    const preGameStreaks = {};
    game.players.forEach(p => {
      preGameStreaks[p.name] = playerStats[p.name]?.currentStreak || 0;
    });

    game.players.forEach(p => {
      if (!p.name || !playerStats[p.name]) return;
      if (p.isWinner) {
        // Check if winner ended any opponent's streak of 3 or more
        const killedGiant = game.players.some(opp => opp.name !== p.name && preGameStreaks[opp.name] >= 3);
        if (killedGiant) {
          playerStats[p.name].giantSlays += 1;
        }
        playerStats[p.name].currentStreak += 1;
      } else {
        playerStats[p.name].currentStreak = 0;
      }
      playerStats[p.name].maxStreak = Math.max(playerStats[p.name].maxStreak, playerStats[p.name].currentStreak);
    });
  });

  const deckDiversity = Object.fromEntries(
    Object.entries(deckDiversityStats).map(([playerName, stats]) => [
      playerName,
      {
        games: stats.games,
        uniqueCommanders: stats.commanders.size,
        diversityRate: stats.games ? stats.commanders.size / stats.games : 0
      }
    ])
  );

  return { playerStats, commanderStats, seatStats, colorStats, monthlyGames, weeklyGames, commanderMatchups, playerMatchups, playerRivalries, dayOfWeekStats, deckDiversity };
}

function renderStatCard(icon, label, value, subtitle, detailsHtml = '', extraClass = '') {
  return `
    <div class="stat-card ${extraClass}">
      <div class="stat-icon">${icon}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-subtitle">${escapeHtml(subtitle)}</div>
      ${detailsHtml ? `<div class="stat-card-details">${detailsHtml}</div>` : ''}
    </div>
  `;
}

function renderStatsDashboard(stats = calculateStats()) {
  const dashboard = document.getElementById('stats-dashboard');
  if (!games.length) {
    if (dashboard) dashboard.innerHTML = '<p>No games recorded yet.</p>';
    return;
  }

  const topPlayer = Object.entries(stats.playerStats).sort((a, b) => b[1].wins - a[1].wins || a[1].games - b[1].games)[0];
  const topCommander = Object.entries(stats.commanderStats).sort((a, b) => b[1].wins - a[1].wins || a[1].games - b[1].games)[0];
  const bestCommander = Object.entries(stats.commanderStats)
    .filter(([, value]) => value.games >= 5)
    .sort((a, b) => (b[1].wins / b[1].games) - (a[1].wins / a[1].games) || b[1].wins - a[1].wins)[0];

  const activeStreaks = Object.entries(stats.playerStats).filter(([, s]) => s.currentStreak > 0);
  const hottestPlayer = activeStreaks.sort((a, b) => b[1].currentStreak - a[1].currentStreak || b[1].wins - a[1].wins)[0];

  // Determine if the current hottest streak is the all-time record
  const globalMaxStreak = Math.max(...Object.values(stats.playerStats).map(s => s.maxStreak || 0), 0);
  const isBreakingRecord = hottestPlayer && hottestPlayer[1].currentStreak === globalMaxStreak && globalMaxStreak > 0;
  const hottestCardClass = isBreakingRecord ? 'record-breaker' : '';

  // Calculate Biggest Rivalry
  let rivalry = { pair: [], games: 0 };
  Object.entries(stats.commanderMatchups).forEach(([cmdA, targets]) => {
    Object.entries(targets).forEach(([cmdB, s]) => {
      // Use alphabetical sort to ensure A vs B and B vs A are counted as the same pair
      const pair = [cmdA, cmdB].sort();
      // To avoid double counting (A vs B and B vs A), only consider one direction
      if (pair[0] === cmdA) {
        if (s.games > rivalry.games) {
          rivalry = { pair, games: s.games };
        }
      }
    });
  });

  const rivalryLabel = rivalry.pair.length 
    ? `<div style="font-size:0.9rem; line-height:1.2;">${commanderCell(rivalry.pair[0])}<br><small>vs</small><br>${commanderCell(rivalry.pair[1])}</div>`
    : 'N/A';

  const hottestPlayersDetails = `
    <div class="stat-detail-title">Historic Best Streaks</div>
    ${Object.entries(stats.playerStats)
      .filter(([, s]) => s.maxStreak > 0)
      .sort((a, b) => b[1].maxStreak - a[1].maxStreak || b[1].wins - a[1].wins)
      .slice(0, 5)
      .map(([name, s]) => `
        <div class="stat-detail-row">
          <span class="stat-detail-name player-link" data-player-detail="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="stat-detail-val">${s.maxStreak} <small>Wins</small></span>
        </div>
      `).join('') || '<div class="stat-detail-row"><span class="stat-detail-name">No streaks recorded</span></div>'}
  `;

  const topPlayersDetails = `
    <div class="stat-detail-title">Top Players (By Wins)</div>
    ${Object.entries(stats.playerStats)
      .sort((a, b) => b[1].wins - a[1].wins || a[1].games - b[1].games)
      .slice(0, 5)
      .map(([name, s]) => `
        <div class="stat-detail-row">
          <span class="stat-detail-name player-link" data-player-detail="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="stat-detail-val">${s.wins} <small>(${(s.wins/s.games*100).toFixed(0)}%)</small></span>
        </div>
      `).join('')}
  `;

  const topCommandersDetails = `
    <div class="stat-detail-title">Top Commanders (By Wins)</div>
    ${Object.entries(stats.commanderStats)
      .sort((a, b) => b[1].wins - a[1].wins || a[1].games - b[1].games)
      .slice(0, 4)
      .map(([name, s]) => `
        <div class="stat-detail-row">
          <span class="stat-detail-name commander-link" data-commander-detail="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="stat-detail-val">${s.wins} <small>(${(s.wins/s.games*100).toFixed(0)}%)</small></span>
        </div>
      `).join('')}
  `;

  if (dashboard) {
    dashboard.innerHTML = `
      ${renderStatCard('&#x1F3AE;', 'Total Games', games.length, 'Games stored')}
      ${renderStatCard('&#x2694;&#xFE0F;', 'Classic Rivalry', rivalryLabel, rivalry.games > 0 ? `${rivalry.games} Encounters` : 'No data')}
      ${renderStatCard('&#x1F525;', 'Current Hottest Streak', hottestPlayer ? `<span class="player-link" data-player-detail="${escapeHtml(hottestPlayer[0])}">${escapeHtml(hottestPlayer[0])}</span>` : 'N/A', hottestPlayer ? `${hottestPlayer[1].currentStreak} Wins Row` : 'No active streaks', hottestPlayersDetails, hottestCardClass)}
      ${renderStatCard('&#x1F3C6;', 'Top Player', topPlayer ? `<span class="player-link" data-player-detail="${escapeHtml(topPlayer[0])}">${escapeHtml(topPlayer[0])}</span>` : 'N/A', `${topPlayer ? topPlayer[1].wins : 0} Wins`, topPlayersDetails)}
      ${renderStatCard('&#x1F451;', 'Top Commander', topCommander ? commanderCell(topCommander[0]) : 'N/A', `${topCommander ? topCommander[1].wins : 0} Wins`, topCommandersDetails)}
      ${renderStatCard('&#x1F525;', 'Best Win Rate', bestCommander ? commanderCell(bestCommander[0]) : 'N/A', bestCommander ? `${((bestCommander[1].wins / bestCommander[1].games) * 100).toFixed(0)}%` : 'Needs 5 games')}
    `;
  }
}

function commanderCell(name) {
  return `<span class="commander-link" data-commander-detail="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
}

function getCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null;
}

function renderAchievementBadge(icon, name, desc, current, target) {
  const progress = Math.min((current / target) * 100, 100);
  const isUnlocked = progress >= 100;
  return `
    <div class="achievement-badge ${isUnlocked ? '' : 'locked'}">
      <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
        <span class="achievement-icon">${isUnlocked ? icon : '🔒'}</span>
        <div class="achievement-info">
          <span class="achievement-name">${name}</span>
          <span class="achievement-desc">${desc}</span>
        </div>
      </div>
      <div class="achievement-progress-bg">
        <div class="achievement-progress-fill" style="width: ${progress}%"></div>
      </div>
    </div>
  `;
}

function winRateCell(wins, games) {
  const rate = games > 0 ? (wins / games * 100).toFixed(0) : 0;
  return `
    <div class="win-rate-wrapper">
      <span>${rate}% <small style="color:var(--muted-text)">(${wins}/${games})</small></span>
      <div class="win-rate-bar-bg">
        <div class="win-rate-bar-fill" style="width: ${rate}%"></div>
      </div>
    </div>
  `;
}

function renderTable(title, headers, data, sortFn, rowFn) {
  const rows = Object.entries(data).sort(sortFn).map(rowFn).join('');
  return `
    <div class="stats-table-container">
      <table>
        <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length}">No data available</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function renderActiveDaysSummary(dayOfWeekStats) {
  const sortedDays = Object.entries(dayOfWeekStats).sort((a, b) => b[1] - a[1]);
  const maxGames = Math.max(...sortedDays.map(([, total]) => total), 1);
  const shortDayNames = {
    Sunday: 'Sun',
    Monday: 'Mon',
    Tuesday: 'Tue',
    Wednesday: 'Wed',
    Thursday: 'Thu',
    Friday: 'Fri',
    Saturday: 'Sat'
  };

  return sortedDays.map(([day, total]) => {
    const pct = games.length > 0 ? Math.round((total / games.length) * 100) : 0;
    const barWidth = Math.round((total / maxGames) * 100);
    return `
      <div class="active-day-row">
        <div class="active-day-label">${escapeHtml(shortDayNames[day] || day)}</div>
        <div class="active-day-bar-bg">
          <div class="active-day-bar-fill" style="width: ${barWidth}%"></div>
        </div>
        <div class="active-day-count">${total} <small>(${pct}%)</small></div>
      </div>
    `;
  }).join('');
}

function renderStats() {
  if (!games.length) {
    const dashboard = document.getElementById('stats-dashboard');
    if (dashboard) dashboard.innerHTML = '<p>No games recorded yet.</p>';
    destroyCharts();
    const chartGrid = document.getElementById('stats-charts');
    if (chartGrid) chartGrid.style.display = 'none';
    setHtml('commander-stats-table-content', '');
    setHtml('seat-advantage-table-content', '');
    setHtml('color-statistics-table-content', '');
    setHtml('giant-slayers-table-content', '');
    setHtml('deck-diversity-table-content', '');
    setHtml('active-days-table-content', '');
    return;
  }

  const stats = calculateStats();
  renderStatsDashboard(stats);
  renderCharts(stats);

  // --- Commander Stats Search Logic ---
  const cmdQuery = commanderSearchQuery.trim().toLowerCase();
  const filteredCommanders = Object.entries(stats.commanderStats)
    .filter(([name]) => !cmdQuery || name.toLowerCase().includes(cmdQuery));
  
  // Sort by Wins (descending), then by Games (ascending) for efficiency tie-breaker
  let finalCommanders = filteredCommanders.sort((a, b) => b[1].wins - a[1].wins || a[1].games - b[1].games);
  if (!cmdQuery) finalCommanders = finalCommanders.slice(0, 10);
  
  // Suggestions: ONLY populate if user has started typing
  const cmdSuggestionsHtml = cmdQuery 
    ? filteredCommanders.filter(([name]) => name.toLowerCase() !== cmdQuery).slice(0, 15).map(([name]) => `<option value="${escapeHtml(name)}">`).join('') 
    : '';
  const commanderDatalist = document.getElementById('stats-commander-list');
  if (commanderDatalist && commanderDatalist.innerHTML !== cmdSuggestionsHtml) commanderDatalist.innerHTML = cmdSuggestionsHtml;

  const cmdInfo = document.getElementById('commander-stats-info');
  if (cmdInfo) cmdInfo.textContent = cmdQuery ? `Found ${filteredCommanders.length}` : 'Showing Top 10';
  
  const cmdTable = document.getElementById('commander-stats-table-content');
  if (cmdTable) cmdTable.innerHTML = renderTable('Commander Stats', ['Commander', 'Performance'], Object.fromEntries(finalCommanders),
    (a, b) => b[1].wins - a[1].wins || a[1].games - b[1].games,
    ([k, v]) => `<tr><td>${commanderCell(k)}</td><td>${winRateCell(v.wins, v.games)}</td></tr>`);

  const seatTable = document.getElementById('seat-advantage-table-content');
  if (seatTable) seatTable.innerHTML = renderTable('Seat Advantage', ['Seat', 'Performance'], stats.seatStats,
    (a, b) => (b[1].wins/b[1].games) - (a[1].wins/a[1].games) || 0,
    ([k, v]) => `<tr><td>${escapeHtml(k.charAt(0).toUpperCase() + k.slice(1))}</td><td>${winRateCell(v.wins, v.games)}</td></tr>`);

  // --- Colour Stats Search Logic ---
  const clrQuery = colorSearchQuery.trim().toLowerCase();
  const filteredColors = Object.entries(stats.colorStats)
    .filter(([name]) => !clrQuery || name.toLowerCase().includes(clrQuery));

  // Apply Top Performance logic: Wins first, then fewer appearances
  let finalColors = filteredColors.sort((a, b) => b[1].wins - a[1].wins || a[1].appearances - b[1].appearances);
  if (!clrQuery) finalColors = finalColors.slice(0, 10);

  // Suggestions: ONLY populate if user has started typing
  const clrSuggestionsHtml = clrQuery 
    ? filteredColors.filter(([name]) => name.toLowerCase() !== clrQuery).slice(0, 15).map(([name]) => `<option value="${escapeHtml(name)}">`).join('') 
    : '';
  const colorDatalist = document.getElementById('stats-color-list');
  if (colorDatalist && colorDatalist.innerHTML !== clrSuggestionsHtml) colorDatalist.innerHTML = clrSuggestionsHtml;

  const clrInfo = document.getElementById('color-stats-info');
  if (clrInfo) clrInfo.textContent = clrQuery ? `Found ${filteredColors.length}` : 'Showing Top 10';
  
  const clrTable = document.getElementById('color-statistics-table-content');
  if (clrTable) clrTable.innerHTML = renderTable('Colour Statistics', ['Colour', 'Performance'], Object.fromEntries(finalColors),
    (a, b) => b[1].wins - a[1].wins || a[1].appearances - b[1].appearances,
    ([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${winRateCell(v.wins, v.appearances)}</td></tr>`);

  const deckDiversityTable = document.getElementById('deck-diversity-table-content');
  if (deckDiversityTable) {
    deckDiversityTable.innerHTML = renderTable('Deck Diversity', ['Player', 'Decks Used'], stats.deckDiversity,
      (a, b) => b[1].uniqueCommanders - a[1].uniqueCommanders || b[1].diversityRate - a[1].diversityRate || b[1].games - a[1].games,
      ([k, v]) => `<tr>
        <td><span class="player-link" data-player-detail="${escapeHtml(k)}">${escapeHtml(k)}</span></td>
        <td>${v.uniqueCommanders} unique <small style="color:var(--muted-text)">(${v.games} games, ${Math.round(v.diversityRate * 100)}%)</small></td>
      </tr>`);
  }

  const activeDaysTable = document.getElementById('active-days-table-content');
  if (activeDaysTable) {
    activeDaysTable.innerHTML = renderActiveDaysSummary(stats.dayOfWeekStats);
  }
}

function destroyCharts() {
  Object.values(chartInstances).forEach(chart => chart.destroy());
  chartInstances = {};
}

function createChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  if (chartInstances[id]) chartInstances[id].destroy();
  canvas.style.width = '100%';
  canvas.style.height = '240px';
  chartInstances[id] = new Chart(canvas, config);
}

function renderCharts(stats) {
  const chartGrid = document.getElementById('stats-charts');
  if (!games.length || typeof Chart === 'undefined') {
    if (chartGrid) chartGrid.style.display = 'none';
    destroyCharts();
    return;
  }
  if (chartGrid) chartGrid.style.display = 'grid';

  // Chart.js defaults for better theme integration
  const bodyTextColor = getCssVariable('--body-text') || '#666666';
  const borderColor = getCssVariable('--border-color') || '#e2e8f0';
  const accentColor = getCssVariable('--accent-blue') || '#2563eb';

  Chart.defaults.color = bodyTextColor;
  Chart.defaults.borderColor = borderColor;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.plugins.tooltip.backgroundColor = getCssVariable('--card-bg') || '#ffffff';
  Chart.defaults.plugins.tooltip.titleColor = getCssVariable('--header-text') || '#000000';
  Chart.defaults.plugins.tooltip.bodyColor = bodyTextColor;
  Chart.defaults.plugins.tooltip.borderColor = borderColor;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.legend.labels.color = bodyTextColor;

  const isWeekly = chartViewMode === 'weekly';
  const dataMap = isWeekly ? stats.weeklyGames : stats.monthlyGames;
  const dataset = Object.entries(dataMap).sort((a, b) => a[0].localeCompare(b[0]));

  createChart('monthly-games-chart', {
    type: 'line',
    data: {
      labels: dataset.map(([label]) => isWeekly ? `W/C ${label}` : label),
      datasets: [{ label: 'Games', data: dataset.map(([, total]) => total), borderColor: getCssVariable('--chart-red') || '#ef4444', backgroundColor: getCssVariable('--chart-red-alpha') || 'rgba(239,68,68,0.1)', tension: 0.25, fill: true }]
    },
    options: { 
      animation: false, 
      responsive: true, 
      maintainAspectRatio: false, 
      resizeDelay: 100,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 }
        }
      }
    }
  });
}

function resetCurrentGame() {
  const today = new Date().toISOString().split('T')[0];
  const dateInput = document.getElementById('game-date');
  if (dateInput) dateInput.value = today;

  seatFields.forEach(field => {
    const nameInput = document.getElementById(`player-${field.key}-name`);
    const cmdInput = document.getElementById(`commander-${field.key}`);
    if (nameInput) nameInput.value = '';
    if (cmdInput) cmdInput.value = '';
    document.querySelectorAll('.winner-toggle').forEach(btn => btn.classList.remove('active'));
    updatePortraitPreview(field.key);
  });
  currentGame = { date: today, players: [], index: null };
  const editMode = document.getElementById('edit-mode');
  const cancelEdit = document.getElementById('cancel-edit');
  if (editMode) editMode.style.display = 'none';
  if (cancelEdit) cancelEdit.style.display = 'none';
}

function notifyClear() {
    showToast('Form cleared.', 'info');
}

function openCommanderModal(commanderName) {
  if (!commanderName) return;
  const appearances = [];
  games.forEach(game => {
    game.players.forEach(player => {
      if (player.commander === commanderName) {
        appearances.push({ date: game.date, player: player.name, isWinner: player.isWinner });
      }
    });
  });

  const gamesPlayed = appearances.length;
  const wins = appearances.filter(item => item.isWinner).length;
  const players = [...new Set(appearances.map(item => item.player))].sort();
  const sortedAppearances = appearances.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const firstPlayed = sortedAppearances.length ? sortedAppearances[sortedAppearances.length - 1].date : 'N/A';
  const lastPlayed = sortedAppearances.length ? sortedAppearances[0].date : 'N/A';
  const image = getCommanderImage(commanderName);
  const colors = getCommanderColors(commanderName);
  
  const allStats = calculateStats();
  const matchups = allStats.commanderMatchups[commanderName] || {};
  const nemesisEntry = Object.entries(matchups)
    .filter(([, s]) => s.games >= 2) // Minimum 2 games for a nemesis
    .sort((a, b) => (a[1].winsAgainst / a[1].games) - (b[1].winsAgainst / b[1].games))[0];

  const milestonesHtml = [
    renderAchievementBadge('💯', 'Century Club', '100 Games', gamesPlayed, 100),
    renderAchievementBadge('🎖️', 'Veteran', '25 Wins', wins, 25)
  ].join('');

  const matchupsHtml = Object.entries(matchups)
    .sort((a, b) => b[1].games - a[1].games)
    .slice(0, 5)
    .map(([opp, s]) => `<tr><td>${commanderCell(opp)}</td><td>${s.games}</td><td>${((s.winsAgainst/s.games)*100).toFixed(0)}%</td></tr>`)
    .join('') || '<tr><td colspan="3">No matchup data yet.</td></tr>';

  const modalBody = document.getElementById('commander-modal-body');
  if (modalBody) {
    modalBody.innerHTML = `
      ${image ? `<img class="modal-art" src="${escapeHtml(image)}" alt="${escapeHtml(commanderName)}">` : '<div class="modal-art"></div>'}
      <div class="modal-body-inner">
        <h2 id="commander-modal-title">${escapeHtml(commanderName)}</h2>
        <div class="modal-stats-grid">
          <div class="modal-stat"><div class="modal-stat-label">Games Played</div><div class="modal-stat-value">${gamesPlayed}</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Wins</div><div class="modal-stat-value">${wins}</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Win Rate</div><div class="modal-stat-value">${gamesPlayed ? ((wins / gamesPlayed) * 100).toFixed(0) : 0}%</div></div>
        </div>
        <section>
          <h3>Milestones</h3>
          <div class="modal-list">${milestonesHtml}</div>
        </section>
        <div class="modal-stats-grid">
          <div class="modal-stat" style="grid-column: 1 / -1; border-color: var(--chart-red);">
            <div class="modal-stat-label">Top Nemesis</div>
            <div class="modal-stat-value">${nemesisEntry ? commanderCell(nemesisEntry[0]) : 'None yet'}</div>
            <div style="font-size:0.8rem; color:var(--muted-text);">${nemesisEntry ? `Wins only ${((nemesisEntry[1].winsAgainst/nemesisEntry[1].games)*100).toFixed(0)}% of the time vs this deck` : 'Play more games to find a rival'}</div>
          </div>
        </div>
        <section>
          <h3>Colour Identity</h3>
          <div class="modal-list">${colors.length ? colors.map(c => `<span class="modal-pill pill-${c}">${escapeHtml(colorNames[c] || c)}</span>`).join('') : '<span class="modal-pill">Unknown</span>'}</div>
        </section>
        <section>
          <h3>Head-to-Head Matchups</h3>
          <div class="stats-table-container">
            <table><thead><tr><th>Opponent</th><th>Games</th><th>Performance</th></tr></thead>
            <tbody>${matchupsHtml}</tbody></table>
          </div>
        </section>
        <section>
          <h3>Players</h3>
          <div class="modal-list">${players.length ? players.map(player => `<span class="modal-pill player-link" data-player-detail="${escapeHtml(player)}">${escapeHtml(player)}</span>`).join('') : '<span class="modal-pill">No games yet</span>'}</div>
        </section>
        <section>
          <h3>Recent Games</h3>
          <table><tbody>${sortedAppearances.slice(0, 5).map(item => `<tr><td>${escapeHtml(formatDateUK(item.date))}</td><td><span class="player-link" data-player-detail="${escapeHtml(item.player)}">${escapeHtml(item.player)}</span></td><td>${item.isWinner ? '🏆 Win' : 'Loss'}</td></tr>`).join('') || '<tr><td>No appearances yet.</td></tr>'}</tbody></table>
        </section>
        <div class="modal-date-grid">
          <div class="modal-stat"><div class="modal-stat-label">First Played</div><div class="modal-stat-value">${escapeHtml(formatDateUK(firstPlayed))}</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Last Played</div><div class="modal-stat-value">${escapeHtml(formatDateUK(lastPlayed))}</div></div>
        </div>
      </div>
    `;
  }

  const modal = document.getElementById('commander-modal');
  if (modal) {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function closeCommanderModal() {
  const modal = document.getElementById('commander-modal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

function renderRageQuits() {
  const countEl = document.getElementById('rage-quit-count');
  if (countEl) countEl.textContent = rageQuits.length;

  const daysCountEl = document.getElementById('days-count');
  if (daysCountEl && rageQuits.length > 0) {
    const latestSalt = rageQuits.reduce((latest, current) => {
      return new Date(current.date) > new Date(latest.date) ? current : latest;
    }, rageQuits[0]);
    const today = new Date(); today.setHours(0,0,0,0);
    const saltDate = new Date(latestSalt.date); saltDate.setHours(0,0,0,0);
    const diffDays = Math.floor(Math.abs(today - saltDate) / (1000 * 60 * 60 * 24));

    daysCountEl.textContent = diffDays;
    daysCountEl.style.color = diffDays > 7 ? 'var(--chart-green)' : 'var(--chart-red)';
  }

  const listEl = document.getElementById('rage-quit-history-list');
  if (listEl) {
    const historyHtml = rageQuits
      .map((rq, idx) => ({ ...rq, originalIndex: idx }))
      .sort((a, b) => b.date.localeCompare(a.date)) // Sort newest first
      .map(rq => `
        <div style="background: var(--row-bg); padding: 16px; border-radius: 12px; margin-bottom: 12px; border: 1px solid var(--border-color); animation: fadeIn 0.3s ease-out;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div style="font-size: 0.75rem; color: var(--muted-text); font-weight: 800; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.05em;">
              ${escapeHtml(formatDateUK(rq.date))}
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="edit-rage-quit secondary" data-index="${rq.originalIndex}" style="padding: 2px 8px; font-size: 0.7rem; margin: 0;">Edit</button>
              <button class="delete-rage-quit secondary" data-index="${rq.originalIndex}" style="padding: 2px 8px; font-size: 0.7rem; margin: 0;">Delete</button>
            </div>
          </div>
          <div style="font-size: 1.1rem; font-weight: 600; color: var(--header-text); line-height: 1.4; margin-top: 4px; white-space: pre-wrap;">${escapeHtml(rq.reason || 'No reason provided...')}</div>
        </div>
      `).join('');
    listEl.innerHTML = historyHtml || '<p style="text-align: center; color: var(--muted-text); margin-top: 20px;">No salt recorded yet. Jason is behaving...</p>';
  }
}

function openPlayerModal(playerName) {
  if (!playerName) return;
  const playerGames = [];
  const commanderUsage = {};

  games.forEach(game => {
    const p = game.players.find(player => player.name === playerName);
    if (p) {
      playerGames.push({ date: game.date, commander: p.commander, isWinner: p.isWinner, seat: p.seat });
      commanderUsage[p.commander] = (commanderUsage[p.commander] || 0) + 1;
    }
  });

  const allStats = calculateStats();
  const stats = allStats.playerStats[playerName] || { games: 0, wins: 0, currentStreak: 0, maxStreak: 0, giantSlays: 0 };
  const favCommanders = Object.entries(commanderUsage).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sortedHistory = playerGames.sort((a, b) => b.date.localeCompare(a.date));

  // Player Nemesis Logic
  const matchups = allStats.playerMatchups[playerName] || {};
  const nemesisEntry = Object.entries(matchups)
    .filter(([, s]) => s.gamesTogether >= 3) // Need a sample size of 3 games
    .sort((a, b) => (b[1].opponentWins / b[1].gamesTogether) - (a[1].opponentWins / a[1].gamesTogether))[0];

  const nemesisName = nemesisEntry ? nemesisEntry[0] : null;
  const vengeanceWins = (nemesisName && allStats.playerMatchups[nemesisName] && allStats.playerMatchups[nemesisName][playerName])
    ? allStats.playerMatchups[nemesisName][playerName].opponentWins
    : 0;

  const seatWinsArr = [1, 2, 3, 4].map(s => playerGames.filter(g => g.isWinner && g.seat === s).length);
  const uniqueSeatsWon = seatWinsArr.filter(w => w > 0).length;
  const polymathCount = Object.values(commanderUsage).filter(count => count >= 20).length;

  const achievementsHtml = [
    renderAchievementBadge('💯', 'Century Club', '100 Games', stats.games, 100),
    renderAchievementBadge('👑', 'The Finisher', '50 Wins', stats.wins, 50),
    renderAchievementBadge('⚔️', 'Giant Slayer', '5 Bosses Defeated', stats.giantSlays, 5),
    renderAchievementBadge('🩸', 'Vengeance', 'Beat your Nemesis', vengeanceWins, 1),
    renderAchievementBadge('🐕', 'Underdog', '5 Seat 4 Wins', playerGames.filter(g => g.isWinner && g.seat === 4).length, 5),
    renderAchievementBadge('🏠', 'Full House', 'Win from all seats', uniqueSeatsWon, 4),
    renderAchievementBadge('🧠', 'Polymath', '3 Decks (20+ games)', polymathCount, 3)
  ].filter((_, i) => {
    // Only show if unlocked or has some progress
    const vals = [stats.games, stats.wins, stats.giantSlays, vengeanceWins, playerGames.filter(g => g.isWinner && g.seat === 4).length, uniqueSeatsWon, polymathCount];
    return vals[i] > 0;
  }).join('');

  const modalBody = document.getElementById('commander-modal-body'); // Using commander-modal-body for player details
  if (modalBody) {
    modalBody.innerHTML = `
      <div class="modal-body-inner">
        <h2 id="commander-modal-title">${escapeHtml(playerName)}</h2>
        <div class="modal-stats-grid">
          <div class="modal-stat"><div class="modal-stat-label">Total Games</div><div class="modal-stat-value">${stats.games}</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Total Wins</div><div class="modal-stat-value">${stats.wins}</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Win Rate</div><div class="modal-stat-value">${stats.games ? ((stats.wins / stats.games) * 100).toFixed(0) : 0}%</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Longest Streak</div><div class="modal-stat-value">${stats.maxStreak} Wins</div></div>
          <div class="modal-stat"><div class="modal-stat-label">Current Streak</div><div class="modal-stat-value">${stats.currentStreak} Wins</div></div>
        </div>
        <div class="modal-stats-grid">
          <div class="modal-stat" style="grid-column: 1 / -1; border-color: var(--chart-red);">
            <div class="modal-stat-label">Personal Nemesis</div>
            <div class="modal-stat-value">${nemesisName ? `<span class="player-link" data-player-detail="${escapeHtml(nemesisName)}">${escapeHtml(nemesisName)}</span>` : 'None yet'}</div>
            <div style="font-size:0.8rem; color:var(--muted-text);">${nemesisEntry ? `They win ${((nemesisEntry[1].opponentWins/nemesisEntry[1].gamesTogether)*100).toFixed(0)}% of games you play together` : 'Play more games to find your rival'}</div>
          </div>
        </div>
        <section>
          <h3>Achievements</h3>
          <div class="modal-list">${achievementsHtml || '<p style="color:var(--muted-text); font-size:0.9rem;">Play more games to reveal achievements!</p>'}</div>
        </section>
        <section>
          <h3>Master of the Table</h3>
          <div class="modal-date-grid">
            <div class="modal-stat"><div class="modal-stat-label">Seat 1 Wins</div><div class="modal-stat-value">${seatWinsArr[0]}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Seat 2 Wins</div><div class="modal-stat-value">${seatWinsArr[1]}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Seat 3 Wins</div><div class="modal-stat-value">${seatWinsArr[2]}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Seat 4 Wins</div><div class="modal-stat-value">${seatWinsArr[3]}</div></div>
          </div>
        </section>
        <section>
          <h3>Favorite Commanders</h3>
          <div class="modal-list">
            ${favCommanders.map(([cmd, count]) => `
              <span class="modal-pill commander-link" data-commander-detail="${escapeHtml(cmd)}">
                ${escapeHtml(cmd)} (${count})
              </span>
            `).join('') || '<span class="modal-pill">None</span>'}
          </div>
        </section>
        <section>
          <h3>Recent Performance</h3>
          <div class="stats-table-container">
            <table>
              <thead>
                <tr><th>Date</th><th>Commander</th><th>Result</th></tr>
              </thead>
              <tbody>
                ${sortedHistory.slice(0, 10).map(item => `
                  <tr>
                    <td>${escapeHtml(formatDateUK(item.date))}</td>
                    <td><span class="commander-link" data-commander-detail="${escapeHtml(item.commander)}">${escapeHtml(item.commander)}</span></td>
                    <td>${item.isWinner ? '🏆 Win' : 'Loss'}</td>
                  </tr>
                `).join('') || '<tr><td colspan="3">No games played yet.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;
  }

  const modal = document.getElementById('commander-modal'); // Re-using commander modal for player details
  if (modal) {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeToggleButton(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  updateThemeToggleButton(next);
  renderStats();
}

function updateThemeToggleButton(theme) {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
}

function updateBountyIcons() {
  const stats = calculateStats();
  const seatLabels = {
    first: 'Seat 1 (1st to Play)',
    second: 'Seat 2 (2nd to Play)',
    third: 'Seat 3 (3rd to Play)',
    last: 'Seat 4 (Last to Play)'
  };
  seatFields.forEach(field => {
    const nameInput = document.getElementById(`player-${field.key}-name`);
    const label = nameInput?.parentElement?.querySelector('h4');
    if (!label) return;
    
    const playerName = titleCase(nameInput.value);
    const streak = stats.playerStats[playerName]?.currentStreak || 0;
    const seatLabelText = seatLabels[field.key] || field.key;
    label.innerHTML = `${seatLabelText} ${streak >= 3 ? `<span title="Bounty Active: ${streak} Win Streak" style="cursor:help;">🎯</span>` : ''}`;
  });
}

window.addEventListener('load', () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const gameDateInput = document.getElementById('game-date');
    if (gameDateInput) gameDateInput.value = today;
    
    if (document.getElementById('rage-quit-date')) document.getElementById('rage-quit-date').value = today;
    currentGame.date = today;

    const safeAddListener = (id, event, callback) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, callback);
    };

    safeAddListener('theme-toggle', 'click', toggleTheme);

    document.querySelectorAll('.winner-toggle').forEach(button => {
      button.addEventListener('click', (e) => {
        const btn = e.target.closest('.winner-toggle');
        document.querySelectorAll('.winner-toggle').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
      });
    });

    initTheme();
    loadAllData();

    const autocompleteTimers = {};

    seatFields.forEach(field => {
      safeAddListener(`player-${field.key}-name`, 'input', () => {
        populateCommanderDataLists();
        updateBountyIcons();
      });

      safeAddListener(`commander-${field.key}`, 'input', async (e) => {
        const query = e.target.value;
        clearTimeout(autocompleteTimers[field.key]);
        if (query.length < 3) {
          populateCommanderDataLists(); // Revert to showing local recorded commanders
          return;
        }
        autocompleteTimers[field.key] = setTimeout(async () => {
          const suggestions = await fetchScryfallAutocomplete(query);
          updateCommanderDatalistWithScryfall(field.key, suggestions);
        }, 300);
      });

      safeAddListener(`commander-${field.key}`, 'change', async () => {
        const input = document.getElementById(`commander-${field.key}`);
        const name = titleCase(input.value);
        input.value = name;
        if (name && (!commanderData[name] || !commanderData[name].image)) {
          await fetchCommanderImage(name);
          renderCommanderLibrary(); renderStats(); updatePortraitPreview(field.key);
        }
        updatePortraitPreview(field.key);
      });
    });

    const navItems = document.querySelectorAll('.nav-item');
    const tabContents = document.querySelectorAll('.tab-content');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const targetTab = item.getAttribute('data-tab');
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        tabContents.forEach(content => {
          content.classList.remove('active');
          if (content.id === targetTab) content.classList.add('active');
        });
        if (targetTab === 'tab-stats') renderStats();
        if (targetTab === 'tab-history') renderGameHistory();
        if (targetTab === 'tab-rage-quits') renderRageQuits();
      });
    });

    safeAddListener('history-search', 'input', (e) => renderGameHistory(e.target.value));
    safeAddListener('commander-stats-search', 'input', (e) => { commanderSearchQuery = e.target.value; renderStats(); });
    safeAddListener('color-stats-search', 'input', (e) => { colorSearchQuery = e.target.value; renderStats(); });
    safeAddListener('library-search', 'input', (e) => renderCommanderLibrary(e.target.value));
    safeAddListener('export-data-btn', 'click', exportData);
    safeAddListener('import-data-btn', 'click', () => document.getElementById('import-file-input').click());
    safeAddListener('import-file-input', 'change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader(); reader.onload = (event) => importData(event.target.result); reader.readAsText(file);
    });
    safeAddListener('toggle-weekly', 'click', () => { chartViewMode = 'weekly'; document.getElementById('toggle-weekly').classList.add('active'); document.getElementById('toggle-monthly').classList.remove('active'); renderStats(); });
    safeAddListener('toggle-monthly', 'click', () => { chartViewMode = 'monthly'; document.getElementById('toggle-monthly').classList.add('active'); document.getElementById('toggle-weekly').classList.remove('active'); renderStats(); });

    safeAddListener('save-game', 'click', async event => {
      event.preventDefault();
      const validPlayers = validateGame(getSeatPlayers());
      if (!validPlayers) return;
      const game = { date: document.getElementById('game-date').value, players: validPlayers };
      
      showLoading();
      // If we are editing, include the ID so Supabase updates the existing record
      if (currentGame.index !== null && games[currentGame.index]) {
          game.id = games[currentGame.index].id;
      }

      const { error } = await sb.from('games').upsert(game);
      if (!error) {
          await loadAllData();
          resetCurrentGame();
          showToast('Game saved successfully!', 'success');
      } else {
          notifyError("Error saving game: " + error.message);
      }
      hideLoading();
    });

    safeAddListener('cancel-edit', 'click', () => { currentGame.index = null; resetCurrentGame(); });
    safeAddListener('clear-game', 'click', () => { 
        if (confirm('Clear current entries?')) {
            resetCurrentGame();
            showToast('Form cleared.', 'info');
        }
    });

    safeAddListener('game-history-list', 'click', async event => {
      if (event.target.matches('.delete-game')) {
        const index = Number(event.target.dataset.index);
        if (confirm('Delete entry?')) {
            const gameId = games[index].id;
            showLoading();
            try {
                const { error } = await sb.from('games').delete().eq('id', gameId);
                if (error) {
                    notifyError("Error deleting game: " + error.message);
                } else {
                    await loadAllData();
                    showToast('Game deleted.', 'info');
                }
            } catch (err) {
                notifyError("Error deleting game: " + err.message);
            } finally {
                hideLoading();
            }
        }
      }
      if (event.target.matches('.edit-game')) {
        const index = Number(event.target.dataset.index); const game = games[index];
        resetCurrentGame(); currentGame.index = index; document.getElementById('game-date').value = game.date;
        game.players.forEach(p => {
          const key = keyForSeat(p.seat);
          document.getElementById(`player-${key}-name`).value = p.name;
          document.getElementById(`commander-${key}`).value = p.commander;
          if (p.isWinner) document.querySelector(`.winner-toggle[data-seat-key="${key}"]`).classList.add('active');
          updatePortraitPreview(key);
        });
        document.querySelector('[data-tab="tab-record"]').click();
      }
    });

    safeAddListener('commander-library', 'click', async event => {
      if (event.target.matches('.delete-commander-image')) {
        const name = event.target.dataset.commander; 
        if (confirm(`Delete art for ${name}?`)) {
            showLoading();
            try {
                const { error } = await sb.from('commander_data').delete().eq('name', name);
                if (error) {
                    notifyError("Error removing art cache: " + error.message);
                } else {
                    await loadAllData();
                    showToast('Art cache removed.', 'info');
                }
            } catch (err) {
                notifyError("Error removing art cache: " + err.message);
            } finally {
                hideLoading();
            }
        }
      }
    });

    safeAddListener('record-rage-quit', 'click', async () => {
      const rInput = document.getElementById('rage-quit-reason'); const dInput = document.getElementById('rage-quit-date');
      const reason = rInput ? rInput.value.trim() : ''; const date = dInput ? dInput.value : '';
      
      const rqData = { date, reason };
      if (currentRageQuitIndex !== null && rageQuits[currentRageQuitIndex]) {
          rqData.id = rageQuits[currentRageQuitIndex].id;
      }

      showLoading();
      await sb.from('rage_quits').upsert(rqData);
      
      currentRageQuitIndex = null;
      if (rInput) rInput.value = '';
      const cancelBtn = document.getElementById('cancel-rage-edit');
      if (cancelBtn) cancelBtn.style.display = 'none';
      document.getElementById('record-rage-quit').textContent = 'RECORD RAGE QUIT';

      await loadAllData();
      showToast('The salt has been recorded.', 'success');
      hideLoading();
    });

    safeAddListener('cancel-rage-edit', 'click', () => {
      currentRageQuitIndex = null;
      document.getElementById('rage-quit-reason').value = '';
      document.getElementById('rage-quit-date').value = new Date().toISOString().split('T')[0];
      document.getElementById('cancel-rage-edit').style.display = 'none';
      document.getElementById('record-rage-quit').textContent = 'RECORD RAGE QUIT';
    });

    safeAddListener('rage-quit-history-list', 'click', async event => {
      if (event.target.matches('.delete-rage-quit')) {
        const index = Number(event.target.dataset.index);
        if (confirm('Delete this salt record?')) {
            const id = rageQuits[index].id;
            showLoading();
            try {
                const { error } = await sb.from('rage_quits').delete().eq('id', id);
                if (error) {
                    notifyError("Error deleting salt record: " + error.message);
                } else {
                    await loadAllData();
                    showToast('Salt record deleted.', 'info');
                }
            } catch (err) {
                notifyError("Error deleting salt: " + err.message);
            } finally {
                hideLoading();
            }
        }
      }
      if (event.target.matches('.edit-rage-quit')) {
        const index = Number(event.target.dataset.index);
        const rq = rageQuits[index];
        currentRageQuitIndex = index;
        document.getElementById('rage-quit-date').value = rq.date;
        document.getElementById('rage-quit-reason').value = rq.reason || '';
        document.getElementById('cancel-rage-edit').style.display = 'block';
        document.getElementById('record-rage-quit').textContent = 'UPDATE RAGE QUIT';
        window.scrollTo({ top: document.getElementById('salt-recording-ui').offsetTop - 100, behavior: 'smooth' });
      }
    });

    document.body.addEventListener('click', event => {
      const c = event.target.closest('[data-commander-detail]');
      if (c) {
        openCommanderModal(c.dataset.commanderDetail);
        return;
      }
      const p = event.target.closest('[data-player-detail]');
      if (p) {
        openPlayerModal(p.dataset.playerDetail);
        return;
      }
    });

    safeAddListener('commander-modal-close', 'click', closeCommanderModal);
    safeAddListener('commander-modal', 'click', e => { if (e.target.id === 'commander-modal') closeCommanderModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCommanderModal(); });

  } catch (err) { console.error("Init failed:", err); }
});

function exportData() {
  const data = { games, commanderData, rageQuits, exportDate: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `mtg_backup.json`; a.click(); URL.revokeObjectURL(url);
}

function importData(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    const gamesToImport = data.games || [];
    const rageQuitsToImport = data.rageQuits || [];
    const commanderDataToImport = data.commanderData || {};

    if (confirm(`Migrating ${gamesToImport.length} games. This may take a moment. Continue?`)) {
        const runImport = async () => {
            showLoading();
            // We strip any existing IDs from local data to let Supabase generate fresh UUIDs
            const cleanGames = gamesToImport.map(({ id, created_at, ...rest }) => ({
                date: rest.date,
                players: rest.players
            }));
            const cleanRage = rageQuitsToImport.map(({ id, ...rest }) => ({
                date: rest.date,
                reason: rest.reason
            }));

            const results = await Promise.all([
                gamesToImport.length ? sb.from('games').insert(cleanGames) : Promise.resolve({ error: null }),
                rageQuitsToImport.length ? sb.from('rage_quits').insert(cleanRage) : Promise.resolve({ error: null }),
                Object.keys(commanderDataToImport).length ? sb.from('commander_data').upsert(
                    Object.entries(commanderDataToImport).map(([name, val]) => ({
                    name,
                    image: val.image || '',
                    colors: val.colors,
                    colors_fetched: !!(val.colorsFetched || (val.colors && val.colors.length > 0))
                    }))
                ) : Promise.resolve({ error: null })
            ]);

            const errors = results.filter(r => r.error);
            if (errors.length > 0) {
                console.error("Import failed. Likely cause: RLS Policies.", errors);
                const msg = errors.map(e => e.error.message).join('\n');
                notifyError(`Import failed: ${msg}`);
            } else {
                showToast("Import successful!", "success");
                location.reload();
            }
            hideLoading();
        };
        runImport();
    }
  } catch (e) { notifyError("Import Failed: " + e.message); }
}
