/* 玩家背包/仓库与宝可梦编辑（数据库） */
"use strict";

import { $, api, post, toast } from "./api.js";

const INV_NAMES = { 0: "void", 1: "背包", 2: "仓库", 3: "邮件", 4: "活动", 5: "共享活动" };
let characterId = null;
let online = false;

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

function bindEvents() {
  $("ply-load").addEventListener("click", loadPlayer);
  $("ply-character-id").addEventListener("input", () => { ++lookupGeneration; clearPlayerSelection(); });
  $("ply-character-id").addEventListener("keydown", (e) => { if (e.key === "Enter") loadPlayer(); });
  $("ply-item-add").addEventListener("click", async () => {
    if (!characterId) { toast("请先加载角色", true); return; }
    try {
      const result = await post("/api/player/item/add", {
        characterId, itemIndexId: Number($("ply-item-id").value),
        amount: Number($("ply-item-amount").value),
        inventoryId: Number($("ply-item-inv").value),
        force: askForce(),
      });
      toast(result.message);
      loadPlayer();
    } catch (error) { toast(error.message, true); }
  });
}
