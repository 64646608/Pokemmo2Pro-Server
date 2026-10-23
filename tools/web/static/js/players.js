/* 玩家背包/仓库与宝可梦编辑（数据库） */
"use strict";

import { $, api, post, toast } from "./api.js";

const INV_NAMES = { 0: "void", 1: "背包", 2: "仓库", 3: "邮件", 4: "活动", 5: "共享活动" };
let characterId = null;
let online = false;
let characterName = "";
const selectedGrantItems = new Map(); // itemId -> server-provided item name
const itemGrantLimits = new Map(); // server-derived Item.bin per-stack cap
const itemGrantAliases = new Map(); // explicitly requested legacy ID -> preferred catalog ID
const selectedSpecies = new Map(); // dexId -> Chinese species name
const pokemonRequestIds = new Map(); // (recipient, species, level) -> stable retry UUID
const MAX_GRANT_POKEMON = 10;
let speciesSearchGeneration = 0;
let pokemonGrantPending = false;
let speciesSearchTimer = null;
const MAX_GRANT_ITEMS = 20;
let itemSearchGeneration = 0;
let grantPending = false;
let mailDraftRequestId = null;
let mailDraftSignature = '';

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}


export function init() {
  bindEvents();
}

function askForce() {
  return online && confirm("该角色在线，游戏服内存会覆盖数据库修改！确认强制写入？");
}

// 名称查询结果始终按服务端返回的角色 id 操作；同名/模糊命中必须手动选定。
let lookupGeneration = 0;

function clearPlayerSelection() {
  characterId = null;
  online = false;
  characterName = "";
  $("ply-online").textContent = "未选择角色";
  $("ply-item-table").querySelector("tbody").replaceChildren();
  $("ply-poke-list").replaceChildren();
  $("ply-matches").replaceChildren();
  $("ply-matches").classList.add("hidden");
}

function showMatches(matches) {
  const container = $("ply-matches");
  container.replaceChildren();
  const title = document.createElement("div");
  title.className = "hint";
  title.textContent = `找到 ${matches.length} 个角色，请选择正确的角色：`;
  container.appendChild(title);
  for (const { account, character } of matches.slice(0, 50)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-match";
    button.textContent = `${character.name} · 账号 ${account.account_name} · ID ${character.id}${character.online ? " · 在线" : ""}`;
    button.addEventListener("click", () => {
      $("ply-character-id").value = character.name;
      loadById(character.id, character.name);
    });
    container.appendChild(button);
  }
  if (matches.length > 50) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "结果过多，请输入更完整的角色名称。";
    container.appendChild(hint);
  }
  container.classList.remove("hidden");
}

async function loadById(id, name) {
  const generation = ++lookupGeneration;
  clearPlayerSelection();
  try {
    const [items, pokemon] = await Promise.all([
      api(`/api/player/items?characterId=${id}`),
      api(`/api/player/pokemon?characterId=${id}`),
    ]);
    if (generation !== lookupGeneration) return;
    characterId = id;
    characterName = name;
    online = Boolean(items.character.online);
    $("ply-online").textContent = `已选 ${name} (#${id}) · ${online ? "在线（请勿强制改库）" : "离线"}`;
    renderItems(items.items);
    renderPokemon(pokemon.pokemon);
  } catch (error) {
    if (generation === lookupGeneration) {
      clearPlayerSelection();
      toast(error.message, true);
    }
  }
}

async function loadPlayer() {
  const query = $("ply-character-id").value.trim();
  const generation = ++lookupGeneration;
  clearPlayerSelection();
  if (!query) { toast("请输入角色名称、账号名称或角色 ID", true); return; }
  try {
    const data = await api(`/api/accounts?q=${encodeURIComponent(query)}`);
    if (generation !== lookupGeneration) return;
    const matches = [];
    for (const account of data.accounts) {
      for (const character of account.characters) {
        matches.push({ account, character });
      }
    }
    const exact = matches.filter(({ character }) =>
      character.name.toLocaleLowerCase() === query.toLocaleLowerCase() ||
      String(character.id) === query
    );
    // 优先精确角色名/角色ID；账号名、模糊匹配由用户明确选择。
    const candidates = exact.length ? exact : matches;
    if (!candidates.length) { toast("没有找到角色，请检查名称或账号", true); return; }
    if (candidates.length !== 1) { showMatches(candidates); return; }
    const { character } = candidates[0];
    await loadById(character.id, character.name);
  } catch (error) {
    if (generation === lookupGeneration) toast(error.message, true);
  }
}

function renderItems(rows) {
  const tbody = $("ply-item-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${row.item_index_id}</td>` +
      `<td>${escapeHtml(row.item_name || "?")}</td>` +
      `<td><input class="p-amount" type="number" min="1" max="999" value="${row.amount}" style="width:70px"></td>` +
      `<td class="sub">${INV_NAMES[row.inventory_id] || row.inventory_id}</td>`;
    const ops = document.createElement("td");
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "存";
    saveBtn.onclick = async () => {
      try {
        const result = await post("/api/player/item/update", {
          characterId, itemId: row.item_id, amount: Number(tr.querySelector(".p-amount").value),
          force: askForce(),
        });
        toast(result.message);
      } catch (error) { toast(error.message, true); }
    };
    const delBtn = document.createElement("button");
    delBtn.textContent = "删";
    delBtn.className = "danger";
    delBtn.onclick = async () => {
      if (!confirm(`删除道具 #${row.item_id}（${row.item_name}）？`)) return;
      try {
        const result = await post("/api/player/item/delete", { characterId, itemId: row.item_id, force: askForce() });
        toast(result.message);
        loadPlayer();
      } catch (error) { toast(error.message, true); }
    };
    ops.appendChild(saveBtn);
    ops.appendChild(delBtn);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}

function renderPokemon(rows) {
  const wrap = $("ply-poke-list");
  wrap.innerHTML = "";
  for (const p of rows) {
    const box = document.createElement("details");
    box.className = "poke-box";
    const summary = `${escapeHtml(p.nickname || p.dex_name || "?")} Lv.${p.level}` +
      `（#${p.dex_id}${p.shiny ? " ✨" : ""}${p.hidden_ability ? " 梦特" : ""}）` +
      ` @${p.container_name || p.container_id}[${p.position}] ${p.online_hint || ""}`;
    box.innerHTML = `<summary>${summary}</summary>
      <div class="grid2">
        <label>昵称 <input class="pk-nick" type="text" value="${escapeHtml(p.nickname || "")}"></label>
        <label>等级 <input class="pk-level" type="number" min="1" max="100" value="${p.level}"></label>
        <label>当前HP <input class="pk-hp" type="number" min="0" value="${p.current_hp}"></label>
        <label>经验 <input class="pk-exp" type="number" min="0" value="${p.exp}"></label>
        <label>特性 <input class="pk-ability" type="number" min="0" value="${p.ability}"></label>
        <label>携带道具 <input class="pk-item" type="number" min="-1" value="${p.held_item}"></label>
        <label>亲密 <input class="pk-friend" type="number" min="0" max="255" value="${p.friendship}"></label>
        <label>闪光 <input class="pk-shiny" type="checkbox" ${p.shiny ? "checked" : ""}></label>
      </div>
      <div class="grid2">
        <label>个体值 IV（6 个，逗号分隔）<input class="pk-ivs" type="text" value="${p.ivs.join(",")}"></label>
        <label>努力值 EV（6 个）<input class="pk-evs" type="text" value="${p.evs.join(",")}"></label>
        <label>招式（4 个）<input class="pk-moves" type="text" value="${p.moves.join(",")}"></label>
        <label>招式PP <input class="pk-pp" type="text" value="${p.moves_pp.join(",")}"></label>
      </div>
      <div class="actions">
        <button class="pk-save primary">保存</button>
        <button class="pk-delete danger">放生（删除）</button>
      </div>`;
    box.querySelector(".pk-save").onclick = async () => {
      const changes = {
        nickname: box.querySelector(".pk-nick").value.trim(),
        level_value: Number(box.querySelector(".pk-level").value),
        current_hp: Number(box.querySelector(".pk-hp").value),
        exp: Number(box.querySelector(".pk-exp").value),
        ability: Number(box.querySelector(".pk-ability").value),
        item: Number(box.querySelector(".pk-item").value),
        friend_value: Number(box.querySelector(".pk-friend").value),
        is_shiny: box.querySelector(".pk-shiny").checked,
        iv_values: box.querySelector(".pk-ivs").value.split(",").map((v) => Number(v.trim())),
        ev_values: box.querySelector(".pk-evs").value.split(",").map((v) => Number(v.trim())),
        moves: box.querySelector(".pk-moves").value.split(",").map((v) => Number(v.trim())),
        moves_pp: box.querySelector(".pk-pp").value.split(",").map((v) => Number(v.trim())),
      };
      try {
        const result = await post("/api/player/pokemon/update", {
          characterId, pokemonId: p.id, changes, force: askForce(),
        });
        toast(result.message);
      } catch (error) { toast(error.message, true); }
    };
    box.querySelector(".pk-delete").onclick = async () => {
      if (!confirm(`确定放生/删除 ${summary}？不可恢复！`)) return;
      try {
        const result = await post("/api/player/pokemon/delete", { characterId, pokemonId: p.id, force: askForce() });
        toast(result.message);
        loadPlayer();
      } catch (error) { toast(error.message, true); }
    };
    wrap.appendChild(box);
  }
  if (!rows.length) wrap.innerHTML = `<p class="empty">该角色没有宝可梦</p>`;
}


function updateGrantSelection() {
  const items = [...selectedGrantItems].map(([id, name]) => name + " (#" + id + ", 每组上限 " + (itemGrantLimits.get(id) || "未知") + ")");
  $("ply-item-selected").textContent = items.length
    ? "已选 " + items.length + " 种：" + items.join("、")
    : "未选择道具";
  $("ply-item-picker-count").textContent = "已选择 " + items.length + " 种（上限 " + MAX_GRANT_ITEMS + "）";
  $("ply-item-add").disabled = grantPending || !items.length;
}

function openGrantPicker() {
  $("ply-item-picker").classList.remove("hidden");
  $("ply-item-search").value = "精灵球";
  searchGrantItems();
  $("ply-item-search").focus();
}

function closeGrantPicker() {
  $("ply-item-picker").classList.add("hidden");
  ++itemSearchGeneration;
}

async function searchGrantItems() {
  const term = $("ply-item-search").value.trim();
  const results = $("ply-item-results");
  const generation = ++itemSearchGeneration;
  results.replaceChildren();
  const hint = document.createElement("p");
  hint.className = "hint";
  if (!term) {
    hint.textContent = "输入中文道具名称、英文名称或编号，或点击上方常用分类。";
    results.appendChild(hint);
    return;
  }
  hint.textContent = "正在搜索…";
  results.appendChild(hint);
  try {
    const data = await api("/api/items?q=" + encodeURIComponent(term));
    if (generation !== itemSearchGeneration || $("ply-item-picker").classList.contains("hidden")) return;
    results.replaceChildren();
    if (!data.items.length) {
      hint.textContent = "未找到匹配道具，请更换关键词。";
      results.appendChild(hint);
      return;
    }
    for (const item of data.items) {
      const id = Number(item.itemId);
      if (!Number.isSafeInteger(id) || id < 1) continue;
      const name = String(item.name || "未命名道具");
      const row = document.createElement("label");
      row.className = "gm-item-option";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedGrantItems.has(id);
      cb.setAttribute("aria-label", "选择道具 " + name);
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      const idSpan = document.createElement("small");
      const maxStack = Number(item.maxStack) || 0;
      const aliasOf = Number(item.aliasOf) || 0;
      const mirrorIds = Array.isArray(item.aliasIds) ? item.aliasIds : [];
      idSpan.textContent = "#" + id + (maxStack > 0 ? " · 单组上限 " + maxStack : " · 无法发放")
        + (aliasOf > 0 ? " · 兼容编号（推荐 #" + aliasOf + "，效果待核验）"
          : mirrorIds.length ? " · 已折叠 " + mirrorIds.length + " 个镜像编号" : "");
      cb.disabled = maxStack <= 0;
      row.append(cb, nameSpan, idSpan);
      cb.addEventListener("change", () => {
        if (cb.checked && !selectedGrantItems.has(id) && selectedGrantItems.size >= MAX_GRANT_ITEMS) {
          cb.checked = false;
          toast("单次最多选择 " + MAX_GRANT_ITEMS + " 种道具", true);
          return;
        }
        if (cb.checked) {
          selectedGrantItems.set(id, name);
          itemGrantLimits.set(id, maxStack);
          if (aliasOf > 0) itemGrantAliases.set(id, aliasOf);
          else itemGrantAliases.delete(id);
        } else {
          selectedGrantItems.delete(id);
          itemGrantLimits.delete(id);
          itemGrantAliases.delete(id);
        }
        updateGrantSelection();
      });
      results.appendChild(row);
    }
    if (data.items.length >= 30) {
      const foot = document.createElement("p");
      foot.className = "hint";
      foot.textContent = "最多显示前 30 条，请输入更具体的名称缩小范围。";
      results.appendChild(foot);
    }
  } catch (error) {
    if (generation !== itemSearchGeneration) return;
    results.replaceChildren();
    hint.textContent = "道具搜索失败：" + error.message;
    results.appendChild(hint);
  }
}

async function grantSelectedItems() {
  if (grantPending) return;
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    toast("请先查找并加载收件角色", true); return;
  }
  const amount = Number($("ply-item-amount").value);
  const title = $("ply-mail-title").value.trim();
  const body = $("ply-mail-body").value;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999) {
    toast("每种道具数量必须是 1–999", true); return;
  }
  if (!title || title.length > 128 || body.length > 4000) {
    toast("请填写有效的邮件主题和正文", true); return;
  }
  const entries = [...selectedGrantItems.entries()];
  if (entries.length < 1 || entries.length > MAX_GRANT_ITEMS) {
    toast("请选择 1–" + MAX_GRANT_ITEMS + " 种道具附件", true); return;
  }
  for (const [id, name] of entries) {
    const limit = itemGrantLimits.get(id) || 0;
    if (amount > limit) {
      toast(name + " (#" + id + ") 单组最多 " + limit + " 个；请降低数量或分开发送", true);
      return;
    }
  }
  const legacyIds = entries.filter(([id]) => itemGrantAliases.has(id));
  if (legacyIds.length && !confirm("已选中兼容编号：" + legacyIds.map(([id]) =>
      "#" + id + "（规范 #" + itemGrantAliases.get(id) + "）").join("、")
      + "。这些编号的实际使用效果未核验，确定仍要发放吗？")) return;
  const targetId = characterId, targetName = characterName;
  const items = entries.map(([itemIndexId]) => ({itemIndexId, amount}));
  const signature = JSON.stringify({targetId, title, body, items});
  if (!mailDraftRequestId || mailDraftSignature !== signature) {
    if (!globalThis.crypto?.randomUUID) {
      toast("当前浏览器无法生成安全邮件编号，请用 HTTPS 网页打开", true); return;
    }
    mailDraftRequestId = globalThis.crypto.randomUUID();
    mailDraftSignature = signature;
  }
  if (!confirm("确认向 " + targetName + " (#" + targetId + ") 发送游戏邮件？\n"
      + "主题：" + title + "\n附件：" + entries.map(([id, name]) => name + " (#" + id + ") ×" + amount).join("、")
      + "\n玩家将在游戏邮箱中领取附件。")) return;
  grantPending = true;
  updateGrantSelection();
  try {
    const response = await post("/api/player/mail/send-items", {
      characterId: targetId, title, body, requestId: mailDraftRequestId, items,
    });
    $("ply-item-result").textContent =
      (response.alreadySent ? "此前已送达，未重复发送。" : "邮件发送成功。")
      + "收件角色：" + response.recipient + "；附件 " + response.itemCount
      + " 种。玩家重新打开游戏邮箱后即可领取。";
    selectedGrantItems.clear();
    itemGrantLimits.clear();
    itemGrantAliases.clear();
    mailDraftRequestId = null;
    mailDraftSignature = "";
    toast(response.alreadySent ? "邮件此前已送达" : "游戏邮件已送达");
  } catch (error) {
    $("ply-item-result").textContent = "邮件发送失败：" + error.message
      + "。附件选择保留；再次点击将使用相同请求编号避免重复发送。";
    toast(error.message, true);
  } finally {
    grantPending = false;
    updateGrantSelection();
  }
}

// The backend matches any substring (including a single Chinese character)
// or numeric part of a species ID. Only exact selected dex IDs are mailed.
function updateSpeciesSelection() {
  const count = selectedSpecies.size;
  $("ply-pokemon-selected").textContent = count
    ? "已勾选 " + count + " / " + MAX_GRANT_POKEMON + " 只（可以继续搜索并勾选）"
    : "未选择宝可梦";
  $("ply-pokemon-give").disabled = pokemonGrantPending || count === 0;
  $("ply-pokemon-clear").disabled = pokemonGrantPending || count === 0;
  $("ply-pokemon-give").textContent = count ? "发送选中的 " + count + " 只宝可梦" : "发送选中的宝可梦";
  const chips = $("ply-pokemon-selected-chips");
  chips.replaceChildren();
  for (const [id, name] of selectedSpecies) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gm-pokemon-selected-chip";
    button.textContent = name + " (#" + id + ") ×";
    button.title = "取消勾选 " + name;
    button.disabled = pokemonGrantPending;
    button.addEventListener("click", () => {
      selectedSpecies.delete(id);
      updateSpeciesSelection();
      scheduleSpeciesSearch(0);
    });
    chips.appendChild(button);
  }
}

function scheduleSpeciesSearch(delay = 160) {
  ++speciesSearchGeneration; // invalidate outstanding responses immediately
  if (speciesSearchTimer !== null) clearTimeout(speciesSearchTimer);
  const term = $("ply-pokemon-search").value.trim();
  const target = $("ply-pokemon-search-result");
  target.replaceChildren();
  if (!term) {
    target.textContent = "输入任意几个字（例如“龙”）即可显示匹配列表。";
    return;
  }
  target.textContent = "正在匹配“" + term + "”…";
  const generation = speciesSearchGeneration;
  speciesSearchTimer = setTimeout(() => {
    speciesSearchTimer = null;
    searchSpecies(term, generation);
  }, delay);
}

async function searchSpecies(term, generation) {
  const target = $("ply-pokemon-search-result");
  try {
    const data = await api("/api/player/species?q=" + encodeURIComponent(term));
    if (generation !== speciesSearchGeneration) return;
    target.replaceChildren();
    const matches = Array.isArray(data.species) ? data.species : [];
    if (!matches.length) {
      target.textContent = "没有找到匹配的宝可梦，请换几个字试试。";
      return;
    }
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "找到匹配结果，勾选所需宝可梦：" + (matches.length >= 40
      ? "（仅显示前 40 项，可继续输入缩小范围）" : "");
    target.appendChild(hint);
    for (const species of matches) {
      const id = Number(species.id);
      const name = String(species.name || "");
      if (!Number.isSafeInteger(id) || id < 1 || !name) continue;
      const row = document.createElement("label");
      row.className = "gm-pokemon-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedSpecies.has(id);
      checkbox.disabled = pokemonGrantPending ||
        (selectedSpecies.size >= MAX_GRANT_POKEMON && !checkbox.checked);
      checkbox.setAttribute("aria-label", "选择 " + name + "（图鉴 #" + id + "）");
      const label = document.createElement("span");
      label.textContent = name;
      const number = document.createElement("small");
      number.textContent = "图鉴 #" + id;
      row.append(checkbox, label, number);
      checkbox.addEventListener("change", () => {
        if (pokemonGrantPending) {
          checkbox.checked = selectedSpecies.has(id);
          return;
        }
        if (checkbox.checked && selectedSpecies.size >= MAX_GRANT_POKEMON) {
          checkbox.checked = false;
          toast("单次最多勾选 " + MAX_GRANT_POKEMON + " 只宝可梦", true);
          return;
        }
        if (checkbox.checked) selectedSpecies.set(id, name);
        else selectedSpecies.delete(id);
        updateSpeciesSelection();
        // Show other checkbox disabled states correctly once limit is reached.
        target.querySelectorAll("input[type=checkbox]").forEach((cb) => {
          cb.disabled = pokemonGrantPending || (
            selectedSpecies.size >= MAX_GRANT_POKEMON && !cb.checked
          );
        });
      });
      target.appendChild(row);
    }
  } catch (error) {
    if (generation === speciesSearchGeneration) {
      target.textContent = "搜索失败：" + error.message;
    }
  }
}

async function grantPokemon() {
  if (pokemonGrantPending) return;
  if (!characterId || selectedSpecies.size === 0) {
    toast("请先选择收件角色，再勾选宝可梦", true);
    return;
  }
  const level = Number($("ply-pokemon-level").value);
  if (!Number.isSafeInteger(level) || level < 1 || level > 100) {
    toast("等级必须在 1～100 之间", true);
    return;
  }
  const entries = [...selectedSpecies.entries()];
  if (entries.length > MAX_GRANT_POKEMON) {
    toast("单次最多选择 " + MAX_GRANT_POKEMON + " 只", true);
    return;
  }
  const targetId = characterId, targetName = characterName;
  const title = "GM 宝可梦礼物";
  const body = "请在游戏邮箱中领取宝可梦，领取后将进入队伍或 PC。";
  const summary = entries.map(([id, name]) => name + " (#" + id + ")").join("、");
  if (!confirm("确认给 " + targetName + " (#" + targetId + ") 发送 " +
      entries.length + " 只 Lv." + level + " 的宝可梦？\n" +
      summary + "\n每只对应一封邮件，玩家在游戏邮箱领取。")) return;
  if (!globalThis.crypto?.randomUUID) {
    toast("当前浏览器不支持安全请求编号，请通过 HTTPS 打开后台", true);
    return;
  }
  pokemonGrantPending = true;
  $("ply-pokemon-search").disabled = true;
  updateSpeciesSelection();
  let succeeded = 0, failure = "";
  try {
    // Existing GAME mail API supports one Pokemon per email. Deliver serially.
    // Persist each UUID for retries, removing only confirmed sent entries.
    for (const [id, name] of entries) {
      const key = JSON.stringify([targetId, id, level, title, body]);
      let requestId = pokemonRequestIds.get(key);
      if (!requestId) {
        requestId = globalThis.crypto.randomUUID();
        pokemonRequestIds.set(key, requestId);
      }
      try {
        await post("/api/player/mail/send-pokemon", {
          characterId: targetId, speciesId: id, level, title, body, requestId,
        });
        pokemonRequestIds.delete(key);
        selectedSpecies.delete(id);
        succeeded++;
        updateSpeciesSelection();
      } catch (error) {
        failure = name + " (#" + id + ")：" + error.message;
        break;
      }
    }
    $("ply-pokemon-grant-status").textContent = failure
      ? "已确认发送 " + succeeded + " / " + entries.length +
        " 只，剩余未发送。失败：" + failure + "。可保留勾选重试。"
      : "已发送 " + succeeded + " 只宝可梦至 " + targetName +
        " 的游戏邮箱。每只一封邮件，请玩家自行领取。";
    toast(failure ? "部分发送失败，详见结果" : "宝可梦邮件发送成功", !!failure);
    if (succeeded) await loadById(targetId, targetName);
  } finally {
    pokemonGrantPending = false;
    $("ply-pokemon-search").disabled = false;
    updateSpeciesSelection();
    scheduleSpeciesSearch(0);
  }
}

function bindEvents() {
  $("ply-load").addEventListener("click", loadPlayer);
  $("ply-character-id").addEventListener("input", () => { ++lookupGeneration; clearPlayerSelection(); });
  $("ply-character-id").addEventListener("keydown", (e) => { if (e.key === "Enter") loadPlayer(); });
  $("ply-item-choose").addEventListener("click", openGrantPicker);
  $("ply-item-picker-close").addEventListener("click", closeGrantPicker);
  $("ply-item-picker-confirm").addEventListener("click", closeGrantPicker);
  $("ply-item-picker").addEventListener("click", (event) => {
    if (event.target === $("ply-item-picker")) closeGrantPicker();
  });
  $("ply-item-search").addEventListener("input", searchGrantItems);
  $("ply-item-search").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeGrantPicker();
  });
  $("ply-item-picker").querySelectorAll("[data-item-search]").forEach((button) => {
    button.addEventListener("click", () => {
      $("ply-item-search").value = button.dataset.itemSearch;
      searchGrantItems();
    });
  });
  $("ply-item-picker-clear").addEventListener("click", () => {
    selectedGrantItems.clear();
    itemGrantLimits.clear();
    updateGrantSelection();
    searchGrantItems();
  });
  $("ply-item-add").addEventListener("click", grantSelectedItems);
  $("ply-pokemon-search").addEventListener("input", () => scheduleSpeciesSearch());
  $("ply-pokemon-clear").addEventListener("click", () => {
    selectedSpecies.clear();
    updateSpeciesSelection();
    scheduleSpeciesSearch(0);
  });
  $("ply-pokemon-give").addEventListener("click", grantPokemon);
  updateGrantSelection();
  updateSpeciesSelection();
}
