const fmtInt = (n) => Math.max(0, Math.floor(n)).toLocaleString();

const clamp01 = (x) => Math.max(0, Math.min(1, x));

const $ = (id) => document.getElementById(id);

const reverseCache = new Map();

async function reverseGeocodeCountry(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = reverseCache.get(key);
  if (cached) return cached;

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "3");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
    },
  });

  if (!resp.ok) throw new Error(`Reverse geocode failed: ${resp.status}`);
  const data = await resp.json();

  const country = data?.address?.country ?? null;
  const countryCode = data?.address?.country_code
    ? String(data.address.country_code).toUpperCase()
    : null;

  const result = { country, countryCode };
  reverseCache.set(key, result);
  return result;
}

const NATURAL_EARTH_COUNTRIES_GEOJSON_URL =
  "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson";

const TIME_LIMIT_DAYS = 365;
const SECONDS_PER_DAY = 1; // 1 real second == 1 in-game day

const MUTATION_POINT_TTL_MS = 12_000;

const TRAVEL_PLANE_EVERY_DAYS = 7;
const TRAVEL_BOAT_EVERY_DAYS = 11;
const TRAVEL_PLANE_DURATION_MS = 5200;
const TRAVEL_BOAT_DURATION_MS = 7800;

const PATHOGEN_BASE = {
  bacteria: {
    infectivity: 0.22,
    severity: 0.08,
    lethality: 0.02,
    mpRate: 0.55,
  },
  virus: {
    infectivity: 0.28,
    severity: 0.06,
    lethality: 0.02,
    mpRate: 0.45,
  },
};

const UPGRADES = {
  transmission: [
    {
      id: "air_1",
      name: "Airborne I",
      desc: "+Infectivity (spreads easier in cities)",
      cost: 6,
      effects: { infectivity: +0.06 },
      icon: "air",
      iconAnim: "float",
    },
    {
      id: "air_2",
      name: "Airborne II",
      desc: "+More infectivity",
      cost: 10,
      requires: ["air_1"],
      effects: { infectivity: +0.09 },
      icon: "air",
      iconAnim: "float",
    },
    {
      id: "water_1",
      name: "Waterborne",
      desc: "+Infectivity (spreads through water supply)",
      cost: 8,
      effects: { infectivity: +0.07 },
      icon: "water",
      iconAnim: "pulse",
    },
    {
      id: "animal_1",
      name: "Animal",
      desc: "+Infectivity (zoonotic vectors)",
      cost: 7,
      effects: { infectivity: +0.05 },
      icon: "animal",
      iconAnim: "float",
    },
    {
      id: "drug_resist",
      name: "Drug Resistance",
      desc: "-Cure progress (harder to eliminate)",
      cost: 12,
      effects: { cureSlow: 0.12 },
      icon: "shield",
      iconAnim: "pulse",
    },
  ],
  symptoms: [
    {
      id: "cough",
      name: "Coughing",
      desc: "+Infectivity, +Severity",
      cost: 5,
      effects: { infectivity: +0.03, severity: +0.05 },
      icon: "cough",
      iconAnim: "float",
    },
    {
      id: "fever",
      name: "Fever",
      desc: "+Severity",
      cost: 6,
      effects: { severity: +0.07 },
      icon: "temp",
      iconAnim: "pulse",
    },
    {
      id: "pneumonia",
      name: "Pneumonia",
      desc: "+Severity, +Lethality",
      cost: 10,
      requires: ["cough"],
      effects: { severity: +0.09, lethality: +0.06 },
      icon: "lungs",
      iconAnim: "pulse",
    },
    {
      id: "organ_failure",
      name: "Organ Failure",
      desc: "+High lethality (but slows spread)",
      cost: 16,
      requires: ["pneumonia"],
      effects: { lethality: +0.12, infectivity: -0.05, severity: +0.06 },
      icon: "skull",
      iconAnim: "pulse",
    },
  ],
};

const state = {
  running: false,
  tickHandle: null,
  pointHandle: null,

  pathogen: "bacteria",
  start: null, // {lat, lng}
  startCountry: null,
  startCountryCode: null,

  mp: 0,
  purchased: new Set(),
  recentPurchases: new Set(),

  infectivity: 0,
  severity: 0,
  lethality: 0,
  cureSlow: 0,

  // Simulation totals
  population: 8_100_000_000,
  infected: 0,
  dead: 0,
  cured: 0,

  days: 0,

  cureProgress: 0, // 0..1
};

let lastAnyAffordableUpgrade = false;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpLatLng(a, b, t) {
  return L.latLng(lerp(a.lat, b.lat, t), lerp(a.lng, b.lng, t));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function svgIcon(name) {
  // Keep icons simple; use existing theme colors.
  const stroke = "rgba(233, 236, 245, 0.92)";
  const accent = "rgba(139, 92, 246, 0.95)";

  if (name === "air") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 9c2.5-2 5.5-2 8 0 2.5 2 5.5 2 10 0" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
        <path d="M3 13c2.5-2 5.5-2 8 0 2.5 2 5.5 2 10 0" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
        <path d="M3 17c2.5-2 5.5-2 8 0 2.5 2 5.5 2 10 0" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "water") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3s6 7 6 11a6 6 0 1 1-12 0c0-4 6-11 6-11Z" stroke="${accent}" stroke-width="2"/>
        <path d="M9 14c.7 1.6 2.1 2.6 3.8 2.8" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "animal") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 12c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
        <path d="M6.5 14.5c1.3 3 3.6 4.5 5.5 4.5s4.2-1.5 5.5-4.5" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
        <path d="M9 9 7 6M15 9l2-3" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "shield") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3 19 6v6c0 5-3.5 8.6-7 9.9C8.5 20.6 5 17 5 12V6l7-3Z" stroke="${accent}" stroke-width="2"/>
        <path d="M9 12h6" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "cough") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 7c0-2 1.5-4 4-4 2.6 0 4 1.8 4 4v4" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
        <path d="M7 14c0 3 2 7 5 7s5-4 5-7" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
        <path d="M19 12c1 .2 2 .8 2 2s-1 1.8-2 2" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "temp") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 4a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0V4Z" stroke="${stroke}" stroke-width="2"/>
        <path d="M14 15a2 2 0 0 1-4 0" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "lungs") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3v8" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 11c-1.5-2.5-4-3.5-6-2-2 1.6-2 6 0 9 1.5 2.2 4.5 2.6 6 1" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 11c1.5-2.5 4-3.5 6-2 2 1.6 2 6 0 9-1.5 2.2-4.5 2.6-6 1" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (name === "skull") {
    return `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3c4.4 0 8 3.3 8 7.5 0 3-1.8 5.6-4.5 6.7V21h-7v-3.8C5.8 16.1 4 13.5 4 10.5 4 6.3 7.6 3 12 3Z" stroke="${accent}" stroke-width="2"/>
        <path d="M9.2 11.3h.01M14.8 11.3h.01" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>
        <path d="M10 15c1 .8 3 .8 4 0" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 12h12" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 6v12" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
}

function iconClass(anim) {
  if (anim === "pulse") return "upgrade__icon upgrade__icon--pulse";
  if (anim === "float") return "upgrade__icon upgrade__icon--float";
  return "upgrade__icon";
}

function computeTraits() {
  const base = PATHOGEN_BASE[state.pathogen];

  let infectivity = base.infectivity;
  let severity = base.severity;
  let lethality = base.lethality;
  let cureSlow = 0;

  for (const category of Object.values(UPGRADES)) {
    for (const u of category) {
      if (!state.purchased.has(u.id)) continue;
      infectivity += u.effects?.infectivity ?? 0;
      severity += u.effects?.severity ?? 0;
      lethality += u.effects?.lethality ?? 0;
      cureSlow += u.effects?.cureSlow ?? 0;
    }
  }

  // Keep within reasonable ranges for the toy model
  state.infectivity = clamp01(infectivity);
  state.severity = clamp01(severity);
  state.lethality = clamp01(lethality);
  state.cureSlow = clamp01(cureSlow);
}

function resetGame() {
  state.running = false;
  if (state.tickHandle) window.clearInterval(state.tickHandle);
  if (state.pointHandle) window.clearInterval(state.pointHandle);
  state.tickHandle = null;
  state.pointHandle = null;

  stopTravelLoop();

  state.start = null;
  state.startCountry = null;
  state.startCountryCode = null;
  state.mp = 0;
  state.purchased = new Set();
  state.recentPurchases = new Set();

  state.infected = 0;
  state.dead = 0;
  state.cured = 0;
  state.cureProgress = 0;
  state.days = 0;

  state.pathogen = document.querySelector('input[name="pathogen"]:checked')?.value ?? "bacteria";
  computeTraits();
  updateUI();

  lastAnyAffordableUpgrade = false;
  closeMobilePanels(true);

  startMarker?.remove();
  startMarker = null;

  clearCountryInfections();

  for (const m of mutationMarkers) m.remove();
  mutationMarkers.clear();

  $("btn-start").disabled = true;
  $("start-coords").textContent = "Not set";
  $("start-hint").textContent = "Click the map to choose a starting location.";
}

function anyAffordableUpgrade() {
  for (const category of Object.values(UPGRADES)) {
    for (const u of category) {
      if (canBuy(u)) return true;
    }
  }
  return false;
}

function canBuy(upgrade) {
  if (state.purchased.has(upgrade.id)) return false;
  if (state.mp < upgrade.cost) return false;
  if (!upgrade.requires?.length) return true;
  return upgrade.requires.every((id) => state.purchased.has(id));
}

function buyUpgrade(upgrade) {
  if (!canBuy(upgrade)) return;
  state.mp -= upgrade.cost;
  state.purchased.add(upgrade.id);

  state.recentPurchases.add(upgrade.id);
  window.setTimeout(() => {
    state.recentPurchases.delete(upgrade.id);
    updateUI();
  }, 650);

  computeTraits();
  updateUI();
}

function renderUpgrades(category) {
  const list = $("upgrade-list");
  list.innerHTML = "";

  for (const u of UPGRADES[category]) {
    const card = document.createElement("div");
    card.className = "upgrade";
    if (state.recentPurchases.has(u.id)) card.classList.add("upgrade--purchased");

    const left = document.createElement("div");
    left.className = "upgrade__left";

    const iconWrap = document.createElement("div");
    iconWrap.className = iconClass(u.iconAnim);
    iconWrap.innerHTML = svgIcon(u.icon);

    const textWrap = document.createElement("div");
    const name = document.createElement("div");
    name.className = "upgrade__name";
    name.textContent = u.name;

    const desc = document.createElement("div");
    desc.className = "upgrade__desc";
    desc.textContent = u.desc;

    const requires = u.requires?.length ? `Requires: ${u.requires.join(", ")}` : "";
    if (requires) {
      const reqEl = document.createElement("div");
      reqEl.className = "upgrade__desc";
      reqEl.textContent = requires;
      textWrap.appendChild(name);
      textWrap.appendChild(desc);
      textWrap.appendChild(reqEl);
    } else {
      textWrap.appendChild(name);
      textWrap.appendChild(desc);
    }

    left.appendChild(iconWrap);
    left.appendChild(textWrap);

    const right = document.createElement("div");
    right.className = "upgrade__cta";

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = `${u.cost} MP`;

    const btn = document.createElement("button");
    btn.className = "btn";

    const bought = state.purchased.has(u.id);
    btn.textContent = bought ? "Purchased" : "Buy";
    btn.disabled = bought || !canBuy(u);
    btn.addEventListener("click", () => buyUpgrade(u));

    right.appendChild(badge);
    right.appendChild(btn);

    card.appendChild(left);
    card.appendChild(right);
    list.appendChild(card);
  }
}

function updateBars() {
  $("bar-infectivity").style.width = `${Math.round(state.infectivity * 100)}%`;
  $("bar-severity").style.width = `${Math.round(state.severity * 100)}%`;
  $("bar-lethality").style.width = `${Math.round(state.lethality * 100)}%`;
}

function updateUI() {
  $("stat-mp").textContent = fmtInt(state.mp);
  $("stat-days").textContent = `${fmtInt(state.days)}/${TIME_LIMIT_DAYS}`;
  $("stat-infected").textContent = fmtInt(state.infected);
  $("stat-dead").textContent = fmtInt(state.dead);
  $("stat-cured").textContent = fmtInt(state.cured);
  updateBars();

  updateCountryShading();

  renderUpgrades(activeTab);

  // Mobile: if the player just gained enough MP to buy something, surface the upgrades/traits popup.
  const affordableNow = anyAffordableUpgrade();
  if (isMobileUiActive() && affordableNow && !lastAnyAffordableUpgrade) {
    openMobilePanels();
  }
  lastAnyAffordableUpgrade = affordableNow;
}

// --- Map setup ---
let map;
let startMarker = null;
const mutationMarkers = new Set();

function syncTopbarHeightVar() {
  const topbar = document.querySelector(".topbar");
  const h = topbar?.offsetHeight ? Math.max(48, topbar.offsetHeight) : 62;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
}

let tileLayer = null;
const TILE_STYLES = {
  osm: {
    name: "Default",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
  },
  light: {
    name: "Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap contributors © CARTO",
  },
  dark: {
    name: "Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap contributors © CARTO",
  },
};

let countriesLayer = null;
const countriesByIso2 = new Map();
const countryCentroidsByIso2 = new Map();
const infectedCountries = new Map(); // iso2 -> { level: 0..1 }
const shadedCountries = new Set();

function defaultCountryStyle() {
  return {
    color: "#000000",
    weight: 0,
    fillOpacity: 0,
  };
}

function infectedCountryStyle(intensity01) {
  const t = clamp01(intensity01);
  return {
    color: "#ef4444",
    weight: 1,
    opacity: 0.8,
    fillColor: "#ef4444",
    fillOpacity: 0.08 + t * 0.62,
  };
}

function clearCountryInfections() {
  for (const iso2 of shadedCountries) {
    const layer = countriesByIso2.get(iso2);
    if (layer) layer.setStyle(defaultCountryStyle());
  }
  shadedCountries.clear();
  infectedCountries.clear();
}

function infectCountry(iso2, seedLevel = 0.12, bumpGlobalInfected = true) {
  if (!iso2) return;
  const key = String(iso2).toUpperCase();
  const current = infectedCountries.get(key);
  const nextLevel = Math.max(current?.level ?? 0, seedLevel);
  infectedCountries.set(key, { level: nextLevel });

  const layer = countriesByIso2.get(key);
  if (layer) shadedCountries.add(key);

  if (bumpGlobalInfected) {
    state.infected = Math.min(state.population, state.infected + 50_000);
  }
}

function tickCountryInfections(dtDays) {
  if (infectedCountries.size === 0) return;

  // Growth is driven by infectivity and global infection scale.
  const globalScale = clamp01(Math.log10(1 + state.infected) / 10);
  const rate = (0.004 + state.infectivity * 0.014 + globalScale * 0.01) * dtDays;

  for (const [iso2, entry] of infectedCountries.entries()) {
    const level = clamp01(entry.level + rate * (1 - entry.level));
    infectedCountries.set(iso2, { level });
  }
}

function updateCountryShading() {
  if (shadedCountries.size === 0) return;

  for (const iso2 of shadedCountries) {
    const layer = countriesByIso2.get(iso2);
    const entry = infectedCountries.get(iso2);
    if (!layer || !entry) continue;

    // Combine per-country infection level with global scale.
    const globalIntensity = clamp01(Math.log10(1 + state.infected) / 8);
    const intensity = clamp01(entry.level * (0.35 + globalIntensity * 0.9));
    layer.setStyle(infectedCountryStyle(intensity));
  }
}

async function loadCountriesLayer() {
  if (!map || countriesLayer) return;

  const resp = await fetch(NATURAL_EARTH_COUNTRIES_GEOJSON_URL);
  if (!resp.ok) throw new Error(`Failed to load countries GeoJSON: ${resp.status}`);
  const geojson = await resp.json();

  countriesLayer = L.geoJSON(geojson, {
    style: defaultCountryStyle,
    onEachFeature: (feature, layer) => {
      const iso2 = feature?.properties?.ISO_A2;
      if (iso2 && typeof iso2 === "string") {
        const key = iso2.toUpperCase();
        countriesByIso2.set(key, layer);
        try {
          countryCentroidsByIso2.set(key, layer.getBounds().getCenter());
        } catch {
          // Ignore invalid geometries
        }
      }
    },
  }).addTo(map);
}

function getAllCountryIso2() {
  return Array.from(countriesByIso2.keys());
}

// --- Travel (planes/boats) ---
const travelRoutes = new Set();
let travelAnimHandle = null;
let lastPlaneDay = 0;
let lastBoatDay = 0;

function travelSvg(type) {
  const stroke = "rgba(233, 236, 245, 0.9)";
  const accent = "rgba(139, 92, 246, 0.95)";

  if (type === "plane") {
    return `
      <div class="travelIcon travelIcon--plane" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 13l20-6-6 8-4 1-2 6-2-8-6-1Z" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>
          <path d="M10 14l4-1" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>`;
  }

  return `
    <div class="travelIcon travelIcon--boat" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 14h16l-2 6H6l-2-6Z" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M8 14V6l4 3 4-3v8" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
}

function makeTravelIcon(type) {
  return L.divIcon({
    className: "",
    html: travelSvg(type),
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function startTravelLoop() {
  if (travelAnimHandle) return;

  const tick = () => {
    const now = performance.now();
    for (const route of Array.from(travelRoutes)) {
      const t = clamp01((now - route.startMs) / route.durationMs);
      route.marker.setLatLng(lerpLatLng(route.from, route.to, t));
      if (t >= 1) {
        route.marker.remove();
        travelRoutes.delete(route);
        infectCountry(route.toIso2, 0.14, true);
        updateUI();
      }
    }
    travelAnimHandle = requestAnimationFrame(tick);
  };

  travelAnimHandle = requestAnimationFrame(tick);
}

function stopTravelLoop() {
  if (travelAnimHandle) cancelAnimationFrame(travelAnimHandle);
  travelAnimHandle = null;
  for (const route of travelRoutes) {
    route.marker.remove();
  }
  travelRoutes.clear();
  lastPlaneDay = 0;
  lastBoatDay = 0;
}

function trySpawnTravel() {
  if (!state.running) return;
  if (infectedCountries.size === 0) return;
  if (countriesByIso2.size === 0) return;

  const allIso2 = getAllCountryIso2();
  if (allIso2.length === 0) return;

  const infectedList = Array.from(infectedCountries.keys());
  const sourceIso2 = pickRandom(infectedList);

  let destIso2 = null;
  for (let i = 0; i < 12; i++) {
    const cand = pickRandom(allIso2);
    if (!infectedCountries.has(cand)) {
      destIso2 = cand;
      break;
    }
  }
  if (!destIso2) destIso2 = pickRandom(allIso2);

  const from = countryCentroidsByIso2.get(sourceIso2) ?? L.latLng((Math.random() * 140) - 70, (Math.random() * 360) - 180);
  const to = countryCentroidsByIso2.get(destIso2) ?? L.latLng((Math.random() * 140) - 70, (Math.random() * 360) - 180);

  const nowDay = state.days;
  const shouldPlane = nowDay - lastPlaneDay >= TRAVEL_PLANE_EVERY_DAYS;
  const shouldBoat = nowDay - lastBoatDay >= TRAVEL_BOAT_EVERY_DAYS;

  // Spawn at most one per tick.
  let type = null;
  if (shouldPlane) type = "plane";
  else if (shouldBoat) type = "boat";
  else return;

  if (type === "plane") lastPlaneDay = nowDay;
  if (type === "boat") lastBoatDay = nowDay;

  const marker = L.marker(from, { icon: makeTravelIcon(type), interactive: false }).addTo(map);
  travelRoutes.add({
    type,
    from,
    to,
    toIso2: destIso2,
    marker,
    startMs: performance.now(),
    durationMs: type === "plane" ? TRAVEL_PLANE_DURATION_MS : TRAVEL_BOAT_DURATION_MS,
  });

  startTravelLoop();
}

function spawnMutationPoint() {
  if (!map || !state.running) return;

  // Keep them within typical world view bounds.
  const lat = (Math.random() * 140) - 70; // -70..70
  const lng = (Math.random() * 360) - 180; // -180..180

  const svg = `
    <div class="dnaMarker" aria-label="Mutation point">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path class="dnaGlow" d="M8 4c4 0 8 4 8 8s-4 8-8 8" stroke="rgba(139, 92, 246, 0.95)" stroke-width="2" stroke-linecap="round"/>
        <path class="dnaGlow" d="M16 4c-4 0-8 4-8 8s4 8 8 8" stroke="rgba(233, 236, 245, 0.85)" stroke-width="2" stroke-linecap="round"/>
        <path d="M9 7h6M9 11h6M9 15h6M9 19h6" stroke="rgba(233, 236, 245, 0.55)" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </div>`;

  const icon = L.divIcon({
    className: "",
    html: svg,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  const marker = L.marker([lat, lng], { icon }).addTo(map);

  marker.bindTooltip("Mutation point (+1 MP)", { direction: "top" });

  const ttl = window.setTimeout(() => {
    marker.remove();
    mutationMarkers.delete(marker);
  }, MUTATION_POINT_TTL_MS);

  marker.on("click", () => {
    window.clearTimeout(ttl);
    state.mp += 1;
    marker.remove();
    mutationMarkers.delete(marker);
    updateUI();
  });

  mutationMarkers.add(marker);

  // Trim old points so the map doesn't fill up.
  if (mutationMarkers.size > 14) {
    const first = mutationMarkers.values().next().value;
    if (first) {
      first.remove();
      mutationMarkers.delete(first);
    }
  }
}

function initMap() {
  map = L.map("map", {
    worldCopyJump: true,
    zoomControl: true,
  }).setView([20, 0], 2);

  tileLayer = L.tileLayer(TILE_STYLES.osm.url, {
    maxZoom: 6,
    minZoom: 2,
    attribution: TILE_STYLES.osm.attribution,
  }).addTo(map);

  // Keep attribution visible in our UI.
  document.querySelector(".mapAttribution").textContent = TILE_STYLES.osm.attribution;

  // Load country polygons for tinting (best-effort).
  loadCountriesLayer().catch((err) => {
    console.warn("Could not load country polygons:", err);
  });

  map.on("click", async (e) => {
    if (state.running) return;
    const { lat, lng } = e.latlng;
    state.start = { lat, lng };

    if (startMarker) startMarker.remove();
    startMarker = L.marker([lat, lng]).addTo(map);
    startMarker.bindTooltip("Outbreak origin", { permanent: false });

    $("start-coords").textContent = "Resolving country…";
    $("btn-start").disabled = false;
    $("start-hint").textContent = "Ready. Start the simulation when you want.";

    try {
      const { country, countryCode } = await reverseGeocodeCountry(lat, lng);
      state.startCountry = country;
      state.startCountryCode = countryCode;

      if (country) {
        $("start-coords").textContent = country;
      } else {
        $("start-coords").textContent = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
      }

      if (countryCode) {
        // Preview a small infection tint for the chosen start country.
        infectCountry(countryCode, 0.04, false);
        updateUI();
      }
    } catch (err) {
      console.warn("Reverse geocode failed:", err);
      $("start-coords").textContent = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
    }
  });
}

function safeInvalidateMapSize() {
  if (!map) return;
  try {
    map.invalidateSize({ animate: false });
  } catch {
    // ignore
  }
}

function setMapStyle(styleKey) {
  const style = TILE_STYLES[styleKey] ?? TILE_STYLES.osm;
  if (!map) return;

  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(style.url, {
    maxZoom: 6,
    minZoom: 2,
    attribution: style.attribution,
  }).addTo(map);

  const attrEl = document.querySelector(".mapAttribution");
  if (attrEl) attrEl.textContent = style.attribution;
}

// --- Simulation loop ---
function startSimulation() {
  if (!state.start || state.running) return;

  state.running = true;
  state.pathogen = document.querySelector('input[name="pathogen"]:checked')?.value ?? "bacteria";
  computeTraits();

  // Seed infections
  state.infected = 1200;
  state.dead = 0;
  state.cured = 0;
  state.cureProgress = 0;
  state.days = 0;

  // Ensure origin country shows infection, and travel can start from it.
  if (state.startCountryCode) {
    infectCountry(state.startCountryCode, 0.18, false);
  }

  $("btn-start").disabled = true;
  $("start-hint").textContent = "Simulation running. Collect mutation points on the map.";

  // Every second: advance the toy model
  state.tickHandle = window.setInterval(() => {
    stepSimulation(SECONDS_PER_DAY);
  }, 1000);

  // Mutation points appear periodically
  state.pointHandle = window.setInterval(() => {
    spawnMutationPoint();
  }, 2200);

  updateUI();
}

function stepSimulation(dtSeconds) {
  computeTraits();

  state.days += dtSeconds;

  if (state.days >= TIME_LIMIT_DAYS) {
    stopSimulation("Time's up: the world holds out.");
    updateUI();
    return;
  }

  const pop = state.population;
  const susceptible = Math.max(0, pop - state.infected - state.dead - state.cured);

  // Cure progresses more as severity rises, but slowed by resistance.
  const cureRate = (0.00035 + state.severity * 0.0012) * (1 - 0.75 * state.cureSlow);
  state.cureProgress = clamp01(state.cureProgress + cureRate * dtSeconds);

  // Infection growth (logistic-ish):
  // - infectivity drives spread
  // - severity reduces mobility (slows spread)
  // - cure progress reduces spread
  const spreadFactor =
    (0.28 + state.infectivity * 1.25) * (1 - state.severity * 0.55) * (1 - state.cureProgress * 0.75);

  const newInfections = Math.min(susceptible, state.infected * spreadFactor * 0.18 * dtSeconds);

  // Deaths are proportional to infected and lethality, increased slightly by severity.
  const deathFactor = (state.lethality * 0.09 + state.severity * 0.01) * (1 - state.cureProgress * 0.5);
  const newDeaths = Math.min(state.infected, state.infected * deathFactor * dtSeconds);

  // Cures increase as cure progress rises.
  const cureFactor = (0.002 + state.cureProgress * 0.035) * (1 - state.lethality * 0.4);
  const newCures = Math.min(state.infected - newDeaths, state.infected * cureFactor * dtSeconds);

  state.infected = Math.max(0, state.infected + newInfections - newDeaths - newCures);
  state.dead = Math.min(pop, state.dead + newDeaths);
  state.cured = Math.min(pop - state.dead, state.cured + newCures);

  // Earn mutation points over time and with infection scale.
  const baseMp = PATHOGEN_BASE[state.pathogen].mpRate;
  const infectionScale = Math.log10(1 + state.infected) / 10; // 0..~1
  state.mp += (baseMp + infectionScale) * 0.06 * dtSeconds;

  // Spread infection to other countries via travel routes.
  tickCountryInfections(dtSeconds);
  trySpawnTravel();

  updateUI();

  // Win/lose-ish stop conditions
  if (state.dead >= pop * 0.85) {
    stopSimulation("Outcome: Humanity collapses.");
  } else if (state.cureProgress >= 1 && state.infected < 50_000) {
    stopSimulation("Outcome: The world contains the outbreak.");
  }
}

function stopSimulation(message) {
  state.running = false;
  if (state.tickHandle) window.clearInterval(state.tickHandle);
  if (state.pointHandle) window.clearInterval(state.pointHandle);
  state.tickHandle = null;
  state.pointHandle = null;

  stopTravelLoop();

  $("start-hint").textContent = message;
  $("btn-start").disabled = true;
}

// --- Tabs + wiring ---
let activeTab = "transmission";

function setTab(tab) {
  activeTab = tab;
  const t1 = $("tab-transmission");
  const t2 = $("tab-symptoms");

  const isTransmission = tab === "transmission";
  t1.classList.toggle("tab--active", isTransmission);
  t2.classList.toggle("tab--active", !isTransmission);
  t1.setAttribute("aria-selected", String(isTransmission));
  t2.setAttribute("aria-selected", String(!isTransmission));

  renderUpgrades(activeTab);
}

function initUI() {
  $("tab-transmission").addEventListener("click", () => setTab("transmission"));
  $("tab-symptoms").addEventListener("click", () => setTab("symptoms"));

  $("btn-start").addEventListener("click", startSimulation);
  $("btn-reset").addEventListener("click", resetGame);

  document.querySelectorAll('input[name="pathogen"]').forEach((el) => {
    el.addEventListener("change", () => {
      if (state.running) return;
      state.pathogen = document.querySelector('input[name="pathogen"]:checked')?.value ?? "bacteria";
      computeTraits();
      updateUI();
    });
  });

  const mapStyleSel = $("map-style");
  if (mapStyleSel) {
    mapStyleSel.addEventListener("change", () => {
      setMapStyle(mapStyleSel.value);
    });
  }

  // Mobile popup wiring
  const openBtn = $("btn-mobile-panels");
  const closeBtn = $("btn-mobile-panels-close");
  const modal = $("mobilePanels");
  openBtn?.addEventListener("click", () => openMobilePanels());
  closeBtn?.addEventListener("click", () => closeMobilePanels());
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeMobilePanels();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMobilePanels();
  });

  // Responsive sync (layout + map scaling)
  let resizeTimer = null;
  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      syncTopbarHeightVar();
      applyMobilePanelsLayout();
      safeInvalidateMapSize();
    }, 120);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
}

function boot() {
  syncTopbarHeightVar();
  initMap();
  initUI();
  applyMobilePanelsLayout();
  resetGame();
  setTab("transmission");

  // One more invalidate after first paint so Leaflet sizes correctly on mobile.
  window.setTimeout(() => safeInvalidateMapSize(), 80);
}

boot();

// --- Mobile popup / responsive layout ---
let mobileUiActive = false;
let upgradesMount = null;
let traitsMount = null;

function isMobileUiActive() {
  return mobileUiActive;
}

function openMobilePanels() {
  if (!mobileUiActive) return;
  const modal = $("mobilePanels");
  if (!modal) return;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modalOpen");
}

function closeMobilePanels(force = false) {
  const modal = $("mobilePanels");
  if (!modal) return;
  const isOpen = modal.getAttribute("aria-hidden") === "false";
  if (!isOpen && !force) return;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modalOpen");
}

function applyMobilePanelsLayout() {
  const upgrades = $("section-upgrades");
  const traits = $("section-traits");
  const modalBody = $("mobilePanelsBody");
  const hud = document.querySelector(".mobileHud");

  if (!upgrades || !traits || !modalBody) return;

  const wantsMobile = window.matchMedia("(max-width: 900px)").matches;

  if (wantsMobile && !mobileUiActive) {
    upgradesMount = { parent: upgrades.parentElement, next: upgrades.nextSibling };
    traitsMount = { parent: traits.parentElement, next: traits.nextSibling };

    modalBody.appendChild(upgrades);
    modalBody.appendChild(traits);

    hud?.setAttribute("aria-hidden", "false");
    mobileUiActive = true;
    closeMobilePanels(true);
    safeInvalidateMapSize();
    return;
  }

  if (!wantsMobile && mobileUiActive) {
    if (upgradesMount?.parent) upgradesMount.parent.insertBefore(upgrades, upgradesMount.next ?? null);
    if (traitsMount?.parent) traitsMount.parent.insertBefore(traits, traitsMount.next ?? null);

    hud?.setAttribute("aria-hidden", "true");
    mobileUiActive = false;
    closeMobilePanels(true);
    safeInvalidateMapSize();
  }
}
