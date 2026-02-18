// CS2 constants
const APPID = 730;
const CONTEXTID = 2;

// Safe-ish page size (you found 5000 can return null)
const DEFAULT_COUNT = 2000;

const $ = (id) => document.getElementById(id);

function setStatus(msg, cls = "muted") {
  const el = $("status");
  el.className = `status ${cls}`;
  el.textContent = msg;
}

function iconUrl(iconUrlPath) {
  // Steam description.icon_url is a path segment; this is the common CDN format.
  return iconUrlPath
    ? `https://community.akamai.steamstatic.com/economy/image/${iconUrlPath}/96fx96f`
    : "";
}

function buildDescIndex(descriptions = []) {
  const map = new Map();
  for (const d of descriptions) {
    const key = `${d.classid}_${d.instanceid || "0"}`;
    map.set(key, d);
  }
  return map;
}

function buildMultiSellUrl(entries) {
  // entries: [{ name, qty }]
  const url = new URL("https://steamcommunity.com/market/multisell");
  url.searchParams.set("appid", String(APPID));
  url.searchParams.set("contextid", String(CONTEXTID));
  for (const e of entries) {
    url.searchParams.append("items[]", e.name);
    url.searchParams.append("qty[]", String(e.qty ?? 0));
  }
  return url.toString();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchInventoryPage(steamid64, count, startAssetId) {
  const url = new URL(`https://steamcommunity.com/inventory/${steamid64}/${APPID}/${CONTEXTID}`);
  url.searchParams.set("l", "english");
  url.searchParams.set("count", String(count));
  if (startAssetId) url.searchParams.set("start_assetid", startAssetId);

  const res = await fetch(url.toString(), { credentials: "include" });
  const text = await res.text();

  // Steam sometimes returns literal "null"
  if (text.trim() === "null") return { _null: true, status: res.status, url: url.toString() };

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { _parseError: true, status: res.status, url: url.toString(), sample: text.slice(0, 200) };
  }

  return { json, status: res.status, url: url.toString() };
}

async function fetchInventoryAll(steamid64) {
  // Retry strategy:
  // - try DEFAULT_COUNT
  // - if Steam returns null, drop count and retry
  // - paginate using start_assetid when more_items
  const countsToTry = [DEFAULT_COUNT, 1500, 1000, 500];

  for (const count of countsToTry) {
    let allAssets = [];
    let allDescriptions = [];
    let startAssetId = null;
    let pages = 0;

    setStatus(`Loading inventory… (count=${count})`);

    while (pages++ < 60) {
      const page = await fetchInventoryPage(steamid64, count, startAssetId);

      if (page._null) {
        // Soft-block — break to next smaller count
        setStatus(`Steam returned null at count=${count}. Trying smaller count…`, "muted");
        await sleep(400);
        allAssets = null;
        break;
      }

      if (page._parseError) {
        throw new Error(`Unexpected response (parse error).\nHTTP ${page.status}\n${page.url}\n${page.sample}`);
      }

      const inv = page.json || {};
      const assets = inv.assets || [];
      const descriptions = inv.descriptions || [];

      allAssets.push(...assets);
      allDescriptions.push(...descriptions);

      if (!inv.more_items) {
        return { assets: allAssets, descriptions: allDescriptions, countUsed: count };
      }

      // Steam sometimes provides a "last_assetid" or "more_start" field;
      // if not, fallback to last assetid from this page.
      startAssetId =
        inv.last_assetid ||
        inv.more_start ||
        inv.more_start_assetid ||
        (assets.length ? assets[assets.length - 1].assetid : null);

      if (!startAssetId) {
        // Can't paginate further; return what we have
        return { assets: allAssets, descriptions: allDescriptions, countUsed: count, partial: true };
      }

      // Tiny delay to reduce chance of rate limiting
      await sleep(120);
    }

    // If we broke due to null, continue to next smaller count
    if (allAssets === null) continue;
  }

  throw new Error("Steam kept returning null even with smaller counts. Try again later or reduce request frequency.");
}

function groupByMarketHashName(assets, descIndex) {
  // Returns array of:
  // { name, icon_url, total, tradable, marketable, commodity }
  const map = new Map();

  for (const a of assets) {
    const key = `${a.classid}_${a.instanceid || "0"}`;
    const d = descIndex.get(key);
    if (!d) continue;

    const name = d.market_hash_name || d.name;
    if (!name) continue;

    const amt = Number(a.amount || 1);

    if (!map.has(name)) {
      map.set(name, {
        name,
        icon_url: d.icon_url || "",
        total: 0,
        tradable: d.tradable ?? 0,
        marketable: d.marketable ?? 0,
        commodity: d.commodity ?? 0,
        name_color: d.name_color || null
      });

    }

    const entry = map.get(name);
    entry.total += amt;

    // if any instance reports commodity, treat it as commodity
    if (d.commodity) entry.commodity = 1;
  }

  const onlyTradableCommodities = [...map.values()].filter(
    x => x.commodity === 1 && x.tradable === 1
  );


  return onlyTradableCommodities.sort(
    (x, y) => (y.total - x.total) || x.name.localeCompare(y.name)
  );
}

function normalize(s) {
  return (s || "").toLowerCase();
}

async function detectSteamIdFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  // Examples:
  // https://steamcommunity.com/profiles/7656119.../inventory/#730
  // https://steamcommunity.com/profiles/7656119.../
  // https://steamcommunity.com/id/customname/  (won't contain SteamID64)
  const m = url.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (m) return m[1];

  return null;
}

function setButtonsEnabled(enabled) {
  $("filter").disabled = !enabled;
  $("selectAll").disabled = !enabled;
  $("clearSel").disabled = !enabled;
  // open/copy selected depend on selection; handled elsewhere
}

(async function main() {
  const steamidEl = $("steamid");
  const filterEl = $("filter");
  const listEl = $("list");

  const openSelectedBtn = $("openSelected");
  const copySelectedBtn = $("copySelected");
  const selectAllBtn = $("selectAll");
  const clearSelBtn = $("clearSel");
  const copyLastBtn = $("copyLast");
  const lastLinkEl = $("lastLink");

  let items = [];               // grouped items
  let selected = new Map();     // name -> qty (0 placeholder)
  let rendered = [];            // current filtered list

  function updateSelectedButtons() {
    const hasSel = selected.size > 0;
    openSelectedBtn.disabled = !hasSel;
    copySelectedBtn.disabled = !hasSel;
  }

  function setLastLink(url) {
    lastLinkEl.value = url || "";
    copyLastBtn.disabled = !url;
  }

  function renderList() {
    const q = normalize(filterEl.value);
    rendered = q ? items.filter(i => normalize(i.name).includes(q)) : items;

    listEl.innerHTML = "";

    for (const it of rendered) {
      const row = document.createElement("div");
      row.className = "item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(it.name);
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        if (cb.checked) selected.set(it.name, 0);
        else selected.delete(it.name);
        updateSelectedButtons();
      });

      const img = document.createElement("img");
      img.className = "icon";
      img.src = iconUrl(it.icon_url);
      img.alt = "";

      const grow = document.createElement("div");
      grow.className = "grow";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = it.name;

      if (it.name_color) {
        name.style.color = `#${it.name_color}`;
      }

      const meta = document.createElement("div");
      meta.className = "meta";
      const flags = [];
      if (it.tradable === 0) flags.push("not tradable");
      if (it.marketable === 0) flags.push("not marketable");
      meta.textContent = flags.length ? flags.join(" • ") : "tradable • marketable";

      grow.appendChild(name);
      grow.appendChild(meta);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.flexDirection = "column";
      right.style.alignItems = "flex-end";
      right.style.gap = "6px";

      const pill = document.createElement("span");
      pill.className = "pill count";
      pill.textContent = `x${it.total}`;

      right.appendChild(pill);

      row.appendChild(cb);
      row.appendChild(img);
      row.appendChild(grow);
      row.appendChild(right);

      // Clicking the row opens single-item multisell
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        const url = buildMultiSellUrl([{ name: it.name, qty: 0 }]);
        setLastLink(url);
        chrome.tabs.create({ url });
      });

      listEl.appendChild(row);
    }

    if (!rendered.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.padding = "12px";
      empty.textContent = "No items match your filter.";
      listEl.appendChild(empty);
    }
  }

  // Load saved SteamID
  const saved = await chrome.storage.local.get(["steamid64"]);
  if (saved.steamid64) steamidEl.value = saved.steamid64;

  $("autofill").addEventListener("click", async () => {
    const id = await detectSteamIdFromActiveTab();
    if (id) {
      steamidEl.value = id;
      await chrome.storage.local.set({ steamid64: id });
      setStatus(`Detected SteamID64 from tab: ${id}`, "ok");
    } else {
      setStatus("Couldn’t detect SteamID64 from current tab. Go to a URL like steamcommunity.com/profiles/<steamid64>/ …", "error");
    }
  });

  $("load").addEventListener("click", async () => {
    const steamid64 = steamidEl.value.trim();
    if (!/^\d{17}$/.test(steamid64)) {
      setStatus("Please enter a valid 17-digit SteamID64.", "error");
      return;
    }

    await chrome.storage.local.set({ steamid64 });
    setLastLink("");
    selected.clear();
    updateSelectedButtons();
    setButtonsEnabled(false);
    listEl.innerHTML = "";

    try {
      const inv = await fetchInventoryAll(steamid64);

      const descIndex = buildDescIndex(inv.descriptions);
      items = groupByMarketHashName(inv.assets, descIndex);

      setButtonsEnabled(true);
      setStatus(
        `Loaded ${items.length} unique marketable items (${inv.assets.length} assets) using count=${inv.countUsed}` +
        (inv.partial ? "\n(Partial: Steam did not provide a next page token.)" : ""),
        "ok"
      );

      renderList();
      updateSelectedButtons();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  filterEl.addEventListener("input", () => renderList());

  selectAllBtn.addEventListener("click", () => {
    for (const it of rendered) selected.set(it.name, 0);
    updateSelectedButtons();
    renderList();
  });

  clearSelBtn.addEventListener("click", () => {
    selected.clear();
    updateSelectedButtons();
    renderList();
  });

  openSelectedBtn.addEventListener("click", () => {
    const entries = [...selected.keys()].map((name) => ({ name, qty: 0 }));
    const url = buildMultiSellUrl(entries);
    setLastLink(url);
    chrome.tabs.create({ url });
  });

  copySelectedBtn.addEventListener("click", async () => {
    const entries = [...selected.keys()].map((name) => ({ name, qty: 0 }));
    const url = buildMultiSellUrl(entries);
    setLastLink(url);
    await navigator.clipboard.writeText(url);
    setStatus(`Copied multisell link for ${entries.length} items.`, "ok");
  });

  copyLastBtn.addEventListener("click", async () => {
    const url = lastLinkEl.value.trim();
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setStatus("Copied link.", "ok");
  });

  // Initial UI state
  setButtonsEnabled(false);
  updateSelectedButtons();
  setStatus("Enter SteamID64 (or click Auto) then Load.");
})();
