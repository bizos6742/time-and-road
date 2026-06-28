const app = document.querySelector("#app");

let state = {
  data: { settings: {}, routes: [] },
  isAdminPath: window.location.pathname === "/admin",
  adminAuthenticated: false,
  adminChecked: false,
  adminPassword: "",
  selectedRouteId: null,
  selectedCityId: null,
  captureText: "",
  extractText: "",
  extractCity: "",
  extractItems: [],
  extractMissingCityMode: "add",
  routeViewMode: "map",
  mapData: {},
  mapLoading: {},
  mapErrors: {},
  distanceLoading: {},
  distanceErrors: {},
  mapCityId: null,
  mapEditingCityId: null,
  message: ""
};

let amapLoadPromise = null;
let activeMap = null;
let activeMapContainer = null;
let activeMapOverlays = [];
let distanceTimers = {};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "请求失败");
  return body;
}

async function load() {
  if (state.isAdminPath) {
    const session = await api("/api/admin/session");
    state.adminAuthenticated = Boolean(session.authenticated);
  }
  state.adminChecked = true;
  state.data = await api("/api/data");
  if (!state.selectedRouteId && state.data.routes[0]) state.selectedRouteId = state.data.routes[0].id;
  render();
}

function canEdit() {
  return state.isAdminPath && state.adminAuthenticated;
}

function selectedRoute() {
  return state.data.routes.find((route) => route.id === state.selectedRouteId) || null;
}

function selectedCity() {
  const route = selectedRoute();
  return route?.cities.find((city) => city.id === state.selectedCityId) || null;
}

function orderedCities(route) {
  return (route?.cities || [])
    .map((city, index) => ({
      ...city,
      order: Number.isFinite(Number(city.order)) ? Number(city.order) : index + 1,
      _fallbackOrder: index + 1,
      enabled: city.enabled !== false
    }))
    .sort((a, b) => (a.order - b.order) || (a._fallbackOrder - b._fallbackOrder))
    .map(({ _fallbackOrder, ...city }, index) => ({ ...city, order: index + 1 }));
}

function normalizeRouteOrder(route) {
  route.cities = orderedCities(route);
  return route;
}

function printCityOrders(label, route) {
  console.log(label);
  for (const city of orderedCities(route)) {
    console.log(`${city.name} ${city.order} ${city.enabled !== false}`);
  }
}

function moveCityByOne(route, cityId, direction) {
  route.cities = orderedCities(route);
  const index = route.cities.findIndex((city) => city.id === cityId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= route.cities.length) return false;
  const currentOrder = route.cities[index].order;
  route.cities[index].order = route.cities[targetIndex].order;
  route.cities[targetIndex].order = currentOrder;
  normalizeRouteOrder(route);
  return true;
}

function clearRouteMap(route) {
  route.map = { segments: [], total_distance_km: null, updated_at: null, error: "" };
  delete state.mapData[route.id];
  delete state.mapErrors[route.id];
  delete state.distanceErrors[route.id];
}

function syncCachedMapCities(route) {
  const cache = state.mapData[route.id];
  if (!cache?.cities) return;
  const cities = orderedCities(route);
  cache.cities = cities.map((city) => {
    const cached = cache.cities.find((entry) => entry.id === city.id) || {};
    return {
      ...cached,
      id: city.id,
      name: city.name,
      enabled: city.enabled !== false,
      days: city.days || "",
      keywords: city.keywords || "",
      reason: city.reason || "",
      notes: city.notes || "",
      counts: itemCounts(city)
    };
  });
}

async function saveRouteAndRecalculate(route, message, keepCityId = null) {
  normalizeRouteOrder(route);
  route.map = { segments: [], total_distance_km: null, updated_at: null, error: "" };
  delete state.mapErrors[route.id];
  delete state.distanceErrors[route.id];
  delete state.mapData[route.id];
  syncCachedMapCities(route);
  const updated = await api(`/api/routes/${route.id}`, { method: "PUT", body: route });
  state.data.routes = state.data.routes.map((entry) => entry.id === updated.id ? updated : entry);
  state.selectedRouteId = updated.id;
  state.selectedCityId = keepCityId;
  if (state.mapCityId && !updated.cities.some((city) => city.id === state.mapCityId)) state.mapCityId = null;
  scheduleDistanceCalculation(updated.id, message, keepCityId);
}

function replaceRoute(route) {
  state.data.routes = state.data.routes.map((entry) => entry.id === route.id ? route : entry);
  state.selectedRouteId = route.id;
}

function mergeCityOnlyRouteUpdate(previousRoute, updatedRoute) {
  if (!previousRoute) return updatedRoute;
  return {
    ...updatedRoute,
    name: previousRoute.name,
    start: previousRoute.start,
    end: previousRoute.end,
    totalDays: previousRoute.totalDays,
    bestSeason: previousRoute.bestSeason,
    tags: previousRoute.tags,
    notes: previousRoute.notes,
    sourceText: previousRoute.sourceText,
    cities: updatedRoute.cities || []
  };
}

async function applyServerRouteChange(request, message, keepCityId = null) {
  const before = selectedRoute();
  if (before) printCityOrders("前端当前 cities:", before);
  const serverRoute = await request();
  const route = mergeCityOnlyRouteUpdate(before, serverRoute);
  printCityOrders("后端返回 cities:", route);
  replaceRoute(route);
  state.selectedCityId = keepCityId;
  if (state.mapCityId && !route.cities.some((city) => city.id === state.mapCityId)) state.mapCityId = null;
  delete state.mapData[route.id];
  delete state.mapErrors[route.id];
  delete state.distanceErrors[route.id];
  scheduleDistanceCalculation(route.id, message, keepCityId);
  const latest = selectedRoute();
  if (latest) printCityOrders("前端当前 cities:", latest);
}

function scheduleDistanceCalculation(routeId, message, keepCityId = state.selectedCityId) {
  if (distanceTimers[routeId]) clearTimeout(distanceTimers[routeId]);
  state.message = `${message} 距离将在稍后更新。`;
  render();
  distanceTimers[routeId] = setTimeout(() => {
    delete distanceTimers[routeId];
    calculateDistance(routeId, message, keepCityId);
  }, 2000);
}

async function calculateDistance(routeId, message = "高德距离已更新。", keepCityId = state.selectedCityId) {
  if (distanceTimers[routeId]) {
    clearTimeout(distanceTimers[routeId]);
    delete distanceTimers[routeId];
  }
  if (state.distanceLoading[routeId]) return;
  state.distanceLoading[routeId] = true;
  delete state.distanceErrors[routeId];
  state.message = "正在计算高德距离...";
  render();
  try {
    console.log(`[frontend] GET /api/routes/${routeId}/distance`);
    await api(`/api/routes/${routeId}/distance`);
    const fresh = await api("/api/data");
    state.data = fresh;
    state.selectedRouteId = routeId;
    state.selectedCityId = keepCityId;
    delete state.mapData[routeId];
    delete state.mapErrors[routeId];
    state.message = message;
  } catch (error) {
    state.distanceErrors[routeId] = error.message;
    state.message = `距离计算失败：${error.message}`;
  } finally {
    state.distanceLoading[routeId] = false;
    render();
  }
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function closestFrom(target, selector) {
  if (target instanceof Element) return target.closest(selector);
  return target?.parentElement?.closest(selector) || null;
}

function itemCounts(city) {
  return {
    hotels: city.hotels?.length || 0,
    restaurants: city.restaurants?.length || 0,
    attractions: city.attractions?.length || 0
  };
}

function orderedFolders() {
  const folders = (state.data.folders || [])
    .map((folder, index) => ({
      ...folder,
      sortOrder: Number.isFinite(Number(folder.sortOrder)) ? Number(folder.sortOrder) : index + 1,
      _fallbackOrder: index + 1
    }))
    .sort((a, b) => (a.sortOrder - b.sortOrder) || (a._fallbackOrder - b._fallbackOrder));
  if (!folders.some((folder) => folder.id === "folder_uncategorized")) {
    folders.unshift({ id: "folder_uncategorized", name: "未分类", sortOrder: 0 });
  }
  return folders.map(({ _fallbackOrder, ...folder }) => folder);
}

function folderToolsView() {
  return `
    <div class="folder-tools">
      <label class="label">新增文件夹<input data-field="newFolderName" placeholder="例如：长线自驾" /></label>
      <button class="secondary" data-action="add-folder">新增文件夹</button>
    </div>
  `;
}

function routeDirectoryView() {
  const folders = orderedFolders();
  const routes = state.data.routes || [];
  const editable = canEdit();
  return `<div class="route-list">
    ${folders.map((folder, index) => {
      const folderRoutes = routes.filter((route) => (route.folderId || "folder_uncategorized") === folder.id);
      if (!editable && !folderRoutes.length) return "";
      return `
        <div class="folder-block" data-folder-drop="${esc(folder.id)}">
          <div class="folder-head">
            ${editable && folder.id !== "folder_uncategorized" ? `<input class="folder-name-input" data-folder-name="${folder.id}" value="${esc(folder.name)}" />` : `<strong>📁 ${esc(folder.name)}</strong>`}
            ${editable ? `
              <div class="folder-actions">
                <button class="pill-step" data-action="save-folder" data-folder-id="${folder.id}" ${folder.id === "folder_uncategorized" ? "disabled" : ""}>保存</button>
                <button class="pill-step" data-action="move-folder" data-direction="up" data-folder-id="${folder.id}" ${index <= 1 || folder.id === "folder_uncategorized" ? "disabled" : ""}>↑</button>
                <button class="pill-step" data-action="move-folder" data-direction="down" data-folder-id="${folder.id}" ${index === folders.length - 1 || folder.id === "folder_uncategorized" ? "disabled" : ""}>↓</button>
                <button class="pill-step danger" data-action="delete-folder" data-folder-id="${folder.id}" ${folder.id === "folder_uncategorized" ? "disabled" : ""}>删除</button>
              </div>
            ` : ""}
          </div>
          ${folderRoutes.map((entry) => `
            <div class="route-row" ${editable ? `draggable="true" data-drag-route-id="${entry.id}"` : ""}>
              <button class="route-tab ${entry.id === state.selectedRouteId ? "active" : ""}" data-route="${entry.id}">
                ${esc(entry.name)}
                <small>${esc(entry.start || "起点未填")} → ${esc(entry.end || "终点未填")}</small>
              </button>
              ${editable ? `<button class="route-delete danger" data-action="delete-route" data-route-id="${entry.id}" aria-label="删除路线">删除</button>` : ""}
            </div>
          `).join("") || `<p class="muted">还没有路线。</p>`}
        </div>
      `;
    }).join("") || `<p class="muted">还没有保存路线。</p>`}
  </div>`;
}

function render() {
  if (state.isAdminPath && !state.adminChecked) {
    app.innerHTML = `<main class="main"><p class="muted">正在进入后台...</p></main>`;
    return;
  }
  if (state.isAdminPath && !state.adminAuthenticated) {
    app.innerHTML = adminLoginView();
    return;
  }
  const route = selectedRoute();
  const city = selectedCity();
  const editable = canEdit();
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>Time and Road</h1>
          <p>时光与道路</p>
        </div>
        ${editable ? `<button class="secondary" data-action="home">新增路线</button>` : `<button class="secondary" data-action="show-list">浏览路线</button>`}
        ${editable ? `<button class="secondary" data-action="logout-admin">退出后台</button>` : `<a class="admin-link" href="/admin">后台管理</a>`}
        <h2 class="section-title">旅行目录</h2>
        ${editable ? folderToolsView() : ""}
        ${routeDirectoryView()}
      </aside>
      <main class="main">
        ${city ? cityView(route, city) : route ? routeView(route) : homeView()}
      </main>
    </div>
  `;
  if (route && !city && state.routeViewMode === "map") {
    setTimeout(() => initRouteMap(route), 0);
  }
}

function adminLoginView() {
  return `
    <main class="main">
      <section class="quick-capture">
        <div class="home-kicker">Time and Road</div>
        <div class="home-question">后台管理</div>
        <div class="home-intro"><p>请输入管理员密码。</p></div>
        <label class="label">密码<input type="password" data-field="adminPassword" value="${esc(state.adminPassword)}" /></label>
        <div class="actions">
          <button data-action="login-admin">进入后台</button>
          <a class="link" href="/">返回前台</a>
        </div>
        <p class="toast">${esc(state.message)}</p>
      </section>
    </main>
  `;
}

function homeView() {
  if (!canEdit()) {
    return `
      <section class="quick-capture">
        <div class="home-kicker">Time and Road</div>
        <div class="home-question">路线目录</div>
        <div class="home-intro">
          <p>记录值得再次出发的地方。</p>
          <p>这里是一个个人旅行资料库，普通访客可以浏览路线、城市、地图和笔记。</p>
        </div>
        <p class="toast">${esc(state.message)}</p>
      </section>
    `;
  }
  return `
    <section class="quick-capture">
      <div class="home-kicker">Time and Road</div>
      <div class="home-question">有什么值得我记住的地方？</div>
      <div class="home-intro">
        <p>记录值得再次出发的地方。</p>
        <p>不是旅行攻略。不是路线规划。</p>
        <p>而是把一路上看到的城市、景点、美食和自己的感受，慢慢沉淀成一本属于自己的旅行笔记。</p>
      </div>
      <textarea data-field="captureText" placeholder="例如：
* 一条想保存的路线
* 一篇小红书游记
* 一个值得去的小城
* 一家想住的民宿
* 一家值得再去的餐厅">${esc(state.captureText)}</textarea>
      <div class="actions">
        <button data-action="save-route">保存</button>
        <span class="hint">可以直接粘贴路线、城市顺序、游记片段和备注。</span>
      </div>
      <p class="toast">${esc(state.message)}</p>
    </section>
  `;
}

function routeView(route) {
  const cities = orderedCities(route);
  const editable = canEdit();
  return `
    <section class="route-head">
      <h2>${esc(route.name)}</h2>
      ${editable ? `
        <div class="field-row">
          ${field("路线名称", "name", route.name)}
          ${field("起点", "start", route.start)}
          ${field("终点", "end", route.end)}
          ${field("总天数", "totalDays", route.totalDays)}
        </div>
        <div class="field-row">
          ${field("最佳季节", "bestSeason", route.bestSeason)}
          ${field("路线标签", "tags", (route.tags || []).join("，"))}
          ${folderSelectField(route.folderId)}
          <div class="actions"><button data-action="save-route-edit">保存路线信息</button></div>
        </div>
        <label class="label">总备注<textarea data-route-field="notes">${esc(route.notes || "")}</textarea></label>
      ` : `
        <div class="stats">
          <span class="chip">${esc(route.start || "起点未填")} → ${esc(route.end || "终点未填")}</span>
          ${route.bestSeason ? `<span class="chip">${esc(route.bestSeason)}</span>` : ""}
          ${(route.tags || []).map((tag) => `<span class="chip">${esc(tag)}</span>`).join("")}
        </div>
        ${route.notes ? `<p>${esc(route.notes)}</p>` : ""}
      `}
    </section>

    <section class="card">
      <h3 class="section-title">城市顺序</h3>
      <div class="city-flow">
        ${cities.map((city, index) => `
          ${index ? `<span class="arrow">↓</span>` : ""}
          <span class="city-pill ${city.enabled === false ? "disabled" : ""} ${state.mapCityId === city.id ? "active" : ""}" title="点击定位，使用上移/下移调整顺序">
            <button class="city-pill-name" data-action="select-map-city" data-city-id="${city.id}">${esc(city.name)}</button>
            ${editable ? `
              <button class="pill-step" data-action="move-city" data-direction="up" data-city-id="${city.id}" ${index === 0 ? "disabled" : ""}>↑</button>
              <button class="pill-step" data-action="move-city" data-direction="down" data-city-id="${city.id}" ${index === cities.length - 1 ? "disabled" : ""}>↓</button>
            ` : ""}
          </span>
        `).join("") || `<span class="muted">还没有城市。</span>`}
      </div>
      ${editable ? `<div class="city-insert">
        <label class="label">添加城市<input data-field="newCityName" placeholder="城市名，例如：沧州" /></label>
        <label class="label">插入位置
          <select data-field="insertAfterCityId">
            <option value="__end__">放在最后</option>
            ${cities.map((city) => `<option value="after:${esc(city.id)}">放在 ${esc(city.name)} 之后</option>`).join("")}
            ${cities.map((city) => `<option value="before:${esc(city.id)}">放在 ${esc(city.name)} 之前</option>`).join("")}
          </select>
        </label>
        <div class="actions"><button data-action="add-city">添加城市</button></div>
      </div>` : ""}
    </section>

    <section class="card">
      <div class="view-head">
        <h3 class="section-title">路线查看</h3>
        <div class="segmented">
          <button class="${state.routeViewMode === "map" ? "" : "secondary"}" data-action="show-map">地图</button>
          <button class="${state.routeViewMode === "list" ? "" : "secondary"}" data-action="show-list">列表</button>
        </div>
      </div>
      ${state.routeViewMode === "map" ? routeMapView(route) : cityListView(route)}
    </section>

    ${editable ? `<section class="card">
      <h3 class="section-title">整理旅行资料</h3>
      <p class="hint">AI帮助整理旅行资料。AI负责整理，我负责决定。</p>
      <textarea data-field="extractText" placeholder="粘贴游记、点评或自己的零散记录">${esc(state.extractText)}</textarea>
      <div class="actions">
        <button data-action="extract">整理文本</button>
        ${state.extractItems.length ? `<button class="secondary" data-action="confirm-extract">确认保存选中项</button>` : ""}
      </div>
      ${extractView()}
    </section>` : ""}
    <p class="toast">${esc(state.message)}</p>
  `;
}

function field(label, key, value) {
  return `<label class="label">${label}<input data-route-field="${key}" value="${esc(value || "")}" /></label>`;
}

function folderSelectField(folderId) {
  return `<label class="label">路线文件夹<select data-route-field="folderId">
    ${orderedFolders().map((folder) => `<option value="${esc(folder.id)}" ${folder.id === (folderId || "folder_uncategorized") ? "selected" : ""}>${esc(folder.name)}</option>`).join("")}
  </select></label>`;
}

function cityListView(route) {
  const cities = orderedCities(route);
  const editable = canEdit();
  return `
    <div class="grid three">
      ${cities.map((city) => {
        const counts = itemCounts(city);
        return `
          <div class="city-card ${city.enabled === false ? "disabled" : ""}">
            <h3>${esc(city.name)}</h3>
            <div class="muted">${city.enabled === false ? "临时跳过 · " : ""}${esc(city.days || "停留天数未填")} · ${esc(city.keywords || "关键词未填")}</div>
            <div class="stats">
              <span class="chip">宾馆 ${counts.hotels}</span>
              <span class="chip">餐厅 ${counts.restaurants}</span>
              <span class="chip">景点 ${counts.attractions}</span>
            </div>
            <div class="actions">
              <button class="secondary" data-city="${city.id}">查看详情</button>
              ${editable ? `
                <button class="secondary" data-action="toggle-city" data-city-id="${city.id}">${city.enabled === false ? "启用" : "临时跳过"}</button>
                <button class="secondary danger" data-action="delete-city" data-city-id="${city.id}">删除城市</button>
              ` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function routeMapView(route) {
  const mapCity = orderedCities(route).find((city) => city.id === state.mapCityId) || null;
  const mapError = state.mapErrors[route.id];
  const mapNotice = route.map?.error || state.mapData[route.id]?.error || "";
  return `
    <div class="map-layout">
      <div class="route-map" id="route-map">
        <div class="map-placeholder">${esc(mapError || (state.mapLoading[route.id] ? "正在加载路线地图..." : "路线地图"))}</div>
      </div>
      ${mapCity ? mapCityPanel(mapCity) : `<aside class="map-panel"><p class="muted">点击地图上的城市标记，查看这座城市的笔记摘要。</p></aside>`}
    </div>
    ${mapNotice && !mapError ? `<p class="toast">${esc(mapNotice)}</p>` : ""}
    ${distanceView(route)}
  `;
}

function mapCityPanel(city) {
  const counts = itemCounts(city);
  const editable = canEdit();
  const editing = editable && state.mapEditingCityId === city.id;
  return `
    <aside class="map-panel">
      <button class="panel-close" data-action="close-map-city" aria-label="关闭城市卡片">×</button>
      <h3>${esc(city.name)}</h3>
      ${editing ? `
        <label class="label">停留天数<input data-map-city-field="days" value="${esc(city.days || "")}" /></label>
        <label class="label">关键词<input data-map-city-field="keywords" value="${esc(city.keywords || "")}" /></label>
        <label class="label">为什么想去<textarea data-map-city-field="reason">${esc(city.reason || "")}</textarea></label>
        <label class="label">自己备注<textarea data-map-city-field="notes">${esc(city.notes || "")}</textarea></label>
        <div class="actions">
          <button data-action="save-map-city">保存</button>
          <button class="secondary" data-action="cancel-map-edit">取消</button>
        </div>
      ` : `
        <p class="muted">${city.enabled === false ? "临时跳过 · " : ""}${esc(city.days || "停留天数未填")} · ${esc(city.keywords || "关键词未填")}</p>
        <p>${esc(city.reason || "还没有写为什么想去。")}</p>
        <div class="stats">
          <span class="chip">宾馆 ${counts.hotels}</span>
          <span class="chip">餐厅 ${counts.restaurants}</span>
          <span class="chip">景点 ${counts.attractions}</span>
        </div>
        <div class="actions">
          ${editable ? `
            <button data-action="edit-map-city">编辑城市</button>
            <button class="secondary" data-action="toggle-city" data-city-id="${city.id}">${city.enabled === false ? "启用" : "临时跳过"}</button>
          ` : ""}
          <button class="secondary" data-city="${city.id}">查看详情</button>
          ${editable ? `<button class="secondary danger" data-action="delete-city" data-city-id="${city.id}">删除城市</button>` : ""}
        </div>
      `}
    </aside>
  `;
}

function distanceView(route) {
  const map = route.map || {};
  const distanceError = state.distanceErrors[route.id] || map.error || "";
  const isLoading = Boolean(state.distanceLoading[route.id]);
  const formatDistance = (value) => {
    const distance = Number(value);
    return Number.isFinite(distance) ? `${distance} km` : "待计算";
  };
  const formatDuration = (value) => {
    const duration = Number(value);
    return Number.isFinite(duration) ? ` · ${duration}h` : "";
  };
  const total = Number(map.total_distance_km ?? map.totalDistanceKm);
  const segments = map.segments || [];
  const successfulSegments = segments.filter((segment) => Number.isFinite(Number(segment.distance_km ?? segment.distanceKm)));
  const longest = successfulSegments.reduce((winner, segment) => {
    const distance = Number(segment.distance_km ?? segment.distanceKm);
    const winnerDistance = winner ? Number(winner.distance_km ?? winner.distanceKm) : -1;
    return distance > winnerDistance ? segment : winner;
  }, null);
  return `
    <div class="distance-panel">
      <div class="distance-overview">
        <span>总距离：${Number.isFinite(total) ? `${total} km` : "待计算"}</span>
        <span>共 ${segments.length} 段</span>
        <span>最长路段：${longest ? `${esc(longest.from)} → ${esc(longest.to)}，${formatDistance(longest.distance_km ?? longest.distanceKm)}` : "待计算"}</span>
      </div>
      <div class="segment-strip">
        ${segments.map((segment) => `
        <div class="segment-card">
          <strong>${esc(segment.from)} → ${esc(segment.to)}</strong>
          ${segment.failed || segment.error ? `
            <div class="muted">计算失败：${esc(segment.error || "高德接口暂时不可用")}</div>
          ` : `
            <div class="muted">${formatDistance(segment.distance_km ?? segment.distanceKm)}${formatDuration(segment.duration_hours ?? segment.durationHours)}</div>
            ${segment.navigation_url || segment.navigationUrl ? `<a class="link" href="${esc(segment.navigation_url || segment.navigationUrl)}" target="_blank" rel="noreferrer">打开高德导航</a>` : ""}
          `}
        </div>
        `).join("") || `<div class="segment-card muted">还没有计算距离。</div>`}
      </div>
      ${distanceError ? `<p class="toast">${esc(distanceError)}</p>` : ""}
      <div class="actions distance-actions">
        <button data-action="calc-distance" ${isLoading ? "disabled" : ""}>${isLoading ? "计算中..." : "计算距离"}</button>
        <span class="hint">只按你保存的城市顺序计算，不重新规划。</span>
      </div>
    </div>
  `;
}

function loadAmap() {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (!amapLoadPromise) {
    amapLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/amap-js-api";
      script.async = true;
      script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error("高德地图脚本没有加载成功"));
      script.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(script);
    });
  }
  return amapLoadPromise;
}

async function ensureMapData(route) {
  if (state.mapData[route.id]) return state.mapData[route.id];
  if (state.mapErrors[route.id]) return null;
  if (state.mapLoading[route.id]) return null;
  state.mapLoading[route.id] = true;
  try {
    console.log(`[frontend] GET /api/routes/${route.id}/map-data`);
    const data = await api(`/api/routes/${route.id}/map-data`);
    state.mapData[route.id] = data;
    delete state.mapErrors[route.id];
    state.mapLoading[route.id] = false;
    return data;
  } catch (error) {
    state.mapLoading[route.id] = false;
    state.mapErrors[route.id] = error.message;
    state.message = error.message;
    render();
    return null;
  }
}

async function initRouteMap(route) {
  const container = document.querySelector("#route-map");
  if (!container) return;
  if (state.mapErrors[route.id]) return;
  const mapData = await ensureMapData(route);
  if (!mapData || !document.querySelector("#route-map")) return;
  console.log("地图使用 cities:");
  for (const city of mapData.cities || []) {
    console.log(`${city.name} ${city.order} ${city.enabled !== false}`);
  }

  try {
    const AMap = await loadAmap();
    if (activeMap && activeMapContainer === container) {
      if (activeMapOverlays.length && typeof activeMap.remove === "function") activeMap.remove(activeMapOverlays);
      container.querySelector(".map-placeholder")?.remove();
    } else {
      container.innerHTML = "";
      activeMap = new AMap.Map("route-map", { zoom: 6, viewMode: "2D" });
      activeMapContainer = container;
    }
    activeMapOverlays = [];
    const markerPositions = [];

    for (const [index, city] of (mapData.cities || []).entries()) {
      if (!Number.isFinite(city.lng) || !Number.isFinite(city.lat)) continue;
      const labelOffsets = [
        [0, -44],
        [76, -58],
        [-86, -78],
        [76, -38],
        [-86, -38],
        [76, -74],
        [-86, -74],
        [0, -96]
      ];
      const [labelX, labelY] = labelOffsets[index % labelOffsets.length];
      const marker = new AMap.Marker({
        position: [city.lng, city.lat],
        title: city.name,
        content: `<button class="route-city-marker ${city.enabled === false ? "disabled" : ""} ${state.mapCityId === city.id ? "active" : ""}" style="transform:translate(${labelX}px, ${labelY}px)" type="button" data-map-marker="${esc(city.id)}">${esc(city.name)}</button>`,
        anchor: "bottom-center",
        zIndex: 120 + index
      });
      activeMapOverlays.push(marker);
      markerPositions.push([city.lng, city.lat]);
    }

    const lines = (mapData.segments || [])
      .flatMap((segment) => segment.path || [])
      .filter((point) => Array.isArray(point) && point.length === 2);
    if (lines.length) {
      activeMapOverlays.push(new AMap.Polyline({
        path: lines,
        strokeColor: "#40675b",
        strokeWeight: 5,
        strokeOpacity: 0.82
      }));
      activeMap.add(activeMapOverlays);
      activeMap.setFitView();
    } else if (markerPositions.length) {
      activeMap.add(activeMapOverlays);
      activeMap.setFitView();
    }
    const selected = (mapData.cities || []).find((city) => city.id === state.mapCityId);
    if (selected && Number.isFinite(selected.lng) && Number.isFinite(selected.lat)) {
      if (typeof activeMap.setZoomAndCenter === "function") {
        activeMap.setZoomAndCenter(8, [selected.lng, selected.lat]);
      } else if (typeof activeMap.setCenter === "function") {
        activeMap.setCenter([selected.lng, selected.lat]);
      }
    }
  } catch (error) {
    container.innerHTML = `<div class="map-placeholder">${esc(error.message)}</div>`;
  }
}

function extractView() {
  if (!state.extractItems.length) return "";
  const route = selectedRoute();
  const cityExists = orderedCities(route).some((city) => city.name === state.extractCity);
  const groups = [
    ["spot", "景点"],
    ["restaurant", "餐厅"],
    ["hotel", "宾馆"],
    ["city_note", "城市备注"]
  ];
  return `<div class="extract-list">
    <div class="extract-row"><strong>城市：${esc(state.extractCity || "待确认")}</strong></div>
    ${state.extractCity && !cityExists ? `
      <label class="label">这个城市还不在当前路线中
        <select data-field="extractMissingCityMode">
          <option value="add" ${state.extractMissingCityMode === "add" ? "selected" : ""}>新增这个城市到当前路线</option>
          <option value="stash" ${state.extractMissingCityMode === "stash" ? "selected" : ""}>暂时保存到“待整理”</option>
          <option value="cancel" ${state.extractMissingCityMode === "cancel" ? "selected" : ""}>取消保存</option>
        </select>
      </label>
    ` : ""}
    ${groups.map(([type, title]) => {
      const entries = state.extractItems.map((item, index) => ({ item, index })).filter(({ item }) => item.type === type);
      if (!entries.length) return "";
      return `
        <div class="item-list">
          <h4>${title}</h4>
          ${entries.map(({ item, index }) => extractItemRow(item, index)).join("")}
        </div>
      `;
    }).join("")}
  </div>`;
}

function typeName(type) {
  return { restaurant: "餐厅", hotel: "宾馆", spot: "景点", city_note: "城市备注" }[type] || "备注";
}

function extractItemRow(item, index) {
  const mainValue = item.type === "city_note" ? (item.cityNote || item.content || "") : (item.name || "");
  const noteValue = item.note || "";
  return `
    <div class="extract-row" data-extract-row="${index}">
      <input type="checkbox" data-extract-check="${index}" ${item.checked === false ? "" : "checked"} />
      <span class="chip">${typeName(item.type)}</span>
      <input data-extract-field="main" data-extract-index="${index}" value="${esc(mainValue)}" />
      ${item.type === "spot" || item.type === "restaurant" || item.type === "hotel" ? `<input data-extract-field="note" data-extract-index="${index}" value="${esc(noteValue)}" placeholder="备注" />` : ""}
      <button class="secondary danger" data-action="delete-extract-item" data-extract-index="${index}">删除</button>
    </div>
  `;
}

function cityView(route, city) {
  const editable = canEdit();
  if (!editable) {
    return `
      <button class="ghost" data-action="back-route">← 返回路线</button>
      <section class="route-head">
        <h2>${esc(city.name)}</h2>
        <div class="stats">
          <span class="chip">${esc(city.days || "停留天数未填")}</span>
          ${city.keywords ? `<span class="chip">${esc(city.keywords)}</span>` : ""}
          ${city.enabled === false ? `<span class="chip">临时跳过</span>` : ""}
        </div>
        ${city.reason ? `<p>${esc(city.reason)}</p>` : ""}
        ${city.notes ? `<p>${esc(city.notes)}</p>` : ""}
      </section>
      ${collection("景点", "attractions", city.attractions, [
        ["名称", "name"], ["地址", "address"], ["是否值得绕路", "worthDetour"], ["自己备注", "notes"]
      ])}
      ${collection("宾馆", "hotels", city.hotels, [
        ["名称", "name"], ["地址", "address"], ["自己备注", "notes"]
      ])}
      ${collection("餐厅", "restaurants", city.restaurants, [
        ["名称", "name"], ["地址", "address"], ["是否值得专门去", "worthVisit"], ["自己备注", "notes"]
      ])}
      <p class="toast">${esc(state.message)}</p>
    `;
  }
  return `
    <button class="ghost" data-action="back-route">← 返回路线</button>
    <section class="route-head">
      <h2>${esc(city.name)}</h2>
      <div class="field-row">
        ${cityField("城市名", "name", city.name)}
        ${cityField("停留天数", "days", city.days)}
        ${cityField("关键词", "keywords", city.keywords)}
        <label class="label">状态<select data-city-field="enabled"><option value="true" ${city.enabled === false ? "" : "selected"}>启用</option><option value="false" ${city.enabled === false ? "selected" : ""}>临时跳过</option></select></label>
      </div>
      <div class="actions">
        <button data-action="save-city">保存城市信息</button>
        <button class="secondary danger" data-action="delete-city" data-city-id="${city.id}">删除城市</button>
      </div>
      <label class="label">为什么想去<textarea data-city-field="reason">${esc(city.reason || "")}</textarea></label>
      <label class="label">自己备注<textarea data-city-field="notes">${esc(city.notes || "")}</textarea></label>
    </section>

    ${collection("景点", "attractions", city.attractions, [
      ["名称", "name"], ["地址", "address"], ["是否值得绕路", "worthDetour"], ["自己备注", "notes"]
    ])}
    ${collection("宾馆", "hotels", city.hotels, [
      ["名称", "name"], ["地址", "address"], ["自己备注", "notes"]
    ])}
    ${collection("餐厅", "restaurants", city.restaurants, [
      ["名称", "name"], ["地址", "address"], ["是否值得专门去", "worthVisit"], ["自己备注", "notes"]
    ])}
    <p class="toast">${esc(state.message)}</p>
  `;
}

function cityField(label, key, value) {
  return `<label class="label">${label}<input data-city-field="${key}" value="${esc(value || "")}" /></label>`;
}

function collection(title, key, items = [], fields) {
  const editable = canEdit();
  return `
    <section class="card">
      <h3 class="section-title">${title}</h3>
      <div class="item-list">
        ${items.map((item) => editable ? `
          <div class="item" data-item="${item.id}">
            <div class="grid two">
              ${fields.map(([label, field]) => {
                if (field === "worthDetour") {
                  return `<label class="label">${label}<select data-array="${key}" data-id="${item.id}" data-item-field="${field}"><option value="false">先不确定</option><option value="true" ${item[field] ? "selected" : ""}>值得绕路</option></select></label>`;
                }
                if (field === "worthVisit") {
                  return `<label class="label">${label}<select data-array="${key}" data-id="${item.id}" data-item-field="${field}"><option value="false">先不确定</option><option value="true" ${item[field] ? "selected" : ""}>值得专门去</option></select></label>`;
                }
                return `<label class="label">${label}<input data-array="${key}" data-id="${item.id}" data-item-field="${field}" value="${esc(item[field] || "")}" /></label>`;
              }).join("")}
            </div>
          </div>
        ` : `
          <div class="item" data-item="${item.id}">
            <h4>${esc(item.name || "未命名")}</h4>
            ${item.address ? `<p class="muted">${esc(item.address)}</p>` : ""}
            ${item.worthDetour ? `<p class="muted">值得绕路</p>` : ""}
            ${item.worthVisit ? `<p class="muted">值得专门去</p>` : ""}
            ${item.notes ? `<p>${esc(item.notes)}</p>` : ""}
          </div>
        `).join("") || `<p class="muted">还没保存${title}。</p>`}
      </div>
      ${editable ? `<div class="actions">
        <button class="secondary" data-add-item="${key}">添加${title}</button>
        <button data-action="save-city">保存${title}</button>
      </div>` : ""}
    </section>
  `;
}

function collectRouteEdits(route) {
  const updates = structuredClone(route);
  document.querySelectorAll("[data-route-field]").forEach((input) => {
    const key = input.dataset.routeField;
    updates[key] = key === "tags" ? input.value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean) : input.value;
  });
  return updates;
}

function updateCurrentRouteField(input) {
  const route = selectedRoute();
  if (!route) return;
  const key = input.dataset.routeField;
  if (!key) return;
  route[key] = key === "tags"
    ? input.value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean)
    : input.value;
}

function collectCityEdits(city) {
  const updates = structuredClone(city);
  document.querySelectorAll("[data-city-field]").forEach((input) => {
    updates[input.dataset.cityField] = input.dataset.cityField === "enabled" ? input.value === "true" : input.value;
  });
  document.querySelectorAll("[data-array]").forEach((input) => {
    const list = updates[input.dataset.array];
    const item = list.find((entry) => entry.id === input.dataset.id);
    if (item) item[input.dataset.itemField] = ["worthDetour", "worthVisit"].includes(input.dataset.itemField) ? input.value === "true" : input.value;
  });
  updates.attractions = (updates.attractions || [])
    .filter((item) => String(item.name || "").trim().length > 0)
    .map((item) => ({ id: item.id, name: item.name || "", address: item.address || "", worthDetour: Boolean(item.worthDetour), notes: item.notes || "" }));
  updates.restaurants = (updates.restaurants || [])
    .filter((item) => String(item.name || "").trim().length > 0)
    .map((item) => ({ id: item.id, name: item.name || "", address: item.address || "", worthVisit: Boolean(item.worthVisit), notes: item.notes || "" }));
  updates.hotels = (updates.hotels || [])
    .filter((item) => String(item.name || "").trim().length > 0)
    .map((item) => ({ id: item.id, name: item.name || "", address: item.address || "", notes: item.notes || "" }));
  delete updates.links;
  delete updates.reminders;
  return updates;
}

function blankItem(type) {
  const base = { id: `${type}_${Date.now().toString(36)}` };
  if (type === "hotels") return { ...base, name: "", address: "", notes: "" };
  if (type === "restaurants") return { ...base, name: "", address: "", worthVisit: false, notes: "" };
  if (type === "attractions") return { ...base, name: "", address: "", worthDetour: false, notes: "" };
  return { ...base, name: "", address: "", notes: "" };
}

app.addEventListener("input", (event) => {
  if (event.target.dataset.extractField) {
    const index = Number(event.target.dataset.extractIndex);
    const item = state.extractItems[index];
    if (!item) return;
    if (event.target.dataset.extractField === "note") {
      item.note = event.target.value;
    } else if (item.type === "city_note") {
      item.cityNote = event.target.value;
    } else if (item.name !== undefined) {
      item.name = event.target.value;
    } else {
      item.content = event.target.value;
    }
    return;
  }
  if (event.target.dataset.routeField) {
    updateCurrentRouteField(event.target);
    return;
  }
  if (event.target.dataset.field) state[event.target.dataset.field] = event.target.value;
});

app.addEventListener("change", (event) => {
  if (event.target.dataset.extractCheck) {
    const item = state.extractItems[Number(event.target.dataset.extractCheck)];
    if (item) item.checked = event.target.checked;
    return;
  }
  if (event.target.dataset.routeField) {
    updateCurrentRouteField(event.target);
    render();
    return;
  }
  if (event.target.dataset.field) state[event.target.dataset.field] = event.target.value;
});

app.addEventListener("dragstart", (event) => {
  if (!canEdit()) return;
  const row = closestFrom(event.target, "[data-drag-route-id]");
  if (!row) return;
  event.dataTransfer.setData("text/plain", row.dataset.dragRouteId);
  event.dataTransfer.effectAllowed = "move";
});

app.addEventListener("dragover", (event) => {
  if (!canEdit()) return;
  const folder = closestFrom(event.target, "[data-folder-drop]");
  if (!folder) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});

app.addEventListener("drop", async (event) => {
  if (!canEdit()) return;
  const folder = closestFrom(event.target, "[data-folder-drop]");
  if (!folder) return;
  event.preventDefault();
  const routeId = event.dataTransfer.getData("text/plain");
  const route = state.data.routes.find((entry) => entry.id === routeId);
  if (!route || route.folderId === folder.dataset.folderDrop) return;
  try {
    const updated = { ...route, folderId: folder.dataset.folderDrop };
    const saved = await api(`/api/routes/${route.id}`, { method: "PUT", body: updated });
    replaceRoute(saved);
    state.message = "路线已移动到文件夹。";
    render();
  } catch (error) {
    state.message = error.message;
    render();
  }
});

document.addEventListener("click", (event) => {
  const closeMapCity = closestFrom(event.target, "[data-action='close-map-city']");
  if (closeMapCity) {
    event.preventDefault();
    event.stopPropagation();
    state.mapCityId = null;
    state.mapEditingCityId = null;
    render();
    return;
  }
  const mapMarker = closestFrom(event.target, "[data-map-marker]");
  if (!mapMarker) return;
  event.preventDefault();
  event.stopPropagation();
  state.mapCityId = mapMarker.dataset.mapMarker;
  state.mapEditingCityId = null;
  state.routeViewMode = "map";
  render();
}, true);

app.addEventListener("click", async (event) => {
  const mapMarker = closestFrom(event.target, "[data-map-marker]");
  const routeButton = closestFrom(event.target, "[data-route]");
  const cityButton = closestFrom(event.target, "[data-city]");
  const addItem = closestFrom(event.target, "[data-add-item]");
  const actionTarget = closestFrom(event.target, "[data-action]");
  const action = actionTarget?.dataset.action;

  try {
    if (action === "login-admin") {
      const result = await api("/api/admin/login", { method: "POST", body: { password: state.adminPassword } });
      state.adminAuthenticated = Boolean(result.authenticated);
      state.adminPassword = "";
      state.message = "已进入后台。";
      await load();
      return;
    }
    if (action === "logout-admin") {
      await api("/api/admin/logout", { method: "POST", body: {} });
      state.adminAuthenticated = false;
      state.selectedCityId = null;
      state.message = "已退出后台。";
      render();
      return;
    }
    const editActions = new Set([
      "move-city", "delete-route", "save-route", "save-route-edit", "add-city",
      "save-city", "toggle-city", "delete-city", "edit-map-city", "cancel-map-edit",
      "save-map-city", "delete-extract-item", "extract", "confirm-extract",
      "add-folder", "save-folder", "delete-folder", "move-folder"
    ]);
    if (editActions.has(action) && !canEdit()) {
      state.message = "前台为只读模式。";
      render();
      return;
    }
    if (mapMarker) {
      return;
    } else if (action === "select-map-city") {
      state.mapCityId = closestFrom(event.target, "[data-city-id]")?.dataset.cityId;
      state.mapEditingCityId = null;
      state.routeViewMode = "map";
      render();
    } else if (action === "close-map-city") {
      state.mapCityId = null;
      state.mapEditingCityId = null;
      render();
    } else if (action === "move-city") {
      const cityId = closestFrom(event.target, "[data-city-id]")?.dataset.cityId;
      const direction = closestFrom(event.target, "[data-direction]")?.dataset.direction;
      await applyServerRouteChange(
        () => api(`/api/routes/${selectedRoute().id}/cities/${cityId}/move`, { method: "POST", body: { direction } }),
        "城市顺序已更新，并已刷新路线距离。",
        state.selectedCityId
      );
    } else if (action === "delete-route") {
      const routeId = closestFrom(event.target, "[data-route-id]")?.dataset.routeId;
      if (!routeId) return;
      const ok = window.confirm("确定要删除这条路线吗？此操作不可恢复。");
      if (!ok) return;
      const nextData = await api(`/api/routes/${routeId}`, { method: "DELETE" });
      state.data = nextData;
      if (state.selectedRouteId === routeId) {
        state.selectedRouteId = state.data.routes[0]?.id || null;
        state.selectedCityId = null;
        state.mapCityId = null;
        state.mapEditingCityId = null;
      }
      delete state.mapData[routeId];
      delete state.mapErrors[routeId];
      delete state.distanceErrors[routeId];
      if (distanceTimers[routeId]) {
        clearTimeout(distanceTimers[routeId]);
        delete distanceTimers[routeId];
      }
      state.message = "路线已删除。";
      render();
    } else if (routeButton) {
      state.selectedRouteId = routeButton.dataset.route;
      state.selectedCityId = null;
      state.message = "";
      render();
    } else if (cityButton) {
      state.selectedCityId = cityButton.dataset.city;
      state.message = "";
      render();
    } else if (addItem) {
      const city = selectedCity();
      city[addItem.dataset.addItem].push(blankItem(addItem.dataset.addItem));
      render();
    } else if (action === "home") {
      state.selectedRouteId = null;
      state.selectedCityId = null;
      render();
    } else if (action === "add-folder") {
      const name = String(state.newFolderName || "").trim();
      if (!name) return;
      state.data = await api("/api/folders", { method: "POST", body: { name } });
      state.newFolderName = "";
      state.message = "文件夹已新增。";
      render();
    } else if (action === "save-folder") {
      const folderId = closestFrom(event.target, "[data-folder-id]")?.dataset.folderId;
      const input = document.querySelector(`[data-folder-name="${CSS.escape(folderId)}"]`);
      if (!folderId || !input) return;
      state.data = await api(`/api/folders/${folderId}`, { method: "PUT", body: { name: input.value } });
      state.message = "文件夹已保存。";
      render();
    } else if (action === "delete-folder") {
      const folderId = closestFrom(event.target, "[data-folder-id]")?.dataset.folderId;
      const folder = orderedFolders().find((entry) => entry.id === folderId);
      if (!folder) return;
      const ok = window.confirm(`确定删除文件夹「${folder.name}」吗？其中路线会移到“未分类”。`);
      if (!ok) return;
      state.data = await api(`/api/folders/${folderId}`, { method: "DELETE" });
      state.message = "文件夹已删除，路线已移到未分类。";
      render();
    } else if (action === "move-folder") {
      const folderId = closestFrom(event.target, "[data-folder-id]")?.dataset.folderId;
      const direction = closestFrom(event.target, "[data-direction]")?.dataset.direction;
      state.data = await api(`/api/folders/${folderId}/move`, { method: "POST", body: { direction } });
      state.message = "文件夹顺序已更新。";
      render();
    } else if (action === "save-route") {
      const route = await api("/api/routes", { method: "POST", body: { text: state.captureText } });
      await load();
      state.selectedRouteId = route.id;
      state.message = "已保存这条路线。";
      render();
    } else if (action === "save-route-edit") {
      const route = selectedRoute();
      const updated = await api(`/api/routes/${route.id}`, { method: "PUT", body: collectRouteEdits(route) });
      replaceRoute(updated);
      state.selectedRouteId = updated.id;
      state.selectedCityId = null;
      delete state.mapData[updated.id];
      delete state.mapErrors[updated.id];
      state.message = "路线信息已保存。";
      render();
    } else if (action === "add-city") {
      const name = document.querySelector("[data-field='newCityName']").value.trim();
      if (!name) return;
      const insertAfterCityId = document.querySelector("[data-field='insertAfterCityId']")?.value || "__end__";
      console.log("前端提交 addCity payload：");
      console.log("cityName", name);
      console.log("insertAfterCityId", insertAfterCityId);
      await applyServerRouteChange(
        () => api(`/api/routes/${selectedRoute().id}/cities`, { method: "POST", body: { cityName: name, insertAfterCityId } }),
        "城市已添加，并已刷新路线距离。"
      );
    } else if (action === "back-route") {
      state.selectedCityId = null;
      render();
    } else if (action === "save-city") {
      const route = normalizeRouteOrder(structuredClone(selectedRoute()));
      const city = route.cities.find((entry) => entry.id === state.selectedCityId);
      Object.assign(city, collectCityEdits(city));
      await saveRouteAndRecalculate(route, "城市信息已保存，并已刷新路线距离。", city.id);
    } else if (action === "toggle-city") {
      const cityId = closestFrom(event.target, "[data-city-id]")?.dataset.cityId;
      const city = orderedCities(selectedRoute()).find((entry) => entry.id === cityId);
      if (!city) return;
      await applyServerRouteChange(
        () => api(`/api/routes/${selectedRoute().id}/cities/${cityId}/toggle`, { method: "POST", body: {} }),
        city.enabled === false ? `已启用「${city.name}」，并已刷新路线距离。` : `已临时跳过「${city.name}」，并已刷新路线距离。`,
        state.selectedCityId
      );
    } else if (action === "delete-city") {
      const cityId = closestFrom(event.target, "[data-city-id]")?.dataset.cityId;
      const city = orderedCities(selectedRoute()).find((entry) => entry.id === cityId);
      if (!city) return;
      const ok = window.confirm(`确定删除「${city.name}」吗？\n该城市下的景点、宾馆、餐厅也会一起删除。`);
      if (!ok) return;
      if (state.selectedCityId === cityId) state.selectedCityId = null;
      if (state.mapCityId === cityId) state.mapCityId = null;
      await applyServerRouteChange(
        () => api(`/api/routes/${selectedRoute().id}/cities/${cityId}`, { method: "DELETE" }),
        `已删除「${city.name}」，并已刷新路线距离。`,
        state.selectedCityId
      );
    } else if (action === "calc-distance") {
      const route = selectedRoute();
      if (!route || state.distanceLoading[route.id]) return;
      await calculateDistance(route.id, "高德距离已更新。", state.selectedCityId);
    } else if (action === "show-map") {
      state.routeViewMode = "map";
      render();
    } else if (action === "show-list") {
      state.routeViewMode = "list";
      render();
    } else if (action === "edit-map-city") {
      state.mapEditingCityId = state.mapCityId;
      render();
    } else if (action === "cancel-map-edit") {
      state.mapEditingCityId = null;
      render();
    } else if (action === "save-map-city") {
      const route = normalizeRouteOrder(structuredClone(selectedRoute()));
      const city = route.cities.find((entry) => entry.id === state.mapCityId);
      document.querySelectorAll("[data-map-city-field]").forEach((input) => {
        city[input.dataset.mapCityField] = input.value;
      });
      await saveRouteAndRecalculate(route, "城市摘要已保存，并已刷新路线距离。");
      state.mapEditingCityId = null;
      render();
    } else if (action === "delete-extract-item") {
      const index = Number(closestFrom(event.target, "[data-extract-index]")?.dataset.extractIndex);
      if (Number.isFinite(index)) state.extractItems.splice(index, 1);
      render();
    } else if (action === "extract") {
      const result = await api(`/api/routes/${selectedRoute().id}/extract`, { method: "POST", body: { text: state.extractText } });
      state.extractCity = result.city || "";
      state.extractItems = (result.items || []).map((item) => ({ checked: true, city: result.city || item.city || "", ...item }));
      state.extractMissingCityMode = "add";
      state.message = state.extractItems.length ? "已整理出这些候选项，请确认后保存。" : "暂时没有整理出可保存的信息。";
      render();
    } else if (action === "confirm-extract") {
      if (state.extractMissingCityMode === "cancel") {
        state.message = "已取消保存这次整理结果。";
        render();
        return;
      }
      const checked = state.extractItems.filter((item) => item.checked !== false).map((item) => ({ ...item, city: state.extractCity || item.city || "" }));
      const route = await api(`/api/routes/${selectedRoute().id}/extract/confirm`, { method: "POST", body: { items: checked, missingCityMode: state.extractMissingCityMode } });
      delete state.mapData[route.id];
      delete state.mapErrors[route.id];
      await load();
      state.selectedRouteId = route.id;
      state.extractCity = "";
      state.extractItems = [];
      state.message = "选中的整理结果已保存。";
      render();
    }
  } catch (error) {
    state.message = error.message;
    render();
  }
});

load();
