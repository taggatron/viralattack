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
    },
    {
      id: "air_2",
      name: "Airborne II",
      desc: "+More infectivity",
      cost: 10,
      requires: ["air_1"],
      effects: { infectivity: +0.09 },
    },
    {
      id: "water_1",
      name: "Waterborne",
      desc: "+Infectivity (spreads through water supply)",
      cost: 8,
      effects: { infectivity: +0.07 },
    },
    {
      id: "animal_1",
      name: "Animal",
      desc: "+Infectivity (zoonotic vectors)",
      cost: 7,
      effects: { infectivity: +0.05 },
    },
    {
      id: "drug_resist",
      name: "Drug Resistance",
      desc: "-Cure progress (harder to eliminate)",
      cost: 12,
      effects: { cureSlow: 0.12 },
    },
  ],
  symptoms: [
    {
      id: "cough",
      name: "Coughing",
      desc: "+Infectivity, +Severity",
      cost: 5,
      effects: { infectivity: +0.03, severity: +0.05 },
    },
    {
      id: "fever",
      name: "Fever",
      desc: "+Severity",
      cost: 6,
      effects: { severity: +0.07 },
    },
    {
      id: "pneumonia",
      name: "Pneumonia",
      desc: "+Severity, +Lethality",
      cost: 10,
      requires: ["cough"],
      effects: { severity: +0.09, lethality: +0.06 },
    },
    {
      id: "organ_failure",
      name: "Organ Failure",
      desc: "+High lethality (but slows spread)",
      cost: 16,
      requires: ["pneumonia"],
      effects: { lethality: +0.12, infectivity: -0.05, severity: +0.06 },
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

  infectivity: 0,
  severity: 0,
  lethality: 0,
  cureSlow: 0,

  // Simulation totals
  population: 8_100_000_000,
  infected: 0,
  dead: 0,
  cured: 0,

  cureProgress: 0, // 0..1
};

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

  state.start = null;
  state.startCountry = null;
  state.startCountryCode = null;
  state.mp = 0;
  state.purchased = new Set();

  state.infected = 0;
  state.dead = 0;
  state.cured = 0;
  state.cureProgress = 0;

  state.pathogen = document.querySelector('input[name="pathogen"]:checked')?.value ?? "bacteria";
  computeTraits();
  updateUI();

  startMarker?.remove();
  startMarker = null;

  unselectCountryLayer();

  for (const m of mutationMarkers) m.remove();
  mutationMarkers.clear();

  $("btn-start").disabled = true;
  $("start-coords").textContent = "Not set";
  $("start-hint").textContent = "Click the map to choose a starting location.";
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
  computeTraits();
  updateUI();
}

function renderUpgrades(category) {
  const list = $("upgrade-list");
  list.innerHTML = "";

  for (const u of UPGRADES[category]) {
    const card = document.createElement("div");
    card.className = "upgrade";

    const left = document.createElement("div");
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
      left.appendChild(name);
      left.appendChild(desc);
      left.appendChild(reqEl);
    } else {
      left.appendChild(name);
      left.appendChild(desc);
    }

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
  $("stat-infected").textContent = fmtInt(state.infected);
  $("stat-dead").textContent = fmtInt(state.dead);
  $("stat-cured").textContent = fmtInt(state.cured);
  updateBars();

  updateSelectedCountryShade();

  renderUpgrades(activeTab);
}

// --- Map setup ---
let map;
let startMarker = null;
const mutationMarkers = new Set();

let countriesLayer = null;
let selectedCountryLeafletLayer = null;
const countriesByIso2 = new Map();

function defaultCountryStyle() {
  return {
    color: "#000000",
    weight: 0,
    fillOpacity: 0,
  };
}

function selectedCountryStyle(intensity01) {
  const t = clamp01(intensity01);
  return {
    color: "#ef4444",
    weight: 1,
    opacity: 0.8,
    fillColor: "#ef4444",
    fillOpacity: 0.08 + t * 0.62,
  };
}

function unselectCountryLayer() {
  if (selectedCountryLeafletLayer) {
    selectedCountryLeafletLayer.setStyle(defaultCountryStyle());
  }
  selectedCountryLeafletLayer = null;
}

function updateSelectedCountryShade() {
  if (!selectedCountryLeafletLayer) return;
  // Log scale: ~0 at tiny counts, ~1 at 100M infected
  const intensity = clamp01(Math.log10(1 + state.infected) / 8);
  selectedCountryLeafletLayer.setStyle(selectedCountryStyle(intensity));
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
        countriesByIso2.set(iso2.toUpperCase(), layer);
      }
    },
  }).addTo(map);
}

function selectCountryByIso2(iso2) {
  if (!iso2) return;
  const layer = countriesByIso2.get(String(iso2).toUpperCase());
  if (!layer) return;

  unselectCountryLayer();
  selectedCountryLeafletLayer = layer;
  updateSelectedCountryShade();
}

function spawnMutationPoint() {
  if (!map || !state.running) return;

  // Keep them within typical world view bounds.
  const lat = (Math.random() * 140) - 70; // -70..70
  const lng = (Math.random() * 360) - 180; // -180..180

  const marker = L.circleMarker([lat, lng], {
    radius: 10,
    color: "#8b5cf6",
    weight: 2,
    fillColor: "#8b5cf6",
    fillOpacity: 0.35,
  }).addTo(map);

  marker.bindTooltip("Mutation point (+1 MP)", { direction: "top" });

  marker.on("click", () => {
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

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 6,
    minZoom: 2,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

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
        selectCountryByIso2(countryCode);
      }
    } catch (err) {
      console.warn("Reverse geocode failed:", err);
      $("start-coords").textContent = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
    }
  });
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

  $("btn-start").disabled = true;
  $("start-hint").textContent = "Simulation running. Collect mutation points on the map.";

  // Every second: advance the toy model
  state.tickHandle = window.setInterval(() => {
    stepSimulation(1.0);
  }, 1000);

  // Mutation points appear periodically
  state.pointHandle = window.setInterval(() => {
    spawnMutationPoint();
  }, 2200);

  updateUI();
}

function stepSimulation(dtSeconds) {
  computeTraits();

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
}

function boot() {
  initMap();
  initUI();
  resetGame();
  setTab("transmission");
}

boot();
