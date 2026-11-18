(() => {
  "use strict";

  const setupNotice = document.getElementById("setupNotice");
  const publicView = document.getElementById("publicView");
  const adminView = document.getElementById("adminView");
  const modeButton = document.getElementById("modeButton");

  const publicTabs = [
    ["dashboard", "Dashboard"],
    ["schedule", "Fixtures"],
    ["matches", "Matches"],
    ["table", "Standings"],
    ["bracket", "Knockout"],
    ["scorers", "Top Scorers"],
    ["teams", "Teams"],
    ["players", "Players"],
  ];
  const adminTabs = [
    ["teams", "Teams"],
    ["players", "Players"],
    ["fixtures", "Fixtures"],
    ["matches", "Matches"],
    ["settings", "Settings"],
    ["access", "Manage Access"],
  ];
  const tabIcons = {
    dashboard: "⌂",
    schedule: "▦",
    matches: "⚽",
    table: "▤",
    bracket: "🏆",
    scorers: "🎯",
    teams: "♟",
    players: "👟",
    fixtures: "▦",
    settings: "⚙",
    access: "🔐",
  };

  let app, auth, db;
  let currentUser = null;
  let isOwner = false;
  let scorekeeperGrant = null;
  let scorekeeperRecords = [];
  let authorizationUnsubscribe = null;
  let authorizationExpiryTimer = null;
  let authorizationContext = null;
  let teamPlayerCountsInitializingId = null;
  let activeTournamentId = new URLSearchParams(location.search).get("tournament");
  let listenedTournamentId = null;
  let activeTournament = null;
  let teams = [];
  let players = [];
  let playersLoaded = false;
  let matches = [];
  let publicTab = "dashboard";
  let adminTab = "teams";
  const publicUnsubscribes = [];

  function isConfigured() {
    const config = window.FIREBASE_CONFIG;
    return Boolean(config) &&
      ["apiKey", "authDomain", "projectId", "messagingSenderId", "appId"].every(key =>
        typeof config[key] === "string" &&
        config[key].trim() !== "" &&
        !config[key].trim().startsWith("YOUR_")
      );
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = value == null ? "" : String(value);
    return element.innerHTML;
  }

  function slugify(value) {
    return value.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "tournament";
  }

  function createTabs(container, tabs, selected, onSelect) {
    container.innerHTML = tabs.map(([id, label]) =>
      `<button class="tab ${id === selected ? "active" : ""}" type="button" data-tab="${id}"
        aria-current="${id === selected ? "page" : "false"}">
        <span class="tab-icon" aria-hidden="true">${tabIcons[id] || ""}</span>
        <span>${escapeHtml(label)}</span>
      </button>`
    ).join("");
    container.querySelectorAll("[data-tab]").forEach(button => {
      button.addEventListener("click", () => onSelect(button.dataset.tab));
    });
  }

  function teamName(teamId) {
    return teams.find(team => team.id === teamId)?.name || "TBD";
  }

  function playerName(playerId) {
    return players.find(player => player.id === playerId)?.name || "Unknown player";
  }

  function matchesSorted() {
    return [...matches].sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
  }

  function initializePublic() {
    if (!isConfigured()) {
      setupNotice.classList.remove("hidden");
      setupNotice.textContent = "Firebase is not configured yet. Add the web configuration to firebase-config.js.";
      publicView.classList.add("hidden");
      adminView.classList.add("hidden");
      modeButton.classList.add("hidden");
      return;
    }

    if (typeof firebase === "undefined") {
      showSetupError(new Error("Firebase SDK failed to load. Check the network connection and Firebase script URLs."));
      publicView.classList.add("hidden");
      adminView.classList.add("hidden");
      modeButton.classList.add("hidden");
      return;
    }

    try {
      app = firebase.initializeApp(window.FIREBASE_CONFIG);
      auth = firebase.auth(app);
      db = firebase.firestore(app);
    } catch (error) {
      showSetupError(error);
      publicView.classList.add("hidden");
      adminView.classList.add("hidden");
      modeButton.classList.add("hidden");
      return;
    }
    setupNotice.classList.add("hidden");

    db.collection("tournaments").orderBy("name").onSnapshot(snapshot => {
      const tournaments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (!tournaments.length) {
        renderTournamentSelector(tournaments);
        listenToTournament(null);
        return;
      }

      if (!activeTournamentId || !tournaments.some(item => item.id === activeTournamentId)) {
        activeTournamentId = tournaments[0].id;
      }
      renderTournamentSelector(tournaments);
      listenToTournament(activeTournamentId);
    }, error => showSetupError(error));

    auth.onAuthStateChanged(user => {
      currentUser = user;
      document.getElementById("authPanel").classList.toggle("hidden", Boolean(user));
      document.getElementById("adminPanel").classList.toggle("hidden", !user);
      updateAuthorization();
    });
  }

  function showSetupError(error) {
    setupNotice.classList.remove("hidden");
    if (error?.code === "permission-denied") {
      setupNotice.textContent = "Firestore denied a public read. Confirm this is the correct Firebase project and publish the app's firestore.rules to the (default) database.";
      return;
    }
    setupNotice.textContent = `Firebase error: ${error?.message || error}`;
  }

  function renderTournamentSelector(tournaments) {
    const select = document.getElementById("tournamentSelect");
    select.innerHTML = tournaments.map(item =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
    ).join("");
    select.value = activeTournamentId;
  }

  function listenToTournament(id) {
    if (listenedTournamentId === id && activeTournamentId === (id || null)) return;
    publicUnsubscribes.forEach(unsubscribe => unsubscribe());
    publicUnsubscribes.length = 0;
    listenedTournamentId = id;
    activeTournamentId = id || null;
    activeTournament = null;
    teams = [];
    players = [];
    playersLoaded = false;
    matches = [];
    document.getElementById("tournamentTitle").textContent = "Tournament";

    if (!id) {
      updateAuthorization();
      renderPublic();
      return;
    }

    updateAuthorization();

    publicUnsubscribes.push(db.collection("tournaments").doc(id).onSnapshot(snapshot => {
      activeTournament = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
      document.getElementById("tournamentTitle").textContent = activeTournament?.name || "Tournament";
      updateAuthorization();
      ensureTeamPlayerCounts();
      renderPublic();
    }, error => showSetupError(error)));

    publicUnsubscribes.push(db.collection("tournaments").doc(id).collection("teams").orderBy("name").onSnapshot(snapshot => {
      teams = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderPublic();
      if (document.getElementById("adminView").offsetParent !== null) renderAdmin();
    }, error => showSetupError(error)));

    publicUnsubscribes.push(db.collection("tournaments").doc(id).collection("players").orderBy("name")
      .onSnapshot({ includeMetadataChanges: true }, snapshot => {
        players = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        playersLoaded = !snapshot.metadata.fromCache;
        ensureTeamPlayerCounts();
        renderPublic();
        if (document.getElementById("adminView").offsetParent !== null) renderAdmin();
      }, error => showSetupError(error)));

    publicUnsubscribes.push(db.collection("tournaments").doc(id).collection("matches").onSnapshot(snapshot => {
      matches = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderPublic();
      if (document.getElementById("adminView").offsetParent !== null) renderAdmin();
    }, error => showSetupError(error)));
  }

  function hasScorekeeperAccess() {
    if (!scorekeeperGrant) return false;
    const startsAt = scorekeeperGrant.startsAt?.toDate?.().getTime();
    const expiresAt = scorekeeperGrant.expiresAt?.toDate?.().getTime();
    const now = Date.now();
    return Number.isFinite(startsAt) && Number.isFinite(expiresAt) &&
      startsAt <= now && expiresAt > now;
  }

  function canManageMatch(match) {
    return isOwner || (hasScorekeeperAccess() &&
      (!scorekeeperGrant.matchId || scorekeeperGrant.matchId === match.id));
  }

  function updateAuthorization() {
    isOwner = Boolean(currentUser && activeTournament?.ownerUid === currentUser.uid);
    const verificationPanel = document.getElementById("emailVerificationPanel");
    verificationPanel.classList.toggle(
      "hidden",
      !currentUser || currentUser.emailVerified || isOwner
    );
    const nextContext = currentUser && activeTournamentId
      ? `${activeTournamentId}:${currentUser.uid}:${isOwner ? "owner" : "user"}`
      : null;

    if (nextContext !== authorizationContext) {
      if (authorizationUnsubscribe) authorizationUnsubscribe();
      if (authorizationExpiryTimer) clearTimeout(authorizationExpiryTimer);
      authorizationUnsubscribe = null;
      authorizationExpiryTimer = null;
      authorizationContext = nextContext;
      scorekeeperGrant = null;
      scorekeeperRecords = [];

      if (currentUser && activeTournamentId && isOwner) {
        authorizationUnsubscribe = tournamentRef().collection("scorekeepers").onSnapshot(snapshot => {
          scorekeeperRecords = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderAdmin();
        }, error => showAdminMessage(`Unable to load access records: ${error.message}`));
      } else if (currentUser && activeTournamentId && currentUser.email) {
        const emailId = currentUser.email.trim();
        authorizationUnsubscribe = tournamentRef().collection("scorekeepers").doc(emailId).onSnapshot(snapshot => {
          scorekeeperGrant = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
          scheduleAuthorizationRefresh();
          renderAdmin();
        }, error => {
          scorekeeperGrant = null;
          showAdminMessage(`Unable to verify Scorekeeper access: ${error.message}`);
          renderAdmin();
        });
      }
      scheduleAuthorizationRefresh();
    }
    renderAdmin();
  }

  function hasTeamPlayerCounts(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function getTournamentPlayerLimit(tournament = activeTournament) {
    if (!tournament) return null;
    if (Object.prototype.hasOwnProperty.call(tournament, "maxPlayersPerTeam")) {
      return Number.isSafeInteger(tournament.maxPlayersPerTeam) &&
        tournament.maxPlayersPerTeam >= 0
        ? tournament.maxPlayersPerTeam
        : null;
    }
    return Number.isSafeInteger(tournament.maxPlayers) && tournament.maxPlayers >= 0
      ? tournament.maxPlayers
      : null;
  }

  function buildTeamPlayerCounts(playerList = players, teamList = teams) {
    const counts = {};
    teamList.forEach(team => { counts[team.id] = 0; });
    playerList.forEach(player => {
      if (player.teamId) counts[player.teamId] = (counts[player.teamId] || 0) + 1;
    });
    return counts;
  }

  async function ensureTeamPlayerCounts() {
    const countsExist = hasTeamPlayerCounts(activeTournament?.teamPlayerCounts);
    const limitExists = Object.prototype.hasOwnProperty.call(
      activeTournament || {},
      "maxPlayersPerTeam"
    );
    if (!isOwner || !activeTournament ||
        (!countsExist && !playersLoaded) ||
        (countsExist && limitExists) ||
        teamPlayerCountsInitializingId === activeTournamentId) return;

    const tournamentId = activeTournamentId;
    const tournament = tournamentRef();
    const initialCounts = countsExist ? null : buildTeamPlayerCounts();
    teamPlayerCountsInitializingId = tournamentId;
    try {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(tournament);
        if (!snapshot.exists) throw new Error("The tournament no longer exists.");
        const data = snapshot.data();
        const updates = {};
        if (!hasTeamPlayerCounts(data.teamPlayerCounts)) {
          updates.teamPlayerCounts = initialCounts;
        }
        if (!Object.prototype.hasOwnProperty.call(data, "maxPlayersPerTeam")) {
          updates.maxPlayersPerTeam = Number.isSafeInteger(data.maxPlayers) && data.maxPlayers >= 0
            ? data.maxPlayers
            : null;
        }
        if (Object.keys(updates).length) transaction.update(tournament, updates);
      });
    } catch (error) {
      showAdminMessage(`Unable to initialize per-team player counts: ${error.message}`);
    } finally {
      if (teamPlayerCountsInitializingId === tournamentId) teamPlayerCountsInitializingId = null;
    }
  }

  function scheduleAuthorizationRefresh() {
    if (authorizationExpiryTimer) clearTimeout(authorizationExpiryTimer);
    authorizationExpiryTimer = null;
    if (!scorekeeperGrant) return;
    const now = Date.now();
    const boundaries = [
      scorekeeperGrant.startsAt?.toDate?.().getTime(),
      scorekeeperGrant.expiresAt?.toDate?.().getTime(),
    ].filter(time => Number.isFinite(time) && time > now);
    if (boundaries.length) {
      const delay = Math.min(boundaries[0], ...boundaries) - now + 50;
      authorizationExpiryTimer = setTimeout(() => {
        scheduleAuthorizationRefresh();
        renderAdmin();
      }, Math.min(delay, 2147483647));
    }
  }

  function showAdminMessage(message) {
    const status = document.getElementById("adminMessage");
    if (!status) return;
    status.textContent = message;
    status.dataset.type = /failed|unable|denied|invalid|limit|inconsistent|required|cannot|offline|no longer/i.test(message)
      ? "error"
      : "success";
  }

  function calculateStandings() {
    const standings = teams.map(team => ({
      teamId: team.id,
      name: team.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      for: 0,
      against: 0,
      difference: 0,
      points: 0,
    }));
    const byId = new Map(standings.map(row => [row.teamId, row]));

    matches.filter(match => match.stage === "League").forEach(match => {
      if (match.status !== "finished") return;
      const home = byId.get(match.teamAId);
      const away = byId.get(match.teamBId);
      if (!home || !away) return;
      home.played++;
      away.played++;
      home.for += match.teamAScore || 0;
      home.against += match.teamBScore || 0;
      away.for += match.teamBScore || 0;
      away.against += match.teamAScore || 0;
      if (match.teamAScore > match.teamBScore) {
        home.won++;
        away.lost++;
        home.points += 3;
      } else if (match.teamAScore < match.teamBScore) {
        away.won++;
        home.lost++;
        away.points += 3;
      } else {
        home.drawn++;
        away.drawn++;
        home.points++;
        away.points++;
      }
    });

    standings.forEach(row => { row.difference = row.for - row.against; });
    return standings.sort((a, b) =>
      b.points - a.points ||
      b.difference - a.difference ||
      b.for - a.for ||
      a.name.localeCompare(b.name)
    );
  }

  function calculateTopScorers() {
    const totals = new Map();
    matches.forEach(match => (match.goals || []).forEach(goal => {
      const key = goal.playerId || `${goal.teamId}-${goal.playerName}`;
      totals.set(key, {
        name: goal.playerName || playerName(goal.playerId),
        teamId: goal.teamId,
        goals: (totals.get(key)?.goals || 0) + 1,
      });
    }));
    return [...totals.values()].sort((a, b) =>
      b.goals - a.goals || a.name.localeCompare(b.name)
    );
  }

  function renderDashboard() {
    const sortedMatches = matchesSorted();
    const liveMatches = sortedMatches.filter(match => match.status === "live");
    const upcomingMatches = sortedMatches.filter(match => match.status === "scheduled").slice(0, 3);
    const recentMatches = sortedMatches
      .filter(match => match.status === "finished")
      .reverse()
      .slice(0, 3);
    const standings = calculateStandings();
    const scorers = calculateTopScorers();
    const goalCount = matches.reduce((total, match) => total + (match.goals || []).length, 0);
    const currentStage = liveMatches.length
      ? "Live action"
      : matches.some(match => match.stage === "Knockout")
        ? "Knockout stage"
        : matches.some(match => match.stage === "League")
          ? "League stage"
          : "Tournament setup";
    const qualificationCount = matches.some(match => match.round === "Quarter-finals") ? 8 : 0;

    return `
      <section class="dashboard-hero">
        <div class="dashboard-hero-copy">
          <p class="eyebrow">TOURNAMENT CENTER</p>
          <h2>${escapeHtml(activeTournament?.name || "Your tournament")}</h2>
          <p>Every fixture, result, and goal — all in one place.</p>
        </div>
        <div class="stage-pill"><span class="stage-pulse"></span>${escapeHtml(currentStage)}</div>
      </section>
      <section class="stats-grid" aria-label="Tournament statistics">
        <article class="stat-card"><span class="stat-icon">♟</span><span class="stat-label">Teams</span><strong>${teams.length}</strong></article>
        <article class="stat-card"><span class="stat-icon">👟</span><span class="stat-label">Players</span><strong>${players.length}</strong></article>
        <article class="stat-card"><span class="stat-icon">⚽</span><span class="stat-label">Matches played</span><strong>${matches.filter(match => match.status === "finished").length}</strong></article>
        <article class="stat-card"><span class="stat-icon">✦</span><span class="stat-label">Goals scored</span><strong>${goalCount}</strong></article>
      </section>
      ${liveMatches.length ? `
        <section class="dashboard-section">
          <div class="section-heading"><div><p class="eyebrow">HAPPENING NOW</p><h2>Live matches</h2></div></div>
          ${renderMatchGrid(liveMatches, false)}
        </section>` : ""}
      <section class="dashboard-section">
        <div class="section-heading">
          <div><p class="eyebrow">UP NEXT</p><h2>Upcoming fixtures</h2></div>
          <button type="button" class="text-button" data-open-tab="schedule">All fixtures <span aria-hidden="true">→</span></button>
        </div>
        ${renderMatchGrid(upcomingMatches, false)}
      </section>
      <div class="dashboard-columns">
        <section class="card dashboard-section">
          <div class="section-heading">
            <div><p class="eyebrow">THE TABLE</p><h2>League standings</h2></div>
            <button type="button" class="text-button" data-open-tab="table">Full table <span aria-hidden="true">→</span></button>
          </div>
          ${tableHtml(
            ["Pos", "Team", "P", "GD", "Pts"],
            standings.slice(0, 5).map((row, index) => [
              index + 1, escapeHtml(row.name), row.played, row.difference, row.points
            ]),
            (_, index) => index < 3 ? "standings-podium" : index < qualificationCount ? "standings-qualified" : ""
          )}
        </section>
        <section class="card dashboard-section">
          <div class="section-heading">
            <div><p class="eyebrow">GOLDEN BOOT RACE</p><h2>Top scorers</h2></div>
            <button type="button" class="text-button" data-open-tab="scorers">Leaderboard <span aria-hidden="true">→</span></button>
          </div>
          ${tableHtml(
            ["Rank", "Player", "Goals"],
            scorers.slice(0, 5).map((row, index) => [
              index + 1, escapeHtml(row.name), row.goals
            ]),
            (_, index) => index < 3 ? `scorer-rank-${index + 1}` : ""
          )}
        </section>
      </div>
      <section class="dashboard-section">
        <div class="section-heading"><div><p class="eyebrow">FINAL WHISTLE</p><h2>Recent results</h2></div></div>
        ${renderMatchGrid(recentMatches, false)}
      </section>`;
  }

  function renderPublic() {
    createTabs(document.getElementById("publicTabs"), publicTabs, publicTab, tab => {
      publicTab = tab;
      renderPublic();
    });
    const content = document.getElementById("publicContent");
    if (!activeTournament) {
      content.innerHTML = `<div class="card"><h2>No tournaments</h2><p class="muted">An administrator needs to create and publish a tournament.</p></div>`;
      return;
    }

    if (publicTab === "dashboard") {
      content.innerHTML = renderDashboard();
    }

    if (publicTab === "teams") {
      const maxPlayersPerTeam = getTournamentPlayerLimit();
      content.innerHTML = `
        <div class="page-heading"><div><p class="eyebrow">SQUADS</p><h2>Teams</h2></div>
          <span class="subtle-count">${teams.length} teams</span>
        </div>
        ${teams.length ? `<div class="grid team-directory">${teams.map(team => {
          const count = players.filter(player => player.teamId === team.id).length;
          const initials = team.name.split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase();
          return `<article class="card team-directory-card">
            <div class="team-identity"><span class="team-crest">${escapeHtml(initials || "FC")}</span>
              <div><p class="eyebrow">CLUB</p><h3>${escapeHtml(team.name)}</h3></div>
            </div>
            <div class="team-capacity-public">
              <span>${count} ${count === 1 ? "player" : "players"}</span>
              ${maxPlayersPerTeam === null ? `<span class="muted">No roster limit</span>` : `
                <span class="muted">${count} / ${maxPlayersPerTeam}</span>
                ${maxPlayersPerTeam > 0 ? `<progress max="${maxPlayersPerTeam}" value="${Math.min(count, maxPlayersPerTeam)}" aria-label="${escapeHtml(team.name)} roster capacity"></progress>` : ""}
              `}
            </div>
            <div class="team-player-list">${players.filter(player => player.teamId === team.id).map(player =>
              `<span class="player-chip">${escapeHtml(player.name)}</span>`
            ).join("") || `<span class="muted">Roster not announced yet</span>`}</div>
          </article>`;
        }).join("")}</div>` : `<div class="empty-state card"><span class="empty-icon">♟</span><h3>No teams yet</h3><p>Team lineups will appear here once they are added.</p></div>`}`;
    }

    if (publicTab === "players") {
      content.innerHTML = `<div class="card"><h2>Players</h2>${tableHtml(
        ["Player", "Team"],
        players.map(player => [escapeHtml(player.name), escapeHtml(teamName(player.teamId))])
      )}</div>`;
    }

    if (publicTab === "schedule") {
      const scheduled = matchesSorted().filter(match => match.status !== "finished");
      content.innerHTML = `<div class="page-heading"><div><p class="eyebrow">FIXTURES</p><h2>Match schedule</h2></div></div>${renderMatchGrid(scheduled, false)}`;
    }

    if (publicTab === "matches") {
      const visible = matchesSorted().filter(match => ["live", "finished"].includes(match.status));
      content.innerHTML = `<div class="page-heading"><div><p class="eyebrow">SCORE CENTER</p><h2>Matches</h2></div></div>${renderMatchGrid(visible, false)}`;
    }

    if (publicTab === "table") {
      const standings = calculateStandings();
      const qualificationCount = matches.some(match => match.round === "Quarter-finals") ? 8 : 0;
      content.innerHTML = `<div class="card standings-card">
        <div class="page-heading"><div><p class="eyebrow">LEAGUE</p><h2>Standings</h2></div>
          ${qualificationCount ? `<span class="qualification-key"><i></i> Knockout places</span>` : ""}
        </div>${tableHtml(
        ["Position", "Team", "Played", "Won", "Draw", "Lost", "Goals for", "Goals against", "Goal difference", "Points"],
        standings.map((row, index) => [
          index + 1, escapeHtml(row.name), row.played, row.won, row.drawn, row.lost,
          row.for, row.against, row.difference, row.points
        ]),
        (_, index) => index < 3 ? "standings-podium" : index < qualificationCount ? "standings-qualified" : ""
      )}</div>`;
    }

    if (publicTab === "scorers") {
      const scorers = calculateTopScorers();
      content.innerHTML = `<div class="card scorer-card">
        <div class="page-heading"><div><p class="eyebrow">GOLDEN BOOT</p><h2>Top scorers</h2></div>
          <span class="subtle-count">${scorers.length} players on the board</span>
        </div>${tableHtml(
        ["Rank", "Player", "Team", "Goals"],
        scorers.map((row, index) => [
          index + 1, escapeHtml(row.name), escapeHtml(teamName(row.teamId)), row.goals
        ]),
        (_, index) => index < 3 ? `scorer-rank-${index + 1}` : ""
      )}</div>`;
    }

    if (publicTab === "bracket") {
      const rounds = ["Quarter-finals", "Semi-finals", "Final"];
      const final = matches.find(match => match.round === "Final" && match.status === "finished");
      const championId = final && final.teamAScore !== final.teamBScore
        ? final.teamAScore > final.teamBScore ? final.teamAId : final.teamBId
        : null;
      content.innerHTML = `<div class="page-heading"><div><p class="eyebrow">THE ROAD TO THE FINAL</p><h2>Knockout stage</h2></div></div>
        ${championId ? `<div class="champion-banner"><span class="trophy-icon">🏆</span><div><p class="eyebrow">TOURNAMENT CHAMPION</p><h2>${escapeHtml(teamName(championId))}</h2></div><span class="champion-flair">CHAMPIONS</span></div>` : ""}
        <div class="bracket">${rounds.map(round =>
        `<section class="bracket-round card"><h3>${round}</h3>${renderMatchGrid(
          matchesSorted().filter(match => match.round === round),
          false
        )}</section>`
      ).join("")}</div>`;
    }

    content.querySelectorAll("[data-open-tab]").forEach(button => {
      button.addEventListener("click", () => {
        publicTab = button.dataset.openTab;
        renderPublic();
      });
    });
  }

  function tableHtml(headers, rows, rowClass = null) {
    if (!rows.length) return `<p class="muted">No entries yet.</p>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map(header =>
      `<th>${escapeHtml(header)}</th>`
    ).join("")}</tr></thead><tbody>${rows.map((row, index) => {
      const className = rowClass ? rowClass(row, index) : "";
      return `<tr${className ? ` class="${escapeHtml(className)}"` : ""}>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function renderMatchGrid(matchList, admin) {
    if (!matchList.length) return `<p class="muted">No matches yet.</p>`;
    return `<div class="grid match-grid">${matchList.map(match => {
      const goals = match.goals || [];
      const status = match.status || "scheduled";
      const statusLabel = status === "live" ? "LIVE" : status === "finished" ? "FULL TIME" : "UPCOMING";
      const manageThisMatch = admin && canManageMatch(match);
      const correctFinished = status !== "finished" || isOwner || scorekeeperGrant?.allowCompletedMatches === true;
      const isFinished = status === "finished";
      const winnerId = isFinished && match.teamAScore !== match.teamBScore
        ? match.teamAScore > match.teamBScore ? match.teamAId : match.teamBId
        : null;
      const teamMark = id => teamName(id).split(/\s+/).slice(0, 2)
        .map(part => part[0] || "").join("").toUpperCase();
      const goalHtml = goals.length ? `<div class="goal-list">
        <p class="goal-list-heading">GOAL SCORERS</p>${goals.map(goal =>
        `<div class="goal-item">
          <span class="goal-scorer"><span class="goal-ball" aria-hidden="true">⚽</span>${escapeHtml(goal.playerName || playerName(goal.playerId))}</span>${
          manageThisMatch && correctFinished ? `
            <select class="edit-goal-team" data-match="${escapeHtml(match.id)}" data-goal="${escapeHtml(goal.id)}" aria-label="Goal team">
              ${[match.teamAId, match.teamBId].filter(Boolean).map(id =>
                `<option value="${escapeHtml(id)}" ${id === goal.teamId ? "selected" : ""}>${escapeHtml(teamName(id))}</option>`
              ).join("")}
            </select>
            <select class="edit-goal-player" data-match="${escapeHtml(match.id)}" data-goal="${escapeHtml(goal.id)}" aria-label="Goal scorer">
              ${players.filter(player => player.teamId === goal.teamId).map(player =>
                `<option value="${escapeHtml(player.id)}" ${player.id === goal.playerId ? "selected" : ""}>${escapeHtml(player.name)}</option>`
              ).join("")}
            </select>
            <button type="button" class="secondary-button save-goal" data-match="${escapeHtml(match.id)}" data-goal="${escapeHtml(goal.id)}">Save</button>
            <button type="button" class="danger-button remove-goal" data-match="${escapeHtml(match.id)}" data-goal="${escapeHtml(goal.id)}">Remove</button>
          ` : ""
        }</div>`
      ).join("")}</div>` : "";
      const canAddGoal = manageThisMatch && correctFinished && ["live", "finished"].includes(status);
      const actions = manageThisMatch ? `
        <div class="match-admin-controls">
          ${status === "scheduled" ? `<button class="match-control-primary" type="button" data-action="start" data-match="${escapeHtml(match.id)}">Start match</button>` : ""}
          ${canAddGoal ? `
            <div class="goal-entry">
              <label>Scoring team
                <select class="goal-team" data-match="${escapeHtml(match.id)}" aria-label="Scoring team">
                  ${[match.teamAId, match.teamBId].filter(Boolean).map(id =>
                    `<option value="${escapeHtml(id)}">${escapeHtml(teamName(id))}</option>`
                  ).join("")}
                </select>
              </label>
              <label>Goal scorer
                <select class="goal-player" data-match="${escapeHtml(match.id)}" aria-label="Goal scorer">
                  ${getPlayersForMatch(match, match.teamAId).map(player =>
                    `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`
                  ).join("")}
                </select>
              </label>
              <button class="goal-add-button" type="button" data-action="goal" data-match="${escapeHtml(match.id)}">⚽ Add goal</button>
            </div>
          ` : ""}
          ${status === "live" ? `<button class="match-control-primary" type="button" data-action="finish" data-match="${escapeHtml(match.id)}">Finish match</button>` : ""}
          ${isFinished && correctFinished ? `<button class="secondary-button" type="button" data-action="reopen" data-match="${escapeHtml(match.id)}">Reopen match</button>` : ""}
        </div>` : "";
      return `<article class="match-card ${escapeHtml(status)}">
        <header class="match-card-header">
          <span class="stage-pill">${escapeHtml(match.round || match.stage || "Match")}</span>
          <span class="status-badge status-${escapeHtml(status)}">${status === "live" ? `<i></i>` : ""}${statusLabel}</span>
        </header>
        <div class="match-scoreboard">
          <div class="match-side ${winnerId === match.teamAId ? "match-winner" : ""}">
            <span class="team-crest">${escapeHtml(teamMark(match.teamAId) || "FC")}</span>
            <strong>${escapeHtml(teamName(match.teamAId))}</strong>
            ${winnerId === match.teamAId ? `<span class="winner-tag">WINNER</span>` : ""}
          </div>
          <div class="score-block">
            <strong class="scoreline">${match.teamAScore || 0}<span>:</span>${match.teamBScore || 0}</strong>
            <small>${isFinished ? "FINAL SCORE" : status === "live" ? "CURRENT SCORE" : "VS"}</small>
          </div>
          <div class="match-side ${winnerId === match.teamBId ? "match-winner" : ""}">
            <span class="team-crest">${escapeHtml(teamMark(match.teamBId) || "FC")}</span>
            <strong>${escapeHtml(teamName(match.teamBId))}</strong>
            ${winnerId === match.teamBId ? `<span class="winner-tag">WINNER</span>` : ""}
          </div>
        </div>
        ${goalHtml}${actions}
      </article>`;
    }).join("")}</div>`;
  }

  function getPlayersForMatch(match, teamId) {
    return players.filter(player => player.teamId === teamId);
  }

  function renderAdmin() {
    const content = document.getElementById("adminContent");
    const tabsElement = document.getElementById("adminTabs");
    const teamPlayerCounts = activeTournament?.teamPlayerCounts;
    const teamPlayerCountsReady = hasTeamPlayerCounts(teamPlayerCounts);
    const maxPlayersPerTeam = getTournamentPlayerLimit();
    const getPlayerCount = teamId => teamPlayerCountsReady &&
      Number.isInteger(teamPlayerCounts[teamId])
      ? teamPlayerCounts[teamId]
      : players.filter(player => player.teamId === teamId).length;
    document.getElementById("newTournamentButton").classList.toggle(
      "hidden",
      Boolean(activeTournament && !isOwner)
    );
    const availableTabs = isOwner
      ? adminTabs
      : hasScorekeeperAccess()
        ? [["matches", "Matches"]]
        : [];
    if (!activeTournamentId) {
      tabsElement.innerHTML = "";
      content.innerHTML = "";
      return;
    }
    if (!isOwner && !hasScorekeeperAccess()) {
      tabsElement.innerHTML = "";
      content.innerHTML = `<div class="card"><h2>Access required</h2><p class="muted">You are signed in, but this account does not have active Owner or Scorekeeper access for this tournament.</p></div>`;
      return;
    }
    if (!availableTabs.some(([id]) => id === adminTab)) adminTab = isOwner ? "teams" : "matches";
    createTabs(tabsElement, availableTabs, adminTab, tab => {
      adminTab = tab;
      renderAdmin();
    });

    if (adminTab === "teams") {
      content.innerHTML = `
        <div class="card">
          <h2>Add team</h2>
          <form id="teamForm" class="inline-form">
            <input id="teamName" placeholder="Team name" required />
            <button type="submit">Add team</button>
          </form>
        </div>
        <div class="card"><h2>Teams</h2>${teams.length ? tableHtml(
          ["Name", "Players", "Actions"],
          teams.map(team => [
            `<input class="edit-team-name" data-team="${team.id}" value="${escapeHtml(team.name)}" />`,
            `${getPlayerCount(team.id)}${maxPlayersPerTeam === null ? "" : ` / ${maxPlayersPerTeam}`}`,
            `<button type="button" data-team-action="save" data-team="${team.id}">Save</button>
             <button type="button" class="danger-button" data-team-action="delete" data-team="${team.id}">Delete</button>`
          ])
        ) : `<p class="muted">No teams yet.</p>`}</div>`;
      bindTeamAdmin(content);
    }

    if (adminTab === "players") {
      const displayedCounts = {};
      teams.forEach(team => { displayedCounts[team.id] = getPlayerCount(team.id); });
      content.innerHTML = `
        <h2>Add players by team</h2>
        <div class="grid team-player-grid">${teams.length ? teams.map(team => {
          const count = getPlayerCount(team.id);
          const full = maxPlayersPerTeam !== null && count >= maxPlayersPerTeam;
          return `
            <section class="card team-player-card">
              <h3>${escapeHtml(team.name)}</h3>
              <p class="team-capacity muted">${count}${
                maxPlayersPerTeam === null ? " players · no limit" : ` of ${maxPlayersPerTeam} players`
              }${full ? " · Team is full" : ""}</p>
              ${maxPlayersPerTeam > 0 ? `<progress class="team-capacity-progress"
                aria-label="${escapeHtml(team.name)} player capacity"
                max="${maxPlayersPerTeam}" value="${Math.min(count, maxPlayersPerTeam)}"></progress>` : ""}
              <form class="team-player-form inline-form" data-team="${escapeHtml(team.id)}">
                <input class="new-player-name" placeholder="Player name"
                  aria-label="Player name for ${escapeHtml(team.name)}" required />
                <button type="submit" ${!teamPlayerCountsReady || full ? "disabled" : ""}>Add player</button>
              </form>
              ${!teamPlayerCountsReady ? `<p class="muted">Preparing team roster counts...</p>` : ""}
            </section>`;
        }).join("") : `<div class="card"><p class="muted">Add a team first to start registering players.</p></div>`}</div>
        <div class="card"><h2>Player roster</h2>${players.length ? tableHtml(
          ["Name", "Team", "Actions"],
          players.map(player => [
            `<input class="edit-player-name" data-player="${player.id}" value="${escapeHtml(player.name)}" />`,
            `<select class="edit-player-team" data-player="${player.id}">
              ${teams.map(team => `<option value="${team.id}" ${team.id === player.teamId ? "selected" : ""}>${escapeHtml(team.name)}</option>`).join("")}
            </select>`,
            `<button type="button" data-player-action="save" data-player="${player.id}">Save</button>
             <button type="button" class="danger-button" data-player-action="delete" data-player="${player.id}">Delete</button>`
          ])
        ) : `<p class="muted">No players yet.</p>`}</div>`;
      bindPlayerAdmin(content, teamPlayerCountsReady, displayedCounts, maxPlayersPerTeam);
    }

    if (adminTab === "fixtures") {
      content.innerHTML = `
        <div class="grid">
          <div class="card">
            <h2>League fixtures</h2>
            <p class="muted">Generates a round-robin schedule for every team.</p>
            <button id="generateLeague" type="button" ${teams.length >= 2 ? "" : "disabled"}>Generate League Fixtures</button>
          </div>
          <div class="card">
            <h2>Knockout bracket</h2>
            <p class="muted">Uses the current league standings to seed a bracket.</p>
            <button id="generateQuarter" type="button" ${calculateStandings().length >= 8 ? "" : "disabled"}>Generate Quarter-finals</button>
          </div>
        </div>`;
      document.getElementById("generateLeague").addEventListener("click", () =>
        runAdminAction(generateLeagueFixtures)
      );
      document.getElementById("generateQuarter").addEventListener("click", () =>
        runAdminAction(generateQuarterFinals)
      );
    }

    if (adminTab === "matches") {
      const visibleMatches = isOwner
        ? matchesSorted()
        : matchesSorted().filter(match => canManageMatch(match));
      content.innerHTML = `<h2>Matches</h2>${renderMatchGrid(visibleMatches, true)}`;
      bindMatchAdmin(content);
    }

    if (adminTab === "settings") {
      content.innerHTML = `
        <div class="card">
          <h2>Tournament settings</h2>
          <form id="settingsForm" class="settings-form">
            <label>Tournament name
              <input id="settingsName" value="${escapeHtml(activeTournament?.name || "")}" required />
            </label>
            <label>Maximum players per team
              <input id="maxPlayersPerTeam" type="number" min="0" step="1"
                value="${maxPlayersPerTeam === null ? "" : maxPlayersPerTeam}" placeholder="Unlimited" />
            </label>
            <p class="muted">The same limit applies to every team. Leave blank for no cap. Existing rosters stay intact; a team over the limit cannot add players until it is under the cap.</p>
            <button type="submit">Save settings</button>
          </form>
        </div>
        <div class="card">
          <h2>Reset tournament</h2>
          <p class="muted">This deletes all teams, players and matches.</p>
          <button id="resetTournament" class="danger-button" type="button">Reset Tournament</button>
        </div>`;
      document.getElementById("settingsForm").addEventListener("submit", event =>
        runAdminAction(() => saveTournamentName(event), "Tournament settings saved.")
      );
      document.getElementById("resetTournament").addEventListener("click", () =>
        runAdminAction(resetTournament)
      );
    }

    if (adminTab === "access" && isOwner) {
      renderAccessManagement(content);
    }
  }

  function localDateTimeValue(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function formatGrantTime(timestamp) {
    const date = timestamp?.toDate?.();
    return date ? date.toLocaleString() : "—";
  }

  function renderAccessManagement(content) {
    const defaultStart = new Date();
    const defaultExpiry = new Date(defaultStart.getTime() + 4 * 60 * 60 * 1000);
    content.innerHTML = `
      <div class="card">
        <h2>Temporary Scorekeepers</h2>
        <form id="scorekeeperForm" class="access-form">
          <label>Name <input id="scorekeeperName" required maxlength="100" /></label>
          <label>Email <input id="scorekeeperEmail" type="email" required /></label>
          <label>Access starts <input id="scorekeeperStarts" type="datetime-local" value="${localDateTimeValue(defaultStart)}" required /></label>
          <label>Access expires <input id="scorekeeperExpires" type="datetime-local" value="${localDateTimeValue(defaultExpiry)}" required /></label>
          <label>Match
            <select id="scorekeeperMatch">
              <option value="">All matches</option>
              ${matchesSorted().map(match =>
                `<option value="${escapeHtml(match.id)}">${escapeHtml(teamName(match.teamAId))} vs ${escapeHtml(teamName(match.teamBId))} (${escapeHtml(match.round || match.stage || "Match")})</option>`
              ).join("")}
            </select>
          </label>
          <label class="checkbox-label"><input id="scorekeeperCompleted" type="checkbox" /> Allow corrections to completed matches</label>
          <button type="submit">+ Add Scorekeeper</button>
        </form>
        <p class="muted">Scorekeepers must sign in with this email. Access is checked against Firestore server time on every write.</p>
      </div>
      <div class="card">
        ${scorekeeperRecords.length ? tableHtml(
          ["Name/Email", "Access", "Starts", "Expires", "Action"],
          scorekeeperRecords.map(record => [
            `${escapeHtml(record.name || record.email)}<br><span class="muted">${escapeHtml(record.email)}</span>`,
            escapeHtml(record.matchId ? matchDescription(record.matchId) : "All Matches"),
            escapeHtml(formatGrantTime(record.startsAt)),
            escapeHtml(formatGrantTime(record.expiresAt)),
            `<button type="button" class="danger-button revoke-scorekeeper" data-email="${escapeHtml(record.email)}">Revoke Access</button>`
          ])
        ) : `<p class="muted">No temporary Scorekeepers have been added.</p>`}
      </div>`;

    content.querySelector("#scorekeeperForm").addEventListener("submit", saveScorekeeperGrant);
    content.querySelectorAll(".revoke-scorekeeper").forEach(button => {
      button.addEventListener("click", () => revokeScorekeeper(button.dataset.email));
    });
  }

  function matchDescription(matchId) {
    const match = matches.find(item => item.id === matchId);
    return match
      ? `${teamName(match.teamAId)} vs ${teamName(match.teamBId)}`
      : "Assigned match";
  }

  async function saveScorekeeperGrant(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = document.getElementById("scorekeeperEmail").value.trim();
    const startsAt = new Date(document.getElementById("scorekeeperStarts").value);
    const expiresAt = new Date(document.getElementById("scorekeeperExpires").value);
    if (!email || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= startsAt) {
      showAdminMessage("Choose a valid email and an expiry time later than the start time.");
      return;
    }

    try {
      await tournamentRef().collection("scorekeepers").doc(email).set({
        name: document.getElementById("scorekeeperName").value.trim(),
        email,
        startsAt: firebase.firestore.Timestamp.fromDate(startsAt),
        expiresAt: firebase.firestore.Timestamp.fromDate(expiresAt),
        matchId: document.getElementById("scorekeeperMatch").value || null,
        allowCompletedMatches: document.getElementById("scorekeeperCompleted").checked,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      form.reset();
      showAdminMessage(`Scorekeeper access saved for ${email}.`);
    } catch (error) {
      showAdminMessage(`Unable to save Scorekeeper access: ${error.message}`);
    }
  }

  async function revokeScorekeeper(email) {
    if (!confirm(`Revoke Scorekeeper access for ${email}?`)) return;
    try {
      await tournamentRef().collection("scorekeepers").doc(email).delete();
      showAdminMessage(`Access revoked for ${email}.`);
    } catch (error) {
      showAdminMessage(`Unable to revoke access: ${error.message}`);
    }
  }

  function tournamentRef() {
    return db.collection("tournaments").doc(activeTournamentId);
  }

  function bindTeamAdmin(content) {
    content.querySelector("#teamForm").addEventListener("submit", async event => {
      event.preventDefault();
      await runAdminAction(async () => {
        const name = document.getElementById("teamName").value.trim();
        if (!name) return;
        await tournamentRef().collection("teams").add({ name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        event.target.reset();
      });
    });
    content.querySelectorAll("[data-team-action]").forEach(button => {
      button.addEventListener("click", () => runAdminAction(async () => {
        const id = button.dataset.team;
        if (button.dataset.teamAction === "save") {
          const input = content.querySelector(`.edit-team-name[data-team="${id}"]`);
          const name = input.value.trim();
          if (!name) throw new Error("Team name cannot be empty.");
          await tournamentRef().collection("teams").doc(id).update({ name });
        } else if (confirm("Delete this team?")) {
          const tournament = tournamentRef();
          const team = tournament.collection("teams").doc(id);
          await db.runTransaction(async transaction => {
            const [tournamentSnapshot, teamSnapshot] = await Promise.all([
              transaction.get(tournament),
              transaction.get(team)
            ]);
            if (!tournamentSnapshot.exists) throw new Error("The tournament no longer exists.");
            if (!teamSnapshot.exists) return;
            const counts = tournamentSnapshot.data().teamPlayerCounts;
            if (!hasTeamPlayerCounts(counts)) {
              throw new Error("Team player counts are still initializing. Try again shortly.");
            }
            const count = counts[id] === undefined ? 0 : counts[id];
            if (!Number.isSafeInteger(count) || count < 0) {
              throw new Error("The team player count is inconsistent. Refresh and try again.");
            }
            if (count > 0) throw new Error("Move or delete this team's players before deleting the team.");
            const updatedCounts = { ...counts };
            delete updatedCounts[id];
            transaction.delete(team);
            transaction.update(tournament, { teamPlayerCounts: updatedCounts });
          });
        }
      }));
    });
  }

  function bindPlayerAdmin(content, countsReady, initialCounts, maxPlayersPerTeam) {
    const displayedCounts = { ...initialCounts };
    content.querySelectorAll(".team-player-form").forEach(form => {
      const teamId = form.dataset.team;
      const addButton = form.querySelector("button[type='submit']");
      const capacityMessage = form.closest(".team-player-card").querySelector(".team-capacity");
      const progress = form.closest(".team-player-card").querySelector(".team-capacity-progress");
      const updateCapacityMessage = () => {
        const count = Number.isSafeInteger(displayedCounts[teamId]) ? displayedCounts[teamId] : 0;
        const full = maxPlayersPerTeam !== null && count >= maxPlayersPerTeam;
        capacityMessage.textContent = !countsReady
          ? "Preparing team roster counts..."
          : `${count}${
            maxPlayersPerTeam === null ? " players · no limit" : ` of ${maxPlayersPerTeam} players`
          }${full ? " · Team is full" : ""}`;
        if (progress) progress.value = Math.min(count, maxPlayersPerTeam);
        addButton.disabled = !countsReady || full;
      };
      updateCapacityMessage();

      form.addEventListener("submit", async event => {
        event.preventDefault();
        await runAdminAction(async () => {
          const name = form.querySelector(".new-player-name").value.trim();
          if (!name) return;
          const tournament = tournamentRef();
          const team = tournament.collection("teams").doc(teamId);
          const player = tournament.collection("players").doc();
          const updatedCount = await db.runTransaction(async transaction => {
            const [tournamentSnapshot, teamSnapshot] = await Promise.all([
              transaction.get(tournament),
              transaction.get(team)
            ]);
            if (!tournamentSnapshot.exists) throw new Error("The tournament no longer exists.");
            if (!teamSnapshot.exists) throw new Error("The selected team no longer exists.");
            const tournamentData = tournamentSnapshot.data();
            const counts = tournamentData.teamPlayerCounts;
            if (!hasTeamPlayerCounts(counts)) {
              throw new Error("Team player counts are still initializing. Try again shortly.");
            }
            const count = counts[teamId] === undefined ? 0 : counts[teamId];
            if (!Number.isSafeInteger(count) || count < 0) {
              throw new Error("The team player count is inconsistent. Refresh and try again.");
            }
            const limit = tournamentData.maxPlayersPerTeam;
            if (limit !== null && limit !== undefined &&
                (!Number.isSafeInteger(limit) || limit < 0)) {
              throw new Error("The per-team player limit is invalid. Review tournament settings.");
            }
            if (Number.isInteger(limit) && count >= limit) {
              throw new Error(`This team has reached its limit of ${limit} players.`);
            }
            const updatedCounts = { ...counts, [teamId]: count + 1 };
            transaction.set(player, {
              name,
              teamId,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            transaction.update(tournament, { teamPlayerCounts: updatedCounts });
            return count + 1;
          });
          displayedCounts[teamId] = updatedCount;
          form.reset();
          updateCapacityMessage();
        });
      });
    });
    content.querySelectorAll("[data-player-action]").forEach(button => {
      button.addEventListener("click", () => runAdminAction(async () => {
        const id = button.dataset.player;
        const player = tournamentRef().collection("players").doc(id);
        if (button.dataset.playerAction === "save") {
          const name = content.querySelector(`.edit-player-name[data-player="${id}"]`).value.trim();
          const teamId = content.querySelector(`.edit-player-team[data-player="${id}"]`).value;
          if (!name || !teamId) throw new Error("Player name and team are required.");
          const tournament = tournamentRef();
          const team = tournament.collection("teams").doc(teamId);
          await db.runTransaction(async transaction => {
            const [tournamentSnapshot, playerSnapshot, teamSnapshot] = await Promise.all([
              transaction.get(tournament),
              transaction.get(player),
              transaction.get(team)
            ]);
            if (!tournamentSnapshot.exists) throw new Error("The tournament no longer exists.");
            if (!playerSnapshot.exists) throw new Error("The player no longer exists.");
            if (!teamSnapshot.exists) throw new Error("The selected team no longer exists.");
            const tournamentData = tournamentSnapshot.data();
            const counts = tournamentData.teamPlayerCounts;
            if (!hasTeamPlayerCounts(counts)) {
              throw new Error("Team player counts are still initializing. Try again shortly.");
            }
            const previousTeamId = playerSnapshot.data().teamId;
            if (previousTeamId !== teamId) {
              const previousCount = counts[previousTeamId];
              if (!Number.isSafeInteger(previousCount) || previousCount < 1) {
                throw new Error("The current team count is inconsistent. Refresh and try again.");
              }
              const nextCount = counts[teamId] === undefined ? 0 : counts[teamId];
              if (!Number.isSafeInteger(nextCount) || nextCount < 0) {
                throw new Error("The selected team count is inconsistent. Refresh and try again.");
              }
              const limit = tournamentData.maxPlayersPerTeam;
              if (limit !== null && limit !== undefined &&
                  (!Number.isSafeInteger(limit) || limit < 0)) {
                throw new Error("The per-team player limit is invalid. Review tournament settings.");
              }
              if (Number.isInteger(limit) && nextCount >= limit) {
                throw new Error(`The selected team has reached its limit of ${limit} players.`);
              }
              const updatedCounts = {
                ...counts,
                [previousTeamId]: previousCount - 1,
                [teamId]: nextCount + 1
              };
              transaction.update(tournament, { teamPlayerCounts: updatedCounts });
            }
            transaction.update(player, { name, teamId });
          });
        } else if (confirm("Delete this player?")) {
          const tournament = tournamentRef();
          await db.runTransaction(async transaction => {
            const [tournamentSnapshot, playerSnapshot] = await Promise.all([
              transaction.get(tournament),
              transaction.get(player)
            ]);
            if (!playerSnapshot.exists) return;
            if (!tournamentSnapshot.exists) throw new Error("The tournament no longer exists.");
            const tournamentData = tournamentSnapshot.data();
            const counts = tournamentData.teamPlayerCounts;
            if (!hasTeamPlayerCounts(counts)) {
              throw new Error("Team player counts are still initializing. Try again shortly.");
            }
            const teamId = playerSnapshot.data().teamId;
            const count = counts[teamId];
            if (!Number.isSafeInteger(count) || count < 1) {
              throw new Error("The team player count is inconsistent. Refresh and try again.");
            }
            const updatedCounts = { ...counts, [teamId]: count - 1 };
            transaction.delete(player);
            transaction.update(tournament, { teamPlayerCounts: updatedCounts });
          });
        }
      }));
    });
  }

  async function generateLeagueFixtures() {
    if (!confirm("Replace existing league fixtures?")) return;
    const writes = matches
      .filter(match => match.stage === "League")
      .map(match => ({ type: "delete", ref: tournamentRef().collection("matches").doc(match.id) }));
    const rotation = [...teams];
    if (rotation.length % 2 !== 0) rotation.push(null);
    const roundCount = rotation.length - 1;
    const pairsPerRound = rotation.length / 2;

    for (let round = 0; round < roundCount; round++) {
      for (let pair = 0; pair < pairsPerRound; pair++) {
        const first = rotation[pair];
        const second = rotation[rotation.length - 1 - pair];
        if (first && second) {
          const teamA = round % 2 === 0 ? first : second;
          const teamB = round % 2 === 0 ? second : first;
          writes.push({
            type: "set",
            ref: tournamentRef().collection("matches").doc(),
            data: {
            stage: "League",
            round: `Round ${round + 1}`,
            teamAId: teamA.id,
            teamBId: teamB.id,
            teamAScore: 0,
            teamBScore: 0,
            status: "scheduled",
            goals: [],
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
            }
          });
        }
      }
      const rest = rotation.slice(1);
      rest.unshift(rest.pop());
      rotation.splice(1, rotation.length - 1, ...rest);
    }
    await commitWrites(writes);
  }

  async function commitWrites(writes) {
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = db.batch();
      writes.slice(offset, offset + 400).forEach(write => {
        if (write.type === "delete") batch.delete(write.ref);
        else batch.set(write.ref, write.data);
      });
      await batch.commit();
    }
  }

  async function generateQuarterFinals() {
    const standings = calculateStandings();
    if (standings.length < 8) return;
    if (!confirm("Replace existing knockout fixtures?")) return;
    const existing = matches.filter(match => match.stage === "Knockout");
    const batch = db.batch();
    existing.forEach(match => batch.delete(tournamentRef().collection("matches").doc(match.id)));
    for (let index = 0; index < 4; index++) {
      const ref = tournamentRef().collection("matches").doc();
      batch.set(ref, {
        stage: "Knockout",
        round: "Quarter-finals",
        bracketIndex: index,
        teamAId: standings[index].teamId,
        teamBId: standings[7 - index].teamId,
        teamAScore: 0,
        teamBScore: 0,
        status: "scheduled",
        goals: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    await batch.commit();
  }

  function bindMatchAdmin(content) {
    content.querySelectorAll("[data-action]").forEach(button => {
      button.addEventListener("click", () => {
        const messages = {
          start: "Match started.",
          goal: "Goal saved and score updated.",
          finish: "Match finished.",
          reopen: "Match reopened.",
        };
        runAdminAction(
          () => handleMatchAction(button.dataset.action, button.dataset.match),
          messages[button.dataset.action] || ""
        );
      });
    });
    content.querySelectorAll(".remove-goal").forEach(button => {
      button.addEventListener("click", () => runAdminAction(
        () => removeGoal(button.dataset.match, button.dataset.goal),
        "Goal removed and score corrected."
      ));
    });
    content.querySelectorAll(".save-goal").forEach(button => {
      button.addEventListener("click", () => runAdminAction(
        () => editGoal(button.dataset.match, button.dataset.goal, button),
        "Goal scorer updated."
      ));
    });
    content.querySelectorAll(".edit-goal-team").forEach(select => {
      select.addEventListener("change", () => {
        const playerSelect = select.closest(".goal-item")?.querySelector(".edit-goal-player");
        const match = matches.find(item => item.id === select.dataset.match);
        if (!playerSelect || !match) return;
        const eligiblePlayers = getPlayersForMatch(match, select.value);
        playerSelect.innerHTML = eligiblePlayers.map(player =>
          `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`
        ).join("");
      });
    });
    content.querySelectorAll(".goal-team").forEach(select => {
      select.addEventListener("change", () => {
        const playerSelect = select.closest(".match-card")?.querySelector(".goal-player");
        const match = matches.find(item => item.id === select.dataset.match);
        if (!playerSelect || !match) return;
        playerSelect.innerHTML = getPlayersForMatch(match, select.value).map(player =>
          `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`
        ).join("");
      });
    });
  }

  async function runAdminAction(action, successMessage = "") {
    try {
      await action();
      showAdminMessage(successMessage);
    } catch (error) {
      const message = error?.message || String(error);
      if (error?.code === "unavailable" || /client is offline|offline/i.test(message)) {
        showAdminMessage("Firestore is offline or unreachable. Enable the Cloud Firestore API, create the default Firestore database, and check the connection, then try again.");
      } else if (error?.code === "not-found" || /database.*does not exist/i.test(message)) {
        showAdminMessage("The Firestore database was not found. Create the default Cloud Firestore database in Firebase Console, then try again.");
      } else if (error?.code === "permission-denied") {
        showAdminMessage("Firestore denied this action. Confirm the Cloud Firestore API is enabled, you are signed in as this tournament's Owner, and the current firestore.rules are published.");
      } else if (error?.code === "unauthenticated") {
        showAdminMessage("Sign in with the tournament Owner account, then try again.");
      } else {
        showAdminMessage(`Action failed: ${message}`);
      }
    }
  }

  async function handleMatchAction(action, matchId) {
    const ref = tournamentRef().collection("matches").doc(matchId);
    const match = matches.find(item => item.id === matchId);
    if (!match) return;

    if (action === "start") {
      await ref.update({ status: "live" });
    }

    if (action === "goal") {
      const card = document.querySelector(`.match-card [data-action="goal"][data-match="${matchId}"]`)?.closest(".match-card");
      const teamId = card?.querySelector(".goal-team")?.value;
      const playerId = card?.querySelector(".goal-player")?.value;
      if (!teamId || !playerId) return;
      const goal = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        teamId,
        playerId,
        playerName: playerName(playerId),
      };
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error("The match no longer exists.");
        const current = snapshot.data();
        const goals = [...(current.goals || []), goal];
        transaction.update(ref, scoreFields(current, goals));
      });
    }

    if (action === "finish") {
      await ref.update({ status: "finished" });
      if (isOwner) await progressKnockout(match);
    }

    if (action === "reopen") {
      await ref.update({ status: "live" });
    }
  }

  async function removeGoal(matchId, goalId) {
    const ref = tournamentRef().collection("matches").doc(matchId);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("The match no longer exists.");
      const current = snapshot.data();
      const goals = (current.goals || []).filter(goal => goal.id !== goalId);
      transaction.update(ref, scoreFields(current, goals));
    });
  }

  async function editGoal(matchId, goalId, button) {
    const ref = tournamentRef().collection("matches").doc(matchId);
    const goalRow = button.closest(".goal-item");
    const teamId = goalRow?.querySelector(".edit-goal-team")?.value;
    const playerId = goalRow?.querySelector(".edit-goal-player")?.value;
    const selectedPlayer = players.find(player => player.id === playerId);
    if (!teamId || !selectedPlayer || selectedPlayer.teamId !== teamId) {
      throw new Error("Select a scorer from the selected team.");
    }
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("The match no longer exists.");
      const current = snapshot.data();
      const goals = (current.goals || []).map(goal => goal.id === goalId
        ? { ...goal, teamId, playerId, playerName: selectedPlayer.name }
        : goal
      );
      transaction.update(ref, scoreFields(current, goals));
    });
  }

  function scoreFields(match, goals) {
    return {
      goals,
      teamAScore: goals.filter(goal => goal.teamId === match.teamAId).length,
      teamBScore: goals.filter(goal => goal.teamId === match.teamBId).length,
    };
  }

  async function progressKnockout(finishedMatch) {
    if (finishedMatch.stage !== "Knockout") return;
    if (finishedMatch.teamAScore === finishedMatch.teamBScore) return;
    const winnerId = finishedMatch.teamAScore > finishedMatch.teamBScore
      ? finishedMatch.teamAId
      : finishedMatch.teamBId;

    if (finishedMatch.round === "Quarter-finals") {
      const currentFinals = matches.filter(match => match.round === "Semi-finals");
      let target = currentFinals[finishedMatch.bracketIndex < 2 ? 0 : 1];
      if (!target) {
        const targetIndex = finishedMatch.bracketIndex < 2 ? 0 : 1;
        const ref = tournamentRef().collection("matches").doc();
        await ref.set({
          stage: "Knockout", round: "Semi-finals", bracketIndex: targetIndex,
          teamAId: targetIndex === 0 ? winnerId : null,
          teamBId: targetIndex === 0 ? null : winnerId,
          teamAScore: 0, teamBScore: 0, status: "scheduled", goals: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        const field = finishedMatch.bracketIndex % 2 === 0 ? "teamAId" : "teamBId";
        await tournamentRef().collection("matches").doc(target.id).update({ [field]: winnerId });
      }
    } else if (finishedMatch.round === "Semi-finals") {
      const finals = matches.find(match => match.round === "Final");
      if (finals) {
        const field = finishedMatch.bracketIndex === 0 ? "teamAId" : "teamBId";
        await tournamentRef().collection("matches").doc(finals.id).update({ [field]: winnerId });
      } else {
        const ref = tournamentRef().collection("matches").doc();
        await ref.set({
          stage: "Knockout", round: "Final", bracketIndex: 0,
          teamAId: finishedMatch.bracketIndex === 0 ? winnerId : null,
          teamBId: finishedMatch.bracketIndex === 1 ? winnerId : null,
          teamAScore: 0, teamBScore: 0, status: "scheduled", goals: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    }
  }

  async function saveTournamentName(event) {
    event.preventDefault();
    const name = document.getElementById("settingsName").value.trim();
    if (!name) return;
    const rawLimit = document.getElementById("maxPlayersPerTeam").value.trim();
    const maxPlayersPerTeam = rawLimit === "" ? null : Number(rawLimit);
    if (maxPlayersPerTeam !== null &&
        (!Number.isSafeInteger(maxPlayersPerTeam) || maxPlayersPerTeam < 0)) {
      throw new Error("Enter a whole-number per-team limit of zero or more, or leave it blank for unlimited.");
    }
    const tournament = tournamentRef();
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(tournament);
      if (!snapshot.exists) throw new Error("The tournament no longer exists.");
      const tournamentData = snapshot.data();
      const countsReady = hasTeamPlayerCounts(tournamentData.teamPlayerCounts);
      if (!countsReady && !playersLoaded) {
        throw new Error("Team player counts are still loading. Try saving again shortly.");
      }
      const counts = countsReady
        ? tournamentData.teamPlayerCounts
        : buildTeamPlayerCounts();
      const teamCounts = Object.values(counts);
      if (teamCounts.some(count => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error("A team player count is inconsistent. Refresh and try again.");
      }
      transaction.update(tournament, {
        name,
        maxPlayersPerTeam,
        ...(countsReady ? {} : { teamPlayerCounts: counts }),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  }

  async function deleteCollection(collectionName) {
    const snapshot = await tournamentRef().collection(collectionName).get();
    let batch = db.batch();
    let count = 0;
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
      count++;
      if (count === 400) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
    if (count) await batch.commit();
  }

  async function resetTournament() {
    if (!confirm("Reset this tournament? This cannot be undone.")) return;
    await deleteCollection("teams");
    await deleteCollection("players");
    await deleteCollection("matches");
    await deleteCollection("scorekeepers");
    await tournamentRef().update({ teamPlayerCounts: {} });
  }

  function bindAppEvents() {
    modeButton.addEventListener("click", () => {
      const showingAdmin = !adminView.classList.contains("hidden");
      adminView.classList.toggle("hidden", showingAdmin);
      publicView.classList.toggle("hidden", !showingAdmin);
      modeButton.textContent = showingAdmin ? "Admin mode" : "Public mode";
    });

    document.getElementById("loginForm").addEventListener("submit", async event => {
      event.preventDefault();
      const message = document.getElementById("authMessage");
      try {
        await auth.signInWithEmailAndPassword(
          document.getElementById("adminEmail").value,
          document.getElementById("adminPassword").value
        );
        message.textContent = "";
      } catch (error) {
        message.textContent = error.message;
      }
    });

    document.getElementById("sendVerificationButton").addEventListener("click", async () => {
      try {
        await auth.currentUser.sendEmailVerification();
        showAdminMessage("Verification email sent. Check your inbox, then return and confirm verification.");
      } catch (error) {
        showAdminMessage(`Unable to send verification email: ${error.message}`);
      }
    });
    document.getElementById("checkVerificationButton").addEventListener("click", async () => {
      try {
        await auth.currentUser.reload();
        await auth.currentUser.getIdToken(true);
        currentUser = auth.currentUser;
        updateAuthorization();
        showAdminMessage(currentUser.emailVerified ? "Email verified." : "Email is not verified yet.");
      } catch (error) {
        showAdminMessage(`Unable to refresh verification status: ${error.message}`);
      }
    });

    document.getElementById("signOutButton").addEventListener("click", () =>
      runAdminAction(() => auth.signOut())
    );
    document.getElementById("newTournamentButton").addEventListener("click", () => {
      document.getElementById("newTournamentPanel").classList.toggle("hidden");
    });
    document.getElementById("cancelNewTournament").addEventListener("click", () => {
      document.getElementById("newTournamentPanel").classList.add("hidden");
    });
    document.getElementById("newTournamentForm").addEventListener("submit", async event => {
      event.preventDefault();
      await runAdminAction(async () => {
        const name = document.getElementById("newTournamentName").value.trim();
        if (!name) return;
        const collection = db.collection("tournaments");
        const id = `${slugify(name).slice(0, 60)}-${collection.doc().id}`;
        const tournamentDocument = collection.doc(id);
        showAdminMessage("Checking the Firestore connection...");
        await tournamentDocument.get({ source: "server" });
        showAdminMessage("Creating tournament...");
        await tournamentDocument.set({
          name,
          ownerUid: currentUser.uid,
          maxPlayersPerTeam: null,
          teamPlayerCounts: {},
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        activeTournamentId = id;
        document.getElementById("newTournamentPanel").classList.add("hidden");
        event.target.reset();
        listenToTournament(id);
      });
    });
    document.getElementById("tournamentSelect").addEventListener("change", event => {
      activeTournamentId = event.target.value;
      listenToTournament(activeTournamentId);
    });
  }

  initializePublic();
  bindAppEvents();
  renderPublic();
})();
