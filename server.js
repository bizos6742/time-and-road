import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "notebook.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4173);
const AMAP_WEB_SERVICE_KEY = process.env.AMAP_WEB_SERVICE_KEY || "";
const AMAP_JS_API_KEY = process.env.AMAP_JS_API_KEY || "";
const AMAP_SECURITY_JS_CODE = process.env.AMAP_SECURITY_JS_CODE || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "time-and-road-admin";
const ADMIN_COOKIE = "time_and_road_admin";
const AMAP_REQUEST_INTERVAL_MS = 500;
let amapScriptCache = "";
let amapScriptPromise = null;
let amapWebQueue = Promise.resolve();
let lastAmapWebRequestAt = 0;
let amapRequestSeq = 0;
const amapWebStats = {
  total: 0,
  byType: {},
  bySource: {},
  recent: []
};
const inFlightGeocodes = new Map();
const inFlightDirections = new Map();
const inFlightMapData = new Map();
const inFlightDistance = new Map();
const adminSessions = new Set();
const UNCATEGORIZED_FOLDER_ID = "folder_uncategorized";

const emptyData = {
  settings: { volcanoKey: "" },
  folders: [{ id: UNCATEGORIZED_FOLDER_ID, name: "未分类", sortOrder: 0 }],
  geocodeCache: {},
  distanceCache: {},
  routes: []
};

function id(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function requestId() {
  return id("req");
}

async function ensureData() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    await writeFile(DATA_FILE, JSON.stringify(emptyData, null, 2));
  }
}

async function loadData() {
  await ensureData();
  const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
  if (data.settings?.amapKey) delete data.settings.amapKey;
  normalizeData(data);
  return data;
}

async function saveData(data) {
  await ensureData();
  normalizeData(data);
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

function sendWithHeaders(res, status, body, headers = {}, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": contentType, ...headers });
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

function publicData(data) {
  return {
    ...data,
    settings: { volcanoKey: data.settings?.volcanoKey || "" },
    folders: data.folders || [],
    routes: data.routes || []
  };
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [part, ""];
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}

function isAdmin(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  return Boolean(token && adminSessions.has(token));
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { error: "Unauthorized" });
  return false;
}

function createAdminSession(res) {
  const token = randomBytes(32).toString("hex");
  adminSessions.add(token);
  return {
    token,
    headers: {
      "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
    }
  };
}

function clearAdminSession(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (token) adminSessions.delete(token);
  return {
    "Set-Cookie": `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  };
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function normalizeCities(cities = []) {
  return cities
    .map((city, index) => ({
      ...city,
      order: Number.isFinite(Number(city.order)) ? Number(city.order) : index + 1,
      _fallbackOrder: index + 1,
      enabled: city.enabled !== false
    }))
    .sort((a, b) => (a.order - b.order) || (a._fallbackOrder - b._fallbackOrder))
    .map(({ _fallbackOrder, ...city }, index) => ({ ...city, order: index + 1 }));
}

function normalizeData(data) {
  data.folders = normalizeFolders(data.folders || []);
  data.geocodeCache = data.geocodeCache || {};
  data.distanceCache = data.distanceCache || {};
  const validFolderIds = new Set(data.folders.map((folder) => folder.id));
  for (const route of data.routes || []) {
    if (!route.folderId || !validFolderIds.has(route.folderId)) route.folderId = UNCATEGORIZED_FOLDER_ID;
    route.cities = normalizeCities(route.cities || []);
    for (const city of route.cities) {
      city.attractions = (city.attractions || [])
        .filter((item) => String(item?.name || "").trim().length > 0)
        .map((item) => ({
          id: item.id || id("attraction"),
          name: item.name || "",
          address: item.address || "",
          worthDetour: Boolean(item.worthDetour),
          notes: item.notes || item.note || ""
        }));
      city.restaurants = (city.restaurants || [])
        .filter((item) => String(item?.name || "").trim().length > 0)
        .map((item) => {
          const noteParts = [item.note, item.notes, item.recommendedDishes, item.costNote]
            .map((part) => String(part || "").trim())
            .filter(Boolean);
          return {
            id: item.id || id("restaurant"),
            name: item.name || "",
            address: item.address || "",
            worthVisit: Boolean(item.worthVisit),
            notes: [...new Set(noteParts)].join("\n")
          };
        });
      city.hotels = (city.hotels || [])
        .filter((item) => String(item?.name || "").trim().length > 0)
        .map((item) => {
          const noteParts = [item.note, item.notes, item.reason, item.priceNote]
            .map((part) => String(part || "").trim())
            .filter(Boolean);
          return {
            id: item.id || id("hotel"),
            name: item.name || "",
            address: item.address || "",
            notes: [...new Set(noteParts)].join("\n")
          };
        });
      delete city.links;
      delete city.reminders;
    }
    if (route.start === undefined || route.start === null) route.start = "";
    if (route.end === undefined || route.end === null) route.end = "";
    for (const mapCity of route.map?.cities || []) {
      if (!data.geocodeCache[mapCity.name] && hasValidCoordinate(mapCity)) {
        data.geocodeCache[mapCity.name] = {
          lng: Number(mapCity.lng),
          lat: Number(mapCity.lat),
          location: `${Number(mapCity.lng)},${Number(mapCity.lat)}`,
          updatedAt: route.map.updated_at || route.updatedAt || new Date().toISOString()
        };
      }
    }
  }
}

function normalizeFolders(folders = []) {
  const seen = new Set();
  const normalized = folders
    .filter((folder) => folder && String(folder.name || "").trim())
    .map((folder, index) => ({
      id: folder.id || id("folder"),
      name: String(folder.name || "").trim(),
      sortOrder: Number.isFinite(Number(folder.sortOrder)) ? Number(folder.sortOrder) : index + 1,
      _fallbackOrder: index + 1
    }))
    .filter((folder) => {
      if (seen.has(folder.id)) return false;
      seen.add(folder.id);
      return true;
    });
  if (!normalized.some((folder) => folder.id === UNCATEGORIZED_FOLDER_ID)) {
    normalized.unshift({ id: UNCATEGORIZED_FOLDER_ID, name: "未分类", sortOrder: 0, _fallbackOrder: 0 });
  }
  return normalized
    .map((folder) => folder.id === UNCATEGORIZED_FOLDER_ID ? { ...folder, name: "未分类", sortOrder: 0 } : folder)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || (a._fallbackOrder - b._fallbackOrder))
    .map(({ _fallbackOrder, ...folder }, index) => ({
      ...folder,
      sortOrder: folder.id === UNCATEGORIZED_FOLDER_ID ? 0 : index + 1
    }));
}

function invalidateRouteMap(route) {
  route.map = {
    cities: route.map?.cities || [],
    segments: route.map?.segments || [],
    total_distance_km: route.map?.total_distance_km ?? null,
    updated_at: route.map?.updated_at || null,
    error: "",
    cities_signature: route.map?.cities_signature || null,
    distance_signature: null
  };
}

function routeCitiesSignature(route) {
  return normalizeCities(route.cities || [])
    .map((city) => `${city.id}:${city.name}:${city.order}:${city.enabled !== false}`)
    .join("|");
}

function enabledSegmentPairs(route) {
  const enabledCities = normalizeCities(route.cities || []).filter((city) => city.enabled !== false && city.name);
  return enabledCities.slice(0, -1).map((city, index) => [city.name, enabledCities[index + 1].name]);
}

function hasCompleteMapCities(route) {
  const mapCities = route.map?.cities || [];
  return normalizeCities(route.cities || [])
    .filter((city) => city.name)
    .every((city) => {
      const mapCity = mapCities.find((entry) => entry.id === city.id || entry.name === city.name);
      return hasValidCoordinate(mapCity);
    });
}

function hasCompleteDistanceSegments(route) {
  const segments = route.map?.segments || [];
  const pairs = enabledSegmentPairs(route);
  if (segments.length !== pairs.length) return false;
  return pairs.every(([from, to]) => {
    const segment = segments.find((entry) => entry.from === from && entry.to === to);
    return segment && Number.isFinite(Number(segment.distance_km ?? segment.distanceKm));
  });
}

function preserveRouteFields(route) {
  return {
    name: route.name,
    start: route.start,
    end: route.end,
    totalDays: route.totalDays,
    bestSeason: route.bestSeason,
    tags: route.tags,
    folderId: route.folderId,
    notes: route.notes,
    sourceText: route.sourceText
  };
}

function restoreRouteFields(route, fields) {
  Object.assign(route, fields);
}

function segmentCacheKey(from, to) {
  return `${from}|||${to}`;
}

function isRateLimitError(error) {
  return /CUQPS_HAS_EXCEEDED_THE_LIMIT|10021|请求过快|限流/.test(error?.message || "");
}

function rateLimitMessage() {
  return "请求过快，请稍后再试";
}

function hasValidCoordinate(value) {
  return Number.isFinite(Number(value?.lng)) && Number.isFinite(Number(value?.lat));
}

function newCity(name, order = 0) {
  return {
    id: id("city"),
    name,
    order,
    enabled: true,
    days: "",
    reason: "",
    keywords: "",
    attractions: [],
    hotels: [],
    restaurants: [],
    notes: ""
  };
}

function parseRouteText(text) {
  const raw = String(text || "").trim();
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const name = lines[0] || "未命名路线";
  const arrowLine = lines.find((line) => /→|->|=>/.test(line)) || "";
  const cityNames = arrowLine
    ? arrowLine.split(/→|->|=>/).map((part) => part.trim()).filter(Boolean)
    : [];
  const notesStart = lines.findIndex((line) => /^备注[:：]?/.test(line));
  const notes = notesStart >= 0
    ? lines.slice(notesStart).join("\n").replace(/^备注[:：]?\s*/, "")
    : lines.slice(1).filter((line) => line !== arrowLine).join("\n");
  const seasonMatch = raw.match(/(\d{1,2}\s*月|春天|夏天|秋天|冬天|春季|夏季|秋季|冬季|国庆|五一|暑假|寒假)[^。\n，,]*/);
  const tags = [];
  if (/边境|331|国道/.test(raw)) tags.push("边境线");
  if (/自驾|开车|绕路|路线/.test(raw)) tags.push("自驾");
  if (/江边|海边|湖边/.test(raw)) tags.push("水边");
  if (/古城|小城|老街/.test(raw)) tags.push("小城");

  return {
    id: id("route"),
    name,
    start: cityNames[0] || "",
    end: cityNames.at(-1) || "",
    totalDays: "",
    bestSeason: seasonMatch?.[0]?.trim() || "",
    tags,
    notes,
    sourceText: raw,
    cities: cityNames.map((cityName, index) => newCity(cityName, index)),
    map: { segments: [], totalDistanceKm: null, updatedAt: null, error: "" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function httpsJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`高德接口请求超时：${url.replace(/key=[^&]+/, "key=***")}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function amapContextLabel(context = {}) {
  return [
    context.source || "unknown",
    context.routeId ? `route=${context.routeId}` : "",
    context.requestId ? `request=${context.requestId}` : "",
    context.type || "",
    context.target || ""
  ].filter(Boolean).join(" ");
}

function recordAmapRequest(context, queuedAt, startedAt) {
  const type = context.type || "unknown";
  const source = context.source || "unknown";
  amapWebStats.total += 1;
  amapWebStats.byType[type] = (amapWebStats.byType[type] || 0) + 1;
  amapWebStats.bySource[source] = (amapWebStats.bySource[source] || 0) + 1;
  const entry = {
    seq: amapRequestSeq,
    at: new Date(startedAt).toISOString(),
    type,
    source,
    routeId: context.routeId || "",
    requestId: context.requestId || "",
    target: context.target || "",
    queuedMs: startedAt - queuedAt
  };
  amapWebStats.recent.unshift(entry);
  amapWebStats.recent = amapWebStats.recent.slice(0, 80);
  return entry;
}

function amapWebJson(url, context = {}) {
  const queuedAt = Date.now();
  const run = amapWebQueue.then(async () => {
    const elapsed = Date.now() - lastAmapWebRequestAt;
    if (elapsed < AMAP_REQUEST_INTERVAL_MS) await sleep(AMAP_REQUEST_INTERVAL_MS - elapsed);
    const startedAt = Date.now();
    lastAmapWebRequestAt = Date.now();
    amapRequestSeq += 1;
    const entry = recordAmapRequest(context, queuedAt, startedAt);
    console.log(`[amap-web] #${entry.seq} start ${amapContextLabel(context)} queuedMs=${entry.queuedMs} total=${amapWebStats.total}`);
    try {
      const data = await httpsJson(url);
      console.log(`[amap-web] #${entry.seq} done status=${data.status || ""} info=${data.info || ""} infocode=${data.infocode || ""}`);
      return data;
    } catch (error) {
      console.log(`[amap-web] #${entry.seq} failed error=${error.message}`);
      throw error;
    }
  });
  amapWebQueue = run.catch(() => {});
  return run;
}

async function geocodeCity(city, key, context = {}) {
  const inflightKey = city;
  if (inFlightGeocodes.has(inflightKey)) {
    console.log(`[amap-dedupe] join geocode city=${city} ${amapContextLabel(context)}`);
    return inFlightGeocodes.get(inflightKey);
  }
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(city)}`;
  const promise = (async () => {
    const data = await amapWebJson(url, { ...context, type: "geocode", target: city });
    if (data.status && data.status !== "1") {
      throw new Error(`城市地理编码失败：${city}，${data.info || "未知错误"}（${data.infocode || "无错误码"}）`);
    }
    const location = data.geocodes?.[0]?.location;
    if (!location) throw new Error(`没有找到城市坐标：${city}`);
    const [lng, lat] = location.split(",").map(Number);
    return { location, lng, lat };
  })();
  inFlightGeocodes.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inFlightGeocodes.delete(inflightKey);
  }
}

async function drivingDistance(from, to, key, geocodes = null, context = {}) {
  const origin = geocodes?.get(from);
  const destination = geocodes?.get(to);
  if (!origin || !destination) throw new Error(`缺少城市坐标：${from} 到 ${to}`);
  const inflightKey = segmentCacheKey(from, to);
  if (inFlightDirections.has(inflightKey)) {
    console.log(`[amap-dedupe] join direction ${from} -> ${to} ${amapContextLabel(context)}`);
    return inFlightDirections.get(inflightKey);
  }
  const url = `https://restapi.amap.com/v3/direction/driving?key=${encodeURIComponent(key)}&origin=${origin.location}&destination=${destination.location}`;
  const promise = (async () => {
    const data = await amapWebJson(url, { ...context, type: "direction", target: `${from} -> ${to}` });
    if (data.status && data.status !== "1") {
      throw new Error(`direction 接口失败：${from} 到 ${to}，${data.info || "未知错误"}（${data.infocode || "无错误码"}）`);
    }
    const path = data.route?.paths?.[0];
    if (!path?.distance) throw new Error(`没有算出距离：${from} 到 ${to}`);
    const polyline = (path.steps || [])
      .flatMap((step) => String(step.polyline || "").split(";"))
      .filter(Boolean)
      .map((point) => point.split(",").map(Number))
      .filter((point) => point.length === 2 && point.every(Number.isFinite));

    return {
      from,
      to,
      distance_km: Math.round(Number(path.distance) / 100) / 10,
      duration_hours: path.duration ? Math.round(Number(path.duration) / 360) / 10 : null,
      navigation_url: `https://uri.amap.com/navigation?from=${encodeURIComponent(`${origin.location},${from}`)}&to=${encodeURIComponent(`${destination.location},${to}`)}&mode=car&policy=1`,
      path: polyline,
      updatedAt: new Date().toISOString()
    };
  })();
  inFlightDirections.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inFlightDirections.delete(inflightKey);
  }
}

function cachedGeocode(cityName, data, cachedCities = []) {
  const cache = data.geocodeCache?.[cityName];
  if (hasValidCoordinate(cache)) {
    return {
      location: cache.location || `${Number(cache.lng)},${Number(cache.lat)}`,
      lng: Number(cache.lng),
      lat: Number(cache.lat),
      cached: true
    };
  }
  const cached = cachedCities.find((entry) => entry.name === cityName && hasValidCoordinate(entry));
  if (cached) {
    return {
      location: `${Number(cached.lng)},${Number(cached.lat)}`,
      lng: Number(cached.lng),
      lat: Number(cached.lat),
      cached: true
    };
  }
  return null;
}

async function geocodeRouteCities(orderedCities, key, data, cachedCities = [], context = {}) {
  const geocodes = new Map();
  const failures = {};
  let rateLimited = false;
  data.geocodeCache = data.geocodeCache || {};
  const uniqueNames = [...new Set(orderedCities.map((city) => city.name).filter(Boolean))];
  for (const cityName of uniqueNames) {
    const cached = cachedGeocode(cityName, data, cachedCities);
    if (cached) geocodes.set(cityName, cached);
  }
  const missingNames = uniqueNames.filter((cityName) => !geocodes.has(cityName));
  for (const cityName of missingNames) {
    if (rateLimited) {
      failures[cityName] = rateLimitMessage();
      continue;
    }
    const start = Date.now();
    try {
      const geo = await geocodeCity(cityName, key, context);
      geocodes.set(cityName, geo);
      data.geocodeCache[cityName] = {
        lng: geo.lng,
        lat: geo.lat,
        location: geo.location,
        updatedAt: new Date().toISOString()
      };
      await saveData(data);
      console.log(`[geocode] saved cache ${cityName} ms=${Date.now() - start}`);
    } catch (error) {
      const message = isRateLimitError(error) ? rateLimitMessage() : error.message;
      failures[cityName] = message;
      console.log(`[geocode] failed ${cityName} ms=${Date.now() - start} error=${error.message}`);
      if (isRateLimitError(error)) rateLimited = true;
    }
  }
  return { geocodes, failures, rateLimited };
}

function mapCitiesFromGeocodes(orderedCities, geocodes) {
  return orderedCities.map((city) => {
    const geo = geocodes.get(city.name);
    return {
      id: city.id,
      name: city.name,
      order: city.order,
      enabled: city.enabled !== false,
      lng: geo?.lng,
      lat: geo?.lat,
      geocode_error: geo ? "" : "坐标待计算",
      days: city.days || "",
      keywords: city.keywords || "",
      reason: city.reason || "",
      notes: city.notes || "",
      counts: {
        hotels: city.hotels?.length || 0,
        restaurants: city.restaurants?.length || 0,
        attractions: city.attractions?.length || 0
      }
    };
  });
}

async function buildRouteMarkersWithCache(route, key, data, context = {}) {
  const orderedCities = normalizeCities(route.cities || []);
  const cachedCities = route.map?.cities_signature === routeCitiesSignature(route) ? route.map?.cities || [] : [];
  const { geocodes, failures, rateLimited } = await geocodeRouteCities(orderedCities, key, data, cachedCities, context);
  const cities = mapCitiesFromGeocodes(orderedCities, geocodes);
  for (const city of cities) {
    if (failures[city.name]) city.geocode_error = failures[city.name];
  }
  const error = rateLimited
    ? "请求过快，请稍后再试。已显示成功加载的城市。"
    : Object.keys(failures).length ? "部分城市坐标暂时没有加载成功，已显示成功加载的城市。" : "";
  return {
    cities,
    segments: displaySegmentsForCities(orderedCities, cities, route.map?.segments || []),
    total_distance_km: route.map?.total_distance_km ?? null,
    cities_signature: routeCitiesSignature(route),
    distance_signature: route.map?.distance_signature || null,
    updated_at: new Date().toISOString(),
    error
  };
}

function displaySegmentsForCities(orderedCities, mapCities, existingSegments = []) {
  const enabledCities = orderedCities.filter((city) => city.enabled !== false && city.name);
  return enabledCities.slice(0, -1).map((city, index) => {
    const next = enabledCities[index + 1];
    const existing = existingSegments.find((segment) => segment.from === city.name && segment.to === next.name) || {};
    if (existing.path?.length) return existing;
    const from = mapCities.find((entry) => entry.id === city.id || entry.name === city.name);
    const to = mapCities.find((entry) => entry.id === next.id || entry.name === next.name);
    const path = Number.isFinite(from?.lng) && Number.isFinite(from?.lat) && Number.isFinite(to?.lng) && Number.isFinite(to?.lat)
      ? [[from.lng, from.lat], [to.lng, to.lat]]
      : [];
    return {
      ...existing,
      from: city.name,
      to: next.name,
      path
    };
  });
}

function simplifiedSegmentPath(from, to, geocodes) {
  const origin = geocodes.get(from);
  const destination = geocodes.get(to);
  if (!origin || !destination) return [];
  return [[origin.lng, origin.lat], [destination.lng, destination.lat]];
}

function segmentFromCache(from, to, cached, geocodes) {
  const distance = Number(cached.distance_km);
  return {
    from,
    to,
    distance_km: Number.isFinite(distance) ? distance : null,
    duration_hours: cached.duration_hours ?? null,
    navigation_url: cached.navigation_url || "",
    path: cached.path?.length ? cached.path : simplifiedSegmentPath(from, to, geocodes),
    updatedAt: cached.updatedAt || null,
    cached: true
  };
}

function failedSegment(from, to, error, geocodes) {
  const message = isRateLimitError(error)
    ? rateLimitMessage()
    : error.message;
  return {
    from,
    to,
    distance_km: null,
    duration_hours: null,
    navigation_url: "",
    path: simplifiedSegmentPath(from, to, geocodes),
    error: message,
    failed: true,
    updatedAt: new Date().toISOString()
  };
}

async function buildRouteDistance(route, key, data, context = {}) {
  const orderedCities = normalizeCities(route.cities || []);
  const enabledCities = orderedCities.filter((city) => city.enabled !== false && city.name);
  const cachedCities = route.map?.cities_signature === routeCitiesSignature(route) ? route.map?.cities || [] : [];
  data.distanceCache = data.distanceCache || {};
  const { geocodes, failures: geocodeFailures, rateLimited: geocodeRateLimited } = await geocodeRouteCities(enabledCities, key, data, cachedCities, context);
  const segmentPairs = [];
  for (let i = 0; i < enabledCities.length - 1; i += 1) {
    segmentPairs.push([enabledCities[i].name, enabledCities[i + 1].name]);
  }
  const segments = [];
  let hasFailures = false;
  let rateLimited = geocodeRateLimited;
  for (const [from, to] of segmentPairs) {
    const cacheKey = segmentCacheKey(from, to);
    const cached = data.distanceCache[cacheKey];
    if (Number.isFinite(Number(cached?.distance_km))) {
      console.log(`[distance] segment cache hit ${from} -> ${to}`);
      segments.push(segmentFromCache(from, to, cached, geocodes));
      continue;
    }
    if (rateLimited) {
      hasFailures = true;
      segments.push(failedSegment(from, to, new Error(rateLimitMessage()), geocodes));
      continue;
    }
    if (!geocodes.has(from) || !geocodes.has(to)) {
      hasFailures = true;
      const reason = geocodeFailures[from] || geocodeFailures[to] || `缺少城市坐标：${from} 到 ${to}`;
      segments.push(failedSegment(from, to, new Error(reason), geocodes));
      continue;
    }
    const start = Date.now();
    console.log(`[distance] segment start ${from} -> ${to}`);
    try {
      const segment = await drivingDistance(from, to, key, geocodes, context);
      data.distanceCache[cacheKey] = {
        from,
        to,
        distance_km: segment.distance_km,
        duration_hours: segment.duration_hours,
        navigation_url: segment.navigation_url,
        path: segment.path || [],
        updatedAt: segment.updatedAt || new Date().toISOString()
      };
      await saveData(data);
      console.log(`[distance] segment done ${from} -> ${to} ms=${Date.now() - start}`);
      segments.push(segment);
    } catch (error) {
      console.log(`[distance] segment failed ${from} -> ${to} ms=${Date.now() - start} error=${error.message}`);
      hasFailures = true;
      if (isRateLimitError(error)) rateLimited = true;
      segments.push(failedSegment(from, to, error, geocodes));
    }
  }
  const successfulDistances = segments
    .map((segment) => Number(segment.distance_km))
    .filter(Number.isFinite);
  const totalDistanceKm = successfulDistances.length
    ? Math.round(successfulDistances.reduce((sum, distance) => sum + distance, 0) * 10) / 10
    : null;
  return {
    cities: mapCitiesFromGeocodes(orderedCities, geocodes),
    segments,
    total_distance_km: totalDistanceKm,
    cities_signature: routeCitiesSignature(route),
    distance_signature: hasFailures ? null : routeCitiesSignature(route),
    updated_at: new Date().toISOString(),
    error: rateLimited ? "请求过快，请稍后再试。已保留已有计算结果。" : (hasFailures ? "部分路段暂时没有计算成功，已保留已有计算结果。" : "")
  };
}

function publicDistance(map) {
  return {
    total_distance_km: map?.total_distance_km ?? map?.totalDistanceKm ?? null,
    error: map?.error || "",
    segments: (map?.segments || []).map((segment) => ({
      from: segment.from,
      to: segment.to,
      distance_km: segment.distance_km ?? segment.distanceKm,
      duration_hours: segment.duration_hours ?? segment.durationHours,
      navigation_url: segment.navigation_url ?? segment.navigationUrl,
      error: segment.error || "",
      failed: Boolean(segment.failed),
      cached: Boolean(segment.cached),
      updatedAt: segment.updatedAt || null
    }))
  };
}

function sanitizeExtractText(value, { stripTrailing = false } = {}) {
  let text = String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\t/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i += 1) {
    text = text
      .replace(/^(?:[0-9#*]\uFE0F?\u20E3|[①②③④⑤⑥⑦⑧⑨⑩➊➋➌➍➎➏➐➑➒➓])\s*/u, "")
      .replace(/^[\s\-—*•·]+/, "")
      .replace(/^[0-9一二三四五六七八九十]+[、.．)]\s*/, "")
      .trim();
  }
  if (stripTrailing) text = text.replace(/[，,、：:；;。.\s]+$/g, "").trim();
  if (!text || /^[\p{P}\p{S}\s]+$/u.test(text)) return "";
  return text;
}

function sanitizeExtractItems(items = []) {
  const cleaned = [];
  const seen = new Set();
  for (const item of items) {
    const type = item.type;
    const base = {
      ...item,
      city: sanitizeExtractText(item.city),
      checked: item.checked !== false
    };
    if (["spot", "restaurant", "hotel"].includes(type)) {
      const name = sanitizeExtractText(item.name, { stripTrailing: true });
      if (!name) continue;
      const note = sanitizeExtractText(item.note);
      base.name = name;
      base.note = note === name ? "" : note;
    } else if (type === "city_note") {
      const cityNote = sanitizeExtractText(item.cityNote || item.content);
      if (!cityNote) continue;
      base.cityNote = cityNote;
      delete base.content;
    } else {
      continue;
    }
    const key = `${type}:${base.name || base.cityNote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(base);
  }
  const spotLimit = 10;
  let spotCount = 0;
  return cleaned.filter((item) => {
    if (item.type !== "spot") return true;
    spotCount += 1;
    return spotCount <= spotLimit;
  });
}

function smartExtract(text, route) {
  const source = String(text || "");
  const cityNames = normalizeCities(route?.cities || []).map((city) => city.name).filter(Boolean);
  const city = cityNames.find((name) => source.includes(name))
    || source.match(/([\u4e00-\u9fa5]{2,6})(古城|老城|城区|市|县|镇)/)?.[1]
    || source.match(/^([\u4e00-\u9fa5]{2,6})[:：]/)?.[1]
    || "";
  const cityPrefix = city ? city.replace(/市$/, "") : "";
  const withoutLinks = source.replace(/https?:\/\/[^\s，。；;]+/g, "");
  const items = [];
  const seen = new Set();
  const cityNotes = [];
  const addItem = (type, fields) => {
    const normalizedFields = { ...fields };
    if (normalizedFields.note && normalizedFields.name && normalizedFields.note.trim() === normalizedFields.name.trim()) {
      normalizedFields.note = "";
    }
    const key = `${type}:${normalizedFields.name || normalizedFields.cityNote || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ type, city, checked: true, ...normalizedFields });
  };
  const cleanLine = (value) => String(value || "")
    .replace(/^[\s\-—*•·]+/, "")
    .replace(/^[0-9一二三四五六七八九十]+[、.．)]\s*/, "")
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟]+\s*/, "")
    .trim();
  const cleanNote = (value) => String(value || "").replace(/^.*?[:：]/, "").trim();
  const lines = withoutLinks
    .split(/\r?\n|。/)
    .map(cleanLine)
    .filter(Boolean);
  const descriptorOnly = /^(老街巷|青石板路|古建筑|亭台楼阁|小桥流水|登高远眺|主街|老槐树|城南小镇)$/;
  const spotNamePattern = /^([\u4e00-\u9fa5A-Za-z0-9]{2,18}(古城|古街|公园|博物馆|景区|石坊|王府|园|寺|山|湖|沟|桥|楼|阁|坊|馆))$/;
  const knownSpotPattern = /^(偶园|衡王府石坊|昭德古街|青州古城)$/;
  const foodNamePattern = /^([\u4e00-\u9fa5A-Za-z0-9]{2,18}(糕点|全羊|火烧|糗糕|烧饼|包子|面|粉|馄饨|豆腐|烧烤|火锅|咖啡|餐厅|饭店|小吃))$/;
  const knownFoodPattern = /^(糗糕|隆盛糕点|庙子全羊|杠子头火烧)$/;
  const foodSectionPattern = /^(美食推荐|必吃|餐厅|小吃|早餐|夜宵)[:：]?$/;
  const isSpotName = (value) => {
    const name = cleanLine(value).replace(/[，,、：:].*$/, "");
    return Boolean(name && !descriptorOnly.test(name) && (knownSpotPattern.test(name) || spotNamePattern.test(name)));
  };
  const isFoodName = (value) => {
    const name = cleanLine(value).replace(/[，,、：:].*$/, "");
    return Boolean(name && (knownFoodPattern.test(name) || foodNamePattern.test(name)));
  };
  const parseNameNoteLine = (line) => {
    const match = line.match(/^([^，,：:]{2,18})[，,：:]\s*(.+)$/);
    if (!match) return null;
    const name = cleanLine(match[1]);
    const note = cleanLine(match[2]);
    if (isSpotName(name)) return { type: "spot", name, note };
    if (isFoodName(name)) return { type: "restaurant", name, note };
    return null;
  };
  const parseInlineSpotLine = (line) => {
    const suffixes = ["古城", "古街", "公园", "博物馆", "景区", "石坊", "王府", "园", "寺", "山", "湖", "沟", "桥", "楼", "阁", "坊", "馆"];
    const candidates = [];
    for (const suffix of suffixes) {
      let start = 0;
      while (start < line.length) {
        const index = line.indexOf(suffix, start);
        if (index < 0) break;
        const end = index + suffix.length;
        const name = cleanLine(line.slice(0, end));
        const note = cleanLine(line.slice(end));
        if (note && isSpotName(name)) candidates.push({ name, note });
        start = end;
      }
    }
    return candidates.sort((a, b) => a.name.length - b.name.length)[0] || null;
  };
  let pendingSpot = null;
  let inFoodSection = false;
  const flushPendingSpot = () => {
    if (!pendingSpot) return;
    addItem("spot", pendingSpot);
    pendingSpot = null;
  };
  for (const line of lines) {
    if (foodSectionPattern.test(line)) {
      flushPendingSpot();
      inFoodSection = true;
      continue;
    }
    const nameNote = parseNameNoteLine(line);
    if (nameNote) {
      flushPendingSpot();
      addItem(nameNote.type, { name: nameNote.name, note: nameNote.note });
      inFoodSection = false;
      continue;
    }
    const inlineSpot = parseInlineSpotLine(line);
    if (inlineSpot) {
      flushPendingSpot();
      addItem("spot", { name: inlineSpot.name, note: inlineSpot.note });
      inFoodSection = false;
      continue;
    }
    if (inFoodSection) {
      const foodNames = line.split(/[，,、\s]+/).map(cleanLine).filter(Boolean);
      for (const name of foodNames) {
        if (isFoodName(name) || foodNames.length > 1) addItem("restaurant", { name, note: "" });
      }
      continue;
    }
    if (isFoodName(line)) {
      flushPendingSpot();
      addItem("restaurant", { name: line.replace(/[，,、：:].*$/, ""), note: "" });
      continue;
    }
    if (isSpotName(line)) {
      flushPendingSpot();
      pendingSpot = { name: line.replace(/[，,、：:].*$/, ""), note: "" };
      inFoodSection = false;
      continue;
    }
    if (pendingSpot) {
      pendingSpot.note = pendingSpot.note ? `${pendingSpot.note} ${line}` : line;
      addItem("spot", pendingSpot);
      pendingSpot = null;
      continue;
    }
    if (/酒店|宾馆|民宿|客栈|住宿/.test(line)) {
      const name = line.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,18}(酒店|宾馆|民宿|客栈)/)?.[0] || "待补充住宿";
      addItem("hotel", { name, note: cleanNote(line) });
    } else {
      const note = cleanNote(line);
      if (note) cityNotes.push(note);
    }
  }
  flushPendingSpot();
  if (/主街|昭德古街|慢慢逛|晃悠|逛错/.test(source)) {
    cityNotes.push(`${cityPrefix || city || "这座城市"}适合慢慢旅行，不要只在主街闲逛。`);
  }
  if (/一定要吃|美食|小吃|必吃/.test(source)) {
    cityNotes.push(`${cityPrefix || city || "这座城市"}值得体验当地美食。`);
  }
  const cityNote = [...new Set(cityNotes.map((note) => sanitizeExtractText(note)).filter(Boolean))].join("\n");
  if (cityNote) addItem("city_note", { cityNote });
  return { city: sanitizeExtractText(city), items: sanitizeExtractItems(items) };
}

function applyExtracted(route, items, mode = "add") {
  route.cities = normalizeCities(route.cities || []);
  const beforeCleanSpots = (items || []).filter((item) => item.type === "spot").map((item) => ({ name: item.name, note: item.note }));
  const cleanedItems = sanitizeExtractItems(items || []);
  const afterCleanSpots = cleanedItems.filter((item) => item.type === "spot").map((item) => ({ name: item.name, note: item.note }));
  console.log("beforeClean.spots", JSON.stringify(beforeCleanSpots));
  console.log("afterClean.spots", JSON.stringify(afterCleanSpots));
  const firstCityName = cleanedItems.find((item) => item.city)?.city || "";
  if (firstCityName && !route.cities.some((entry) => entry.name === firstCityName)) {
    if (mode === "cancel") return { skipped: true };
    if (mode === "stash") {
      const stash = route.cities.find((entry) => entry.name === "待整理") || newCity("待整理", route.cities.length + 1);
      if (!route.cities.some((entry) => entry.id === stash.id)) route.cities.push(stash);
    } else {
      route.cities.push(newCity(firstCityName, route.cities.length + 1));
    }
  }
  for (const item of cleanedItems) {
    const targetCityName = mode === "stash" && !route.cities.some((entry) => entry.name === item.city) ? "待整理" : item.city;
    let city = route.cities.find((entry) => entry.name === targetCityName);
    if (!city) city = route.cities[0];
    if (!city) continue;

    if (item.type === "restaurant") {
      if (!String(item.name || "").trim()) continue;
      city.restaurants.push({ id: id("restaurant"), name: item.name || "", address: "", worthVisit: false, notes: item.note || "" });
    } else if (item.type === "hotel") {
      if (!String(item.name || "").trim()) continue;
      city.hotels.push({ id: id("hotel"), name: item.name || "", address: "", notes: item.note || "" });
    } else if (item.type === "spot") {
      if (!String(item.name || "").trim()) continue;
      city.attractions.push({ id: id("attraction"), name: item.name || "", address: "", worthDetour: false, notes: item.note || "" });
    } else if (item.type === "city_note") {
      city.notes = [city.notes, item.cityNote].filter(Boolean).join("\n");
    }
    delete city.links;
    delete city.reminders;
  }
  route.cities = normalizeCities(route.cities || []);
  route.updatedAt = new Date().toISOString();
  return { skipped: false };
}

async function serveStatic(req, res) {
  const routePath = decodeURIComponent(req.url.split("?")[0]);
  const requested = routePath === "/" || routePath === "/admin" ? "/index.html" : routePath;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };
    send(res, 200, file, types[ext] || "application/octet-stream");
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

async function serveAmapScript(res) {
  if (!AMAP_JS_API_KEY) return send(res, 404, "window.__AMAP_LOAD_ERROR__='missing_key';", "application/javascript; charset=utf-8");
  if (amapScriptCache) return send(res, 200, amapScriptCache, "application/javascript; charset=utf-8");
  if (amapScriptPromise) {
    try {
      const script = await amapScriptPromise;
      return send(res, 200, script, "application/javascript; charset=utf-8");
    } catch {
      return send(res, 502, "window.__AMAP_LOAD_ERROR__='load_failed';", "application/javascript; charset=utf-8");
    }
  }
  const scriptUrl = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_JS_API_KEY)}`;
  amapScriptPromise = new Promise((resolve, reject) => {
    https.get(scriptUrl, (amapRes) => {
      let raw = "";
      amapRes.on("data", (chunk) => raw += chunk);
      amapRes.on("end", () => {
        const securityConfig = AMAP_SECURITY_JS_CODE
          ? `window._AMapSecurityConfig={securityJsCode:${JSON.stringify(AMAP_SECURITY_JS_CODE)}};\n`
          : "";
        resolve(`${securityConfig}${raw}`);
      });
    }).on("error", reject);
  });
  try {
    amapScriptCache = await amapScriptPromise;
    send(res, 200, amapScriptCache, "application/javascript; charset=utf-8");
  } catch {
    amapScriptPromise = null;
    send(res, 502, "window.__AMAP_LOAD_ERROR__='load_failed';", "application/javascript; charset=utf-8");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/amap-js-api") return serveAmapScript(res);
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

    const data = await loadData();

    if (req.method === "GET" && url.pathname === "/api/admin/session") {
      return send(res, 200, { authenticated: isAdmin(req) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await readBody(req);
      if (String(body.password || "") !== ADMIN_PASSWORD) return send(res, 401, { error: "密码不正确" });
      const session = createAdminSession(res);
      return sendWithHeaders(res, 200, { authenticated: true }, session.headers);
    }

    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      return sendWithHeaders(res, 200, { authenticated: false }, clearAdminSession(req));
    }

    if (["POST", "PUT", "DELETE"].includes(req.method) && !url.pathname.startsWith("/api/admin/")) {
      if (!requireAdmin(req, res)) return;
    }

    if (req.method === "GET" && url.pathname === "/api/data") return send(res, 200, publicData(data));
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      data.settings = { ...data.settings, volcanoKey: body.volcanoKey || data.settings?.volcanoKey || "" };
      await saveData(data);
      return send(res, 200, publicData(data).settings);
    }

    if (req.method === "POST" && url.pathname === "/api/folders") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) return send(res, 400, { error: "文件夹名称不能为空" });
      const maxOrder = Math.max(0, ...(data.folders || []).map((folder) => Number(folder.sortOrder) || 0));
      const folder = { id: id("folder"), name, sortOrder: maxOrder + 1 };
      data.folders.push(folder);
      data.folders = normalizeFolders(data.folders);
      await saveData(data);
      return send(res, 201, publicData(data));
    }

    const folderMatch = url.pathname.match(/^\/api\/folders\/([^/]+)$/);
    if (folderMatch && req.method === "PUT") {
      const folder = data.folders.find((entry) => entry.id === folderMatch[1]);
      if (!folder) return send(res, 404, { error: "文件夹不存在" });
      const body = await readBody(req);
      if (folder.id !== UNCATEGORIZED_FOLDER_ID && body.name !== undefined) {
        const name = String(body.name || "").trim();
        if (!name) return send(res, 400, { error: "文件夹名称不能为空" });
        folder.name = name;
      }
      if (body.sortOrder !== undefined && folder.id !== UNCATEGORIZED_FOLDER_ID) folder.sortOrder = Number(body.sortOrder) || folder.sortOrder;
      data.folders = normalizeFolders(data.folders);
      await saveData(data);
      return send(res, 200, publicData(data));
    }

    if (folderMatch && req.method === "DELETE") {
      if (folderMatch[1] === UNCATEGORIZED_FOLDER_ID) return send(res, 400, { error: "未分类不能删除" });
      const before = data.folders.length;
      data.folders = data.folders.filter((folder) => folder.id !== folderMatch[1]);
      if (data.folders.length === before) return send(res, 404, { error: "文件夹不存在" });
      for (const route of data.routes || []) {
        if (route.folderId === folderMatch[1]) route.folderId = UNCATEGORIZED_FOLDER_ID;
      }
      data.folders = normalizeFolders(data.folders);
      await saveData(data);
      return send(res, 200, publicData(data));
    }

    const folderMoveMatch = url.pathname.match(/^\/api\/folders\/([^/]+)\/move$/);
    if (folderMoveMatch && req.method === "POST") {
      if (folderMoveMatch[1] === UNCATEGORIZED_FOLDER_ID) return send(res, 400, { error: "未分类不能移动" });
      data.folders = normalizeFolders(data.folders);
      const body = await readBody(req);
      const index = data.folders.findIndex((folder) => folder.id === folderMoveMatch[1]);
      const targetIndex = body.direction === "up" ? index - 1 : index + 1;
      if (index < 0) return send(res, 404, { error: "文件夹不存在" });
      if (targetIndex <= 0 || targetIndex >= data.folders.length) return send(res, 200, publicData(data));
      const currentOrder = data.folders[index].sortOrder;
      data.folders[index].sortOrder = data.folders[targetIndex].sortOrder;
      data.folders[targetIndex].sortOrder = currentOrder;
      data.folders = normalizeFolders(data.folders);
      await saveData(data);
      return send(res, 200, publicData(data));
    }

    if (req.method === "POST" && url.pathname === "/api/routes") {
      const body = await readBody(req);
      const route = parseRouteText(body.text);
      if (body.folderId && data.folders.some((folder) => folder.id === body.folderId)) route.folderId = body.folderId;
      data.routes.unshift(route);
      await saveData(data);
      return send(res, 201, route);
    }

    const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)$/);
    if (routeMatch && req.method === "DELETE") {
      const before = data.routes.length;
      data.routes = data.routes.filter((entry) => entry.id !== routeMatch[1]);
      if (data.routes.length === before) return send(res, 404, { error: "路线不存在" });
      await saveData(data);
      return send(res, 200, publicData(data));
    }

    if (routeMatch && req.method === "PUT") {
      const route = data.routes.find((entry) => entry.id === routeMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      Object.assign(route, await readBody(req), { updatedAt: new Date().toISOString() });
      route.cities = normalizeCities(route.cities || []);
      invalidateRouteMap(route);
      await saveData(data);
      return send(res, 200, route);
    }

    const citiesMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/cities$/);
    if (citiesMatch && req.method === "POST") {
      const route = data.routes.find((entry) => entry.id === citiesMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const preservedFields = preserveRouteFields(route);
      const body = await readBody(req);
      const name = String(body.cityName || body.name || "").trim();
      console.log("后端接收到 addCity payload：");
      console.log("cityName", name);
      console.log("insertAfterCityId", body.insertAfterCityId);
      if (!name) return send(res, 400, { error: "城市名不能为空" });

      route.cities = normalizeCities(route.cities || []);
      const rawPosition = String(body.insertAfterCityId || body.insertPosition || "__end__");
      const isEnd = ["__end__", "last"].includes(rawPosition);
      if (!isEnd) {
        const mode = rawPosition.startsWith("before:") ? "before" : "after";
        const targetId = rawPosition.replace(/^(after:|before:)/, "");
        const target = route.cities.find((entry) => entry.id === targetId);
        if (!target) return send(res, 400, { error: "插入位置不存在" });
        const targetOrder = Number(target.order);
        const newOrder = mode === "before" ? targetOrder : targetOrder + 1;
        route.cities = route.cities.map((entry) => (
          Number(entry.order) >= newOrder ? { ...entry, order: Number(entry.order) + 1 } : entry
        ));
        route.cities.push(newCity(name, newOrder));
      } else {
        const maxOrder = route.cities.reduce((max, entry) => Math.max(max, Number(entry.order) || 0), 0);
        route.cities.push(newCity(name, maxOrder + 1));
      }
      route.cities = normalizeCities(route.cities);
      console.log("后端保存后的 cities order：");
      for (const city of route.cities) console.log(`${city.name} ${city.order}`);
      restoreRouteFields(route, preservedFields);
      route.updatedAt = new Date().toISOString();
      invalidateRouteMap(route);
      await saveData(data);
      return send(res, 201, route);
    }

    const cityMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/cities\/([^/]+)$/);
    if (cityMatch && req.method === "DELETE") {
      const route = data.routes.find((entry) => entry.id === cityMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const preservedFields = preserveRouteFields(route);
      const before = route.cities?.length || 0;
      route.cities = normalizeCities(route.cities || []).filter((city) => city.id !== cityMatch[2]);
      if (route.cities.length === before) return send(res, 404, { error: "城市不存在" });
      route.cities = normalizeCities(route.cities);
      restoreRouteFields(route, preservedFields);
      route.updatedAt = new Date().toISOString();
      invalidateRouteMap(route);
      await saveData(data);
      return send(res, 200, route);
    }

    const cityToggleMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/cities\/([^/]+)\/toggle$/);
    if (cityToggleMatch && req.method === "POST") {
      const route = data.routes.find((entry) => entry.id === cityToggleMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const preservedFields = preserveRouteFields(route);
      route.cities = normalizeCities(route.cities || []);
      const city = route.cities.find((entry) => entry.id === cityToggleMatch[2]);
      if (!city) return send(res, 404, { error: "城市不存在" });
      city.enabled = city.enabled === false;
      route.cities = normalizeCities(route.cities);
      restoreRouteFields(route, preservedFields);
      route.updatedAt = new Date().toISOString();
      invalidateRouteMap(route);
      await saveData(data);
      return send(res, 200, route);
    }

    const cityMoveMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/cities\/([^/]+)\/move$/);
    if (cityMoveMatch && req.method === "POST") {
      const route = data.routes.find((entry) => entry.id === cityMoveMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const preservedFields = preserveRouteFields(route);
      const body = await readBody(req);
      route.cities = normalizeCities(route.cities || []);
      const index = route.cities.findIndex((city) => city.id === cityMoveMatch[2]);
      const targetIndex = body.direction === "up" ? index - 1 : index + 1;
      if (index < 0) return send(res, 404, { error: "城市不存在" });
      if (targetIndex < 0 || targetIndex >= route.cities.length) return send(res, 200, route);
      const currentOrder = route.cities[index].order;
      route.cities[index].order = route.cities[targetIndex].order;
      route.cities[targetIndex].order = currentOrder;
      route.cities = normalizeCities(route.cities);
      restoreRouteFields(route, preservedFields);
      route.updatedAt = new Date().toISOString();
      invalidateRouteMap(route);
      await saveData(data);
      return send(res, 200, route);
    }

    const distanceMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/distance$/);
    if (distanceMatch && req.method === "GET") {
      const route = data.routes.find((entry) => entry.id === distanceMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      if (!AMAP_WEB_SERVICE_KEY) return send(res, 400, { error: "后端缺少 AMAP_WEB_SERVICE_KEY 环境变量" });
      const signature = routeCitiesSignature(route);
      if (route.map?.distance_signature === signature && Array.isArray(route.map?.segments) && hasCompleteDistanceSegments(route)) {
        console.log(`[distance] cache hit route=${route.id}`);
        return send(res, 200, publicDistance(route.map));
      }
      if (inFlightDistance.has(route.id)) {
        console.log(`[distance] join in-flight route=${route.id}`);
        const map = await inFlightDistance.get(route.id);
        return send(res, 200, publicDistance(map));
      }
      const startedAt = Date.now();
      const reqId = requestId();
      const context = { source: "GET /api/routes/:routeId/distance", routeId: route.id, requestId: reqId };
      console.log(`[distance] start route=${route.id} request=${reqId} ${new Date(startedAt).toISOString()}`);
      try {
        for (const [from, to] of enabledSegmentPairs(route)) {
          console.log(`[distance] segment queued route=${route.id} request=${reqId} ${from} -> ${to}`);
        }
        const promise = (async () => {
          route.map = await buildRouteDistance(route, AMAP_WEB_SERVICE_KEY, data, context);
          route.updatedAt = new Date().toISOString();
          await saveData(data);
          return route.map;
        })();
        inFlightDistance.set(route.id, promise);
        route.map = await promise;
        console.log(`[distance] done route=${route.id} totalMs=${Date.now() - startedAt}`);
      } catch (error) {
        console.log(`[distance] failed route=${route.id} totalMs=${Date.now() - startedAt} error=${error.message}`);
        return send(res, 500, { error: error.message });
      } finally {
        inFlightDistance.delete(route.id);
      }
      return send(res, 200, publicDistance(route.map));
    }

    const mapDataMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/map-data$/);
    if (mapDataMatch && req.method === "GET") {
      const route = data.routes.find((entry) => entry.id === mapDataMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const signature = routeCitiesSignature(route);
      if (!route.map?.cities?.length || route.map?.cities_signature !== signature || !hasCompleteMapCities(route)) {
        if (!AMAP_WEB_SERVICE_KEY) return send(res, 400, { error: "后端缺少 AMAP_WEB_SERVICE_KEY 环境变量" });
        if (inFlightMapData.has(route.id)) {
          console.log(`[map-data] join in-flight route=${route.id}`);
          const map = await inFlightMapData.get(route.id);
          return send(res, 200, {
            cities: map.cities || [],
            segments: displaySegmentsForCities(normalizeCities(route.cities || []), map.cities || [], map.segments || []),
            total_distance_km: map.total_distance_km ?? null,
            updated_at: map.updated_at || null,
            error: map.error || ""
          });
        }
        const startedAt = Date.now();
        const reqId = requestId();
        const context = { source: "GET /api/routes/:routeId/map-data", routeId: route.id, requestId: reqId };
        console.log(`[map-data] start route=${route.id} request=${reqId} ${new Date(startedAt).toISOString()}`);
        try {
          const promise = (async () => {
            route.map = await buildRouteMarkersWithCache(route, AMAP_WEB_SERVICE_KEY, data, context);
            route.updatedAt = new Date().toISOString();
            await saveData(data);
            return route.map;
          })();
          inFlightMapData.set(route.id, promise);
          route.map = await promise;
          console.log(`[map-data] done route=${route.id} totalMs=${Date.now() - startedAt}`);
        } catch (error) {
          console.log(`[map-data] failed route=${route.id} totalMs=${Date.now() - startedAt} error=${error.message}`);
          return send(res, 500, { error: error.message });
        } finally {
          inFlightMapData.delete(route.id);
        }
      }
      return send(res, 200, {
        cities: route.map.cities || [],
        segments: displaySegmentsForCities(normalizeCities(route.cities || []), route.map.cities || [], route.map.segments || []),
        total_distance_km: route.map.total_distance_km ?? null,
        updated_at: route.map.updated_at || null,
        error: route.map.error || ""
      });
    }

    if (req.method === "GET" && url.pathname === "/api/amap-debug") {
      return send(res, 200, {
        stats: amapWebStats,
        inFlight: {
          geocodes: [...inFlightGeocodes.keys()],
          directions: [...inFlightDirections.keys()],
          mapDataRoutes: [...inFlightMapData.keys()],
          distanceRoutes: [...inFlightDistance.keys()]
        }
      });
    }

    const extractMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/extract$/);
    if (extractMatch && req.method === "POST") {
      const route = data.routes.find((entry) => entry.id === extractMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const body = await readBody(req);
      return send(res, 200, smartExtract(body.text, route));
    }

    const confirmMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/extract\/confirm$/);
    if (confirmMatch && req.method === "POST") {
      const route = data.routes.find((entry) => entry.id === confirmMatch[1]);
      if (!route) return send(res, 404, { error: "路线不存在" });
      const body = await readBody(req);
      const result = applyExtracted(route, body.items || [], body.missingCityMode || "add");
      if (result.skipped) return send(res, 200, route);
      await saveData(data);
      return send(res, 200, route);
    }

    send(res, 404, { error: "Not found" });
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Time and Road: http://localhost:${PORT}`);
});
