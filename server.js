// 极简云服务端 v3.6.1 (Node.js 零依赖)
// = 完整聊天(好友/群聊/已读/撤回/文件) + 火影联机信令 + 排行榜 + 门户
// 用法: node server.js --port=3777 --datadir=./data
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}
const PORT = parseInt(args.port || '3777', 10);
// 语音/视频通话需要 HTTPS 安全上下文: 若目录下有 cert.pem/key.pem 则额外监听 HTTPS 端口
const HTTPS_PORT = parseInt(args['https-port'] || process.env.HTTPS_PORT || '3778', 10);
const DATADIR = args.datadir || path.join(__dirname, 'data');
const FILESDIR = path.join(DATADIR, 'files');
const GAMEHTML = args.game || path.join(__dirname, 'naruto.html');
const CHATHTML = args.chat || path.join(__dirname, 'mobile.html');
const PORTALHTML = args.portal || path.join(__dirname, 'portal.html');
const WORLDHTML = args.world || path.join(__dirname, 'world.html');
const WORLDDIR = path.join(DATADIR, 'worlds');
try { fs.mkdirSync(WORLDDIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(FILESDIR, { recursive: true }); } catch (e) {}

// ---------- 状态 ----------
const state = { users: {}, friends: {}, requests: {}, groups: [], messages: [], nextId: 1, rank: {}, cleared: {}, reports: [], worldRooms: {} };
const fsRooms = {};   // 火影帧同步房间: id -> {a,b,frames:{},next}
const worldPresence = {}; // 世界房间在线心跳: roomId -> {name:{at,x,z,sim,mic,ear}}
const voiceBox = {};      // 语音信令收件箱: name -> [{seq,from,room,kind,data,time}]
let voiceSeq = 0;
const worldSync = {};     // 世界房间实时同步: roomId -> {seq,events,players,sim,speed,region,host}
const stateFile = path.join(DATADIR, 'state.json');
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.users = s.users || {};
    state.friends = s.friends || {};
    state.requests = s.requests || {};
    state.groups = s.groups || [];
    state.messages = s.messages || [];
    state.nextId = s.nextId || 1;
    state.rank = s.rank || {};
    state.cleared = s.cleared || {};
    state.reports = s.reports || [];
    state.worldRooms = s.worldRooms || {};
  } catch (e) {}
}
function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) {}
}
loadState();
const sessions = {};   // token -> name
const lastSeen = {};   // name -> ts

function now() { return Date.now(); }
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function colorOf(n) {
  let h = 7;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return '#' + ('00000' + (h & 0x7fffff).toString(16)).slice(-6);
}
function sanName(s) {
  s = String(s || '').trim();
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{1,20}$/.test(s)) return '';
  const low = s.toLowerCase();
  if (low === 'all' || low === '系统' || low === 'system' || low === '群聊' || low === '所有人') return '';
  return s;
}
function purgeSessions() {
  const t = now();
  for (const k in sessions) {
    if (t - (lastSeen[sessions[k]] || 0) > 20000) delete sessions[k];
  }
}
function onlineOf(name) {
  for (const k in sessions) if (sessions[k] === name) return true;
  return false;
}
function newToken(name) {
  const t = crypto.randomBytes(16).toString('hex');
  sessions[t] = name;
  lastSeen[name] = now();
  return t;
}
function friendsOf(n) { return state.friends[n] || []; }
function isFriend(a, b) { return friendsOf(a).indexOf(b) >= 0; }
function addFriendPair(a, b) {
  if (!state.friends[a]) state.friends[a] = [];
  if (!state.friends[b]) state.friends[b] = [];
  if (state.friends[a].indexOf(b) < 0) state.friends[a].push(b);
  if (state.friends[b].indexOf(a) < 0) state.friends[b].push(a);
}
function removeFriendPair(a, b) {
  if (state.friends[a]) state.friends[a] = state.friends[a].filter(function (x) { return x !== b; });
  if (state.friends[b]) state.friends[b] = state.friends[b].filter(function (x) { return x !== a; });
}
function requestsTo(n) { return state.requests[n] || []; }
function normGid(id) { return id && id.indexOf('g:') === 0 ? id.slice(2) : id; }
function groupById(id) {
  id = normGid(id);
  for (let i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
  return null;
}
function inGroup(name, gid) {
  const g = groupById(gid);
  return !!(g && g.members.indexOf(name) >= 0);
}
function userDTO(n) {
  const u = state.users[n];
  const r = state.rank[n] || { wins: 0, losses: 0, pts: 1000 };
  const total = (r.wins || 0) + (r.losses || 0);
  return { name: n, color: u ? u.color : colorOf(n), online: onlineOf(n), wins: r.wins || 0, losses: r.losses || 0, rate: total ? Math.round((r.wins || 0) * 100 / total) : 0 };
}
function canSee(m, name) {
  if (m.to === name || m.from === name) return true;
  if (m.to && m.to.indexOf('g:') === 0) return inGroup(name, m.to);
  return false;
}
function addSystem(to, text) {
  state.messages.push({ id: state.nextId++, from: '系统', to: to, type: 'system', text: text, time: now() });
}
function addMsg(from, to, type, text, extra) {
  const m = { id: state.nextId++, from: from, to: to, type: type, text: text || '', time: now() };
  if (extra) for (const k in extra) m[k] = extra[k];
  state.messages.push(m);
  if (state.messages.length > 5000) state.messages.splice(0, state.messages.length - 5000);
  return m;
}


// ---------- 世界房间 ----------
function sanRoomName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (!s || s.length > 24) return '';
  return s;
}
function worldRoomById(id) { return state.worldRooms[id] || null; }
function worldRole(r, name) {
  if (!r || !name) return '';
  if (r.owner === name) return 'owner';
  if ((r.members || []).indexOf(name) >= 0) return 'member';
  if ((r.invites || []).indexOf(name) >= 0) return 'invited';
  return '';
}
function worldCanOpen(r, name) {
  const role = worldRole(r, name);
  return role === 'owner' || role === 'member';
}
function worldOnline(id) {
  const t = now(), box = worldPresence[id] || {}, arr = [];
  for (const n in box) {
    if (t - (box[n].at || 0) > 30000) delete box[n];
    else arr.push(n);
  }
  return arr;
}
function worldVoice(id) {
  const t = now(), box = worldPresence[id] || {}, out = {};
  for (const n in box) {
    if (t - (box[n].at || 0) <= 30000) out[n] = { mic: !!box[n].mic, ear: !!box[n].ear };
  }
  return out;
}
function voiceAllowed(from, to, room) {
  room = String(room || '');
  if (!to || !state.users[to] || to === from) return false;
  if (room.indexOf('w') === 0) {
    const r = worldRoomById(room);
    return !!(r && worldCanOpen(r, from) && worldCanOpen(r, to));
  }
  const fr = fsRooms[room];
  if (fr && ((fr.a === from && fr.b === to) || (fr.b === from && fr.a === to))) return true;
  return isFriend(from, to);
}
function worldRoomDTO(r, name) {
  const role = worldRole(r, name);
  return {
    id: r.id, name: r.name, owner: r.owner, mode: r.mode || 'solo',
    members: (r.members || []).slice(), memberCount: (r.members || []).length,
    role: role, invitedBy: (r.inviteBy && r.inviteBy[name]) || '',
    createdAt: r.createdAt || 0, updatedAt: r.updatedAt || 0,
    version: r.version || 0, saveBytes: r.saveBytes || 0, saveBy: r.saveBy || '',
    hasSave: (r.saveBytes || 0) > 0, online: worldOnline(r.id), voice: worldVoice(r.id)
  };
}
function worldSaveFile(id) { return path.join(WORLDDIR, id + '.json'); }
function worldNewId() {
  let id;
  do { id = 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'); } while (state.worldRooms[id]);
  return id;
}

// ---------- HTTP ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(b);
}
function ok(res, obj) { send(res, 200, obj); }
function fail(res, code, msg) { send(res, code, { ok: false, error: msg }); }
function readBody(req, cap) {
  return new Promise(function (resolve) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > (cap || 1024 * 1024)) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', function () { resolve(null); });
  });
}
function qp(req, key) {
  try { return new URL(req.url, 'http://x').searchParams.get(key); } catch (e) { return null; }
}
function auth(req) {
  const t = qp(req, 'token');
  if (!t) return null;
  purgeSessions();
  return sessions[t] || null;
}
function serveFile(res, file, type) {
  try {
    const b = fs.readFileSync(file);
    cors(res);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(b);
  } catch (e) { fail(res, 404, '文件不存在'); }
}

async function handle(req, res) {
  let p = '/';
  try { p = new URL(req.url, 'http://x').pathname; } catch (e) {}
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ---------- 页面 ----------
  if (p === '/') { serveFile(res, PORTALHTML, 'text/html; charset=utf-8'); return; }
  if (p === '/game' || p === '/game/') { serveFile(res, GAMEHTML, 'text/html; charset=utf-8'); return; }
  if (p === '/m' || p === '/m/' || p === '/chat') { serveFile(res, CHATHTML, 'text/html; charset=utf-8'); return; }
  if (p === '/world' || p === '/world/' || p === '/world.html') { serveFile(res, WORLDHTML, 'text/html; charset=utf-8'); return; }
  if (p === '/portal') { serveFile(res, PORTALHTML, 'text/html; charset=utf-8'); return; }

  // 外部音频/视频: /bgm/*.mp3 /voice/*.mp3 /video/*.mp4 (按需流式加载)
  if (p.indexOf('/bgm/') === 0 || p.indexOf('/voice/') === 0 || p.indexOf('/video/') === 0) {
    const safe = p.split('?')[0];
    if (!/^[\w.\-\/]+$/.test(safe)) { send(res, 404, { ok: false, error: 'bad path' }); return; }
    const file = path.join(__dirname, safe);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.mp3' ? 'audio/mpeg' : (ext === '.wav' ? 'audio/wav' : (ext === '.ogg' ? 'audio/ogg' : (ext === '.m4a' ? 'audio/mp4' : (ext === '.mp4' ? 'video/mp4' : 'application/octet-stream'))));
        const stat = fs.statSync(file);
        cors(res);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
        if (req.method === 'HEAD') { res.end(); return; }  // HEAD: 只回头(供客户端校验文件大小做缓存比对)
        fs.createReadStream(file).pipe(res);
        return;
      }
    } catch (e) {}
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (p === '/m/manifest') {
    const mb = '{"name":"极简聊天云版","short_name":"极简聊天","start_url":"/m","display":"standalone","background_color":"#ededed","theme_color":"#07c160"}';
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(mb);
    return;
  }
  if (p === '/m/sw.js') {
    const sb = 'self.addEventListener("install",function(e){self.skipWaiting();});self.addEventListener("activate",function(e){self.clients.claim();});self.addEventListener("fetch",function(e){});';
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(sb);
    return;
  }

  // ---------- 基础 ----------
  if (p === '/api/status') { ok(res, { ok: true, app: '极简聊天云服务端', version: '3.6.1' }); return; }

  if (p === '/api/register') {
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const n = sanName(b.name);
    const pw = String(b.password || '');
    if (!n) return fail(res, 400, '昵称需为1-20位中文/字母/数字/下划线');
    if (pw.length < 4 || pw.length > 32) return fail(res, 400, '密码需为4-32位');
    if (state.users[n]) return fail(res, 409, '该昵称已被注册，请直接登录');
    const salt = crypto.randomBytes(16).toString('hex');
    state.users[n] = { name: n, color: colorOf(n), salt: salt, hash: sha(salt + pw) };
    addSystem(n, '欢迎使用极简聊天云版！在「通讯录」添加好友，或「+建群」创建群聊。');
    saveState();
    return ok(res, { ok: true, user: { name: n, color: state.users[n].color }, token: newToken(n) });
  }

  if (p === '/api/login') {
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const n = sanName(b.name);
    const pw = String(b.password || '');
    const u = state.users[n];
    if (!u) return fail(res, 404, '用户不存在，请先注册');
    if (sha(u.salt + pw) !== u.hash) return fail(res, 401, '密码错误');
    return ok(res, { ok: true, user: { name: n, color: u.color }, token: newToken(n) });
  }

  if (p === '/api/logout') {
    const t = qp(req, 'token');
    if (t) delete sessions[t];
    return ok(res, { ok: true });
  }

  if (p === '/api/ping') {
    const name = auth(req);
    if (name) lastSeen[name] = now();
    return ok(res, { ok: true });
  }

  if (p === '/api/users') {
    if (!auth(req)) return fail(res, 401, '请先登录');
    const list = Object.keys(state.users).map(userDTO);
    return ok(res, { ok: true, users: list });
  }

  // ---------- 好友 ----------
  if (p === '/api/friends' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    return ok(res, {
      ok: true,
      friends: friendsOf(name).filter(function (x) { return state.users[x]; }).map(userDTO),
      requests: requestsTo(name).filter(function (x) { return state.users[x]; }).map(userDTO)
    });
  }

  if (p === '/api/friends/add') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const target = sanName(b.name);
    if (!target || target === name) return fail(res, 400, '昵称无效');
    if (!state.users[target]) return fail(res, 404, '用户不存在');
    if (isFriend(name, target)) return fail(res, 409, '你们已经是好友了');
    if (requestsTo(target).indexOf(name) >= 0) return fail(res, 409, '好友申请已发送，等待对方通过');
    if (!state.requests[target]) state.requests[target] = [];
    state.requests[target].push(name);
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/friends/accept') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const from = sanName(b.name);
    if (requestsTo(name).indexOf(from) < 0) return fail(res, 404, '没有来自该用户的好友申请');
    state.requests[name] = state.requests[name].filter(function (x) { return x !== from; });
    addFriendPair(name, from);
    addSystem(from, name + ' 通过了你的好友申请，开始聊天吧！');
    addSystem(name, '你和 ' + from + ' 已成为好友，开始聊天吧！');
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/friends/reject') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const from = sanName(b.name);
    if (state.requests[name]) state.requests[name] = state.requests[name].filter(function (x) { return x !== from; });
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/friends/remove') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    removeFriendPair(name, sanName(b.name));
    saveState();
    return ok(res, { ok: true });
  }


  // ---------- 世界房间 (账号存档 / 联机邀请) ----------
  if (p === '/api/world/rooms' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const arr = [];
    for (const id in state.worldRooms) {
      const r = state.worldRooms[id];
      if (worldRole(r, name)) arr.push(worldRoomDTO(r, name));
    }
    arr.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return ok(res, { ok: true, rooms: arr });
  }

  if (p === '/api/world/rooms/create') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const rn = sanRoomName(b.name);
    const mode = b.mode === 'coop' ? 'coop' : 'solo';
    if (!rn) return fail(res, 400, '房间名需为1-24个字符');
    let owned = 0;
    for (const id in state.worldRooms) if (state.worldRooms[id].owner === name) owned++;
    if (owned >= 20) return fail(res, 400, '每人最多创建20个房间');
    const id = worldNewId();
    const r = {
      id: id, name: rn, owner: name, mode: mode, members: [name], invites: [], inviteBy: {},
      createdAt: now(), updatedAt: now(), version: 0, saveBytes: 0, saveBy: ''
    };
    state.worldRooms[id] = r;
    saveState();
    return ok(res, { ok: true, room: worldRoomDTO(r, name) });
  }

  if (p === '/api/world/rooms/rename') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (r.owner !== name) return fail(res, 403, '只有房主可以改名');
    const rn = sanRoomName(b.name);
    if (!rn) return fail(res, 400, '房间名需为1-24个字符');
    r.name = rn; r.updatedAt = now();
    saveState();
    return ok(res, { ok: true, room: worldRoomDTO(r, name) });
  }

  if (p === '/api/world/rooms/delete') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (r.owner !== name) return fail(res, 403, '只有房主可以删除');
    try { fs.unlinkSync(worldSaveFile(r.id)); } catch (e) {}
    delete state.worldRooms[r.id];
    delete worldPresence[r.id];
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/world/rooms/invite') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (r.mode !== 'coop') return fail(res, 400, '单机房间不能邀请好友');
    if (!worldCanOpen(r, name)) return fail(res, 403, '你不在该房间');
    const to = String(b.to || '');
    if (!state.users[to]) return fail(res, 404, '对方账号不存在');
    if (to === name) return fail(res, 400, '不能邀请自己');
    if (!isFriend(name, to)) return fail(res, 403, '只能邀请通讯录好友');
    if ((r.members || []).indexOf(to) >= 0) return fail(res, 409, '对方已在房间');
    if ((r.invites || []).indexOf(to) < 0) r.invites.push(to);
    if (!r.inviteBy) r.inviteBy = {};
    r.inviteBy[to] = name;
    r.updatedAt = now();
    addSystem(to, '「' + name + '」邀请你加入世界房间「' + r.name + '」。打开世界页 → 房间 → 接受邀请。');
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/world/rooms/accept') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if ((r.invites || []).indexOf(name) < 0) return fail(res, 404, '没有待接受的邀请');
    r.invites = r.invites.filter(function (x) { return x !== name; });
    if (r.inviteBy) delete r.inviteBy[name];
    if ((r.members || []).indexOf(name) < 0) r.members.push(name);
    r.updatedAt = now();
    addSystem(r.owner, name + ' 已加入你的世界房间「' + r.name + '」');
    saveState();
    return ok(res, { ok: true, room: worldRoomDTO(r, name) });
  }

  if (p === '/api/world/rooms/reject') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    r.invites = (r.invites || []).filter(function (x) { return x !== name; });
    if (r.inviteBy) delete r.inviteBy[name];
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/world/rooms/leave') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (r.owner === name) return fail(res, 400, '房主不能退出，只能删除房间');
    r.members = (r.members || []).filter(function (x) { return x !== name; });
    r.invites = (r.invites || []).filter(function (x) { return x !== name; });
    if (r.inviteBy) delete r.inviteBy[name];
    r.updatedAt = now();
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/world/rooms/kick') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (r.owner !== name) return fail(res, 403, '只有房主可以移除成员');
    const to = String(b.to || '');
    if (to === r.owner) return fail(res, 400, '不能移除房主');
    r.members = (r.members || []).filter(function (x) { return x !== to; });
    r.invites = (r.invites || []).filter(function (x) { return x !== to; });
    if (r.inviteBy) delete r.inviteBy[to];
    r.updatedAt = now();
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/world/rooms/save' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const r = worldRoomById(String(qp(req, 'id') || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (!worldCanOpen(r, name)) return fail(res, 403, '你不在该房间');
    let save = null;
    try {
      const f = worldSaveFile(r.id);
      if (fs.existsSync(f)) save = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { return fail(res, 500, '房间存档读取失败'); }
    return ok(res, { ok: true, room: worldRoomDTO(r, name), save: save, version: r.version || 0 });
  }

  if (p === '/api/world/rooms/save' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 5 * 1024 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (!worldCanOpen(r, name)) return fail(res, 403, '你不在该房间');
    if (!b.save || typeof b.save !== 'object' || Array.isArray(b.save)) return fail(res, 400, '存档格式错误');
    let raw;
    try { raw = JSON.stringify(b.save); } catch (e) { return fail(res, 400, '存档无法序列化'); }
    if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) return fail(res, 413, '存档超过4MB');
    try { fs.writeFileSync(worldSaveFile(r.id), raw); } catch (e) { return fail(res, 500, '房间存档写入失败'); }
    r.version = (r.version || 0) + 1;
    r.saveBytes = Buffer.byteLength(raw, 'utf8');
    r.saveBy = name;
    r.updatedAt = now();
    saveState();
    return ok(res, { ok: true, version: r.version, updatedAt: r.updatedAt, saveBytes: r.saveBytes });
  }

  if (p === '/api/world/rooms/presence') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (!worldCanOpen(r, name)) return fail(res, 403, '你不在该房间');
    if (!worldPresence[r.id]) worldPresence[r.id] = {};
    worldPresence[r.id][name] = {
      at: now(),
      x: Number(b.x) || 0,
      z: Number(b.z) || 0,
      sim: Number(b.sim) || 0,
      mic: !!b.mic,
      ear: !!b.ear
    };
    lastSeen[name] = now();
    return ok(res, { ok: true, online: worldOnline(r.id), voice: worldVoice(r.id) });
  }


  // ---------- 房间语音信令 (WebRTC offer/answer/ICE, 不转发音频) ----------
  if (p === '/api/voice/send' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 512 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const to = String(b.to || '');
    const room = String(b.room || '').slice(0, 64);
    const kind = String(b.kind || '');
    if (!/^(offer|answer|ice|bye|state)$/.test(kind)) return fail(res, 400, '信令类型无效');
    if (!voiceAllowed(name, to, room)) return fail(res, 403, '不在同一语音房间');
    let raw = '';
    try { raw = JSON.stringify(b.data || {}); } catch (e) { return fail(res, 400, '信令无法序列化'); }
    if (raw.length > 200 * 1024) return fail(res, 413, '信令过大');
    if (!voiceBox[to]) voiceBox[to] = [];
    const item = { seq: ++voiceSeq, from: name, to: to, room: room, kind: kind, data: b.data || {}, time: now() };
    voiceBox[to].push(item);
    if (voiceBox[to].length > 300) voiceBox[to].splice(0, voiceBox[to].length - 300);
    lastSeen[name] = now();
    return ok(res, { ok: true, seq: item.seq });
  }

  if (p === '/api/voice/inbox' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const after = parseInt(qp(req, 'after') || '0', 10) || 0;
    const t = now();
    for (const n in voiceBox) {
      voiceBox[n] = voiceBox[n].filter(function (m) { return t - m.time < 60000; });
      if (!voiceBox[n].length) delete voiceBox[n];
    }
    const list = (voiceBox[name] || []).filter(function (m) { return m.seq > after; }).slice(-100);
    lastSeen[name] = now();
    return ok(res, { ok: true, messages: list, latest: voiceSeq });
  }


  // ---------- 世界房间实时同步（时间/汽车/方块/玩家位置） ----------
  if (p === '/api/world/rooms/sync' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let b = {};
    try { b = JSON.parse(((await readBody(req, 1024 * 1024)) || '{}').toString()); } catch (e) { return fail(res, 400, '请求格式错误'); }
    const r = worldRoomById(String(b.id || ''));
    if (!r) return fail(res, 404, '房间不存在');
    if (!worldCanOpen(r, name)) return fail(res, 403, '你不在该房间');
    let st = worldSync[r.id];
    if (!st) st = worldSync[r.id] = { seq: 0, events: [], players: {}, sim: null, speed: null, region: null, host: r.owner };
    const t = now();
    const p = b.player;
    if (p && typeof p === 'object') {
      st.players[name] = {
        name: name,
        x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0,
        yaw: Number(p.yaw) || 0, pitch: Number(p.pitch) || 0,
        anim: String(p.anim || 'idle').slice(0, 12),
        theme: String(p.theme || 'kuro').slice(0, 12),
        at: t
      };
    }
    const incoming = Array.isArray(b.events) ? b.events.slice(0, 80) : [];
    for (let i = 0; i < incoming.length; i++) {
      const e = incoming[i];
      if (!e || typeof e !== 'object') continue;
      const typ = String(e.type || '');
      if (typ === 'block') {
        const x = Number(e.x) | 0, y = Number(e.y) | 0, z = Number(e.z) | 0, bt = Number(e.t) | 0;
        if (x < -10000 || x > 10000 || y < -64 || y > 512 || z < -10000 || z > 10000 || bt < 0 || bt > 255) continue;
        st.events.push({ seq: ++st.seq, from: name, type: 'block', x: x, y: y, z: z, t: bt, time: t });
      } else if (typ === 'build') {
        const kind = String(e.kind || '').slice(0, 16);
        if (kind !== 'hotel' && kind !== 'codes') continue;
        const item = { seq: ++st.seq, from: name, type: 'build', kind: kind, time: t };
        if (kind === 'hotel') {
          const sd = Number(e.seed);
          item.seed = isFinite(sd) ? Math.max(1, Math.min(999999, Math.floor(sd))) : 1;
        }
        if (e.codes && typeof e.codes === 'object') {
          const codes = {};
          let cn = 0;
          for (const k in e.codes) {
            if (cn++ > 40) break;
            const v = String(e.codes[k]).replace(/[^0-9]/g, '').slice(0, 6);
            if (v) codes[String(k).slice(0, 8)] = v;
          }
          item.codes = codes;
        }
        st.events.push(item);
      } else if (typ === 'give') {
        const to = String(e.to || ''), kind = (e.kind === 'craft' ? 'craft' : 'inv');
        const item = String(e.item || '').slice(0, 40), nn = Math.max(1, Math.min(999, Number(e.n) | 0));
        if (!to || to === name || !item || !nn) continue;
        if ((r.members || []).indexOf(to) < 0) continue;
        st.events.push({ seq: ++st.seq, from: name, type: 'give', to: to, kind: kind, item: item, n: nn, time: t });
      } else if (typ === 'car_add' || typ === 'car_move') {
        const car = e.car;
        if (!car || typeof car !== 'object' || !car.id) continue;
        let raw = ''; try { raw = JSON.stringify(car); } catch (err) { continue; }
        if (raw.length > 8000) continue;
        st.events.push({ seq: ++st.seq, from: name, type: typ, id: String(car.id).slice(0, 40), car: car, time: t });
      } else if (typ === 'car_del') {
        const id = String(e.id || ''); if (!id) continue;
        st.events.push({ seq: ++st.seq, from: name, type: 'car_del', id: id, time: t });
      } else if (typ === 'part_add' || typ === 'part_move') {
        const part = e.part;
        if (!part || typeof part !== 'object' || !part.id) continue;
        let raw = ''; try { raw = JSON.stringify(part); } catch (err) { continue; }
        if (raw.length > 4000) continue;
        st.events.push({ seq: ++st.seq, from: name, type: typ, id: String(part.id).slice(0, 40), part: part, time: t });
      } else if (typ === 'part_del') {
        const id = String(e.id || ''); if (!id) continue;
        st.events.push({ seq: ++st.seq, from: name, type: 'part_del', id: id, time: t });
      } else if (typ === 'bench_set') {
        const bench = e.bench;
        if (!bench || typeof bench !== 'object') continue;
        let raw = ''; try { raw = JSON.stringify(bench); } catch (err) { continue; }
        if (raw.length > 4000) continue;
        st.events.push({ seq: ++st.seq, from: name, type: 'bench_set', bench: bench, time: t });
      } else if (typ === 'bench_del') {
        st.events.push({ seq: ++st.seq, from: name, type: 'bench_del', time: t });
      }
    }
    if (st.events.length > 400) st.events.splice(0, st.events.length - 400);
    const recent = t - 60000;
    st.events = st.events.filter(function (e) { return e.time >= recent; });
    if (r.owner === name) {
      if (isFinite(Number(b.sim))) st.sim = Number(b.sim);
      if (isFinite(Number(b.speed))) st.speed = Number(b.speed);
      if (b.region) st.region = String(b.region).slice(0, 12);
    }
    const cutoff = t - 20000;
    for (const n in st.players) if (st.players[n].at < cutoff) delete st.players[n];
    const after = parseInt(b.after || '0', 10) || 0;
    const events = st.events.filter(function (e) { return e.seq > after && e.from !== name && (!e.to || e.to === name); });
    const players = [];
    for (const n in st.players) if (n !== name) players.push(st.players[n]);
    lastSeen[name] = now();
    return ok(res, {
      ok: true, seq: st.seq,
      sim: st.sim, speed: st.speed, region: st.region,
      events: events, players: players
    });
  }

  // ---------- 群聊 ----------
  if (p === '/api/groups' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const list = state.groups.filter(function (g) { return g.members.indexOf(name) >= 0; }).map(function (g) {
      return {
        id: g.id, name: g.name, admin: g.admin,
        members: g.members.filter(function (x) { return state.users[x]; }).map(userDTO)
      };
    });
    return ok(res, { ok: true, groups: list });
  }

  if (p === '/api/groups/create') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const gname = String(b.name || '').trim().slice(0, 20);
    const members = (b.members || []).filter(function (x) { return x; }).slice(0, 30);
    if (!gname) return fail(res, 400, '群名称不能为空');
    if (members.length < 1) return fail(res, 400, '请选择至少1位群成员');
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (m === name) return fail(res, 400, '群成员不能包含自己');
      if (!state.users[m]) return fail(res, 404, '用户 ' + m + ' 不存在');
      if (!isFriend(name, m)) return fail(res, 403, '你和 ' + m + ' 还不是好友');
    }
    const g = { id: 'g' + crypto.randomBytes(4).toString('hex'), name: gname, admin: name, members: [name].concat(members) };
    state.groups.push(g);
    for (let i = 0; i < g.members.length; i++) {
      addSystem(g.members[i], name + ' 创建了群聊「' + gname + '」(' + g.members.length + '人)');
    }
    saveState();
    return ok(res, { ok: true, group: { id: g.id, name: g.name, admin: g.admin, members: g.members.map(userDTO) } });
  }

  if (p === '/api/groups/add') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const g = groupById(b.id);
    if (!g) return fail(res, 404, '群聊不存在');
    if (g.admin !== name) return fail(res, 403, '只有群主可以拉人');
    const t = sanName(b.name);
    if (!state.users[t]) return fail(res, 404, '用户不存在');
    if (g.members.indexOf(t) >= 0) return fail(res, 409, '该用户已在群中');
    if (!isFriend(name, t)) return fail(res, 403, '你们还不是好友');
    g.members.push(t);
    addSystem(t, name + ' 把你拉进了群聊「' + g.name + '」');
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/groups/leave') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const g = groupById(b.id);
    if (!g) return fail(res, 404, '群聊不存在');
    g.members = g.members.filter(function (x) { return x !== name; });
    if (g.members.length === 0) { state.groups = state.groups.filter(function (x) { return x.id !== g.id; }); }
    else if (g.admin === name) { g.admin = g.members[0]; addSystem(g.members[0], '你已成为群「' + g.name + '」的新群主'); }
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/groups/kick') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const g = groupById(b.id);
    if (!g) return fail(res, 404, '群聊不存在');
    if (g.admin !== name) return fail(res, 403, '只有群主可以踢人');
    const t = sanName(b.name);
    g.members = g.members.filter(function (x) { return x !== t; });
    addSystem(t, '你被移出了群聊「' + g.name + '」');
    saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/groups/dismiss') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const g = groupById(b.id);
    if (!g) return fail(res, 404, '群聊不存在');
    if (g.admin !== name) return fail(res, 403, '只有群主可以解散群');
    for (let i = 0; i < g.members.length; i++) addSystem(g.members[i], '群聊「' + g.name + '」已被解散');
    state.groups = state.groups.filter(function (x) { return x.id !== g.id; });
    saveState();
    return ok(res, { ok: true });
  }

  // ---------- 消息 ----------
  if (p === '/api/messages' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const after = parseInt(qp(req, 'after') || '0', 10) || 0;
    let changed = false;
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i];
      if (m.from === name || m.type === 'system') continue;
      if (canSee(m, name)) {
        if (!m.deliveredTo) m.deliveredTo = [];
        if (m.deliveredTo.indexOf(name) < 0) { m.deliveredTo.push(name); changed = true; }
      }
    }
    const clearMap = (state.cleared && state.cleared[name]) || {};
    const convKey = function (m) {
      if (m.to && m.to.indexOf('g:') === 0) return m.to;
      return m.from === name ? m.to : m.from;
    };
    const vis = state.messages.filter(function (m) {
      return canSee(m, name) && m.id > (clearMap[convKey(m)] || 0);
    });
    const list = after > 0 ? vis.filter(function (m) { return m.id > after; }) : vis.slice(-200);
    const updates = [];
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i];
      if (m.type === 'system') continue;
      if (m.from === name) updates.push({ id: m.id, from: m.from, recalled: m.recalled, deliveredTo: m.deliveredTo, readBy: m.readBy });
      else if (canSee(m, name) && m.recalled) updates.push({ id: m.id, from: m.from, recalled: true });
    }
    if (changed) saveState();
    return ok(res, { ok: true, messages: list, latestId: state.nextId - 1, updates: updates });
  }

  if (p === '/api/messages' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    let text = String(b.text || '').trim();
    let to = String(b.to || '').trim();
    if (!text) return fail(res, 400, '消息不能为空');
    if (text.length > 8000) text = text.slice(0, 8000);
    if (!to || to === name) return fail(res, 400, '收件人无效');
    const g = groupById(to);
    if (g) {
      if (g.members.indexOf(name) < 0) return fail(res, 403, '你已不在该群聊中');
      to = 'g:' + g.id;
    } else if (to.indexOf('g:') === 0) {
      return fail(res, 404, '群聊不存在');
    } else {
      if (!state.users[to]) return fail(res, 404, '用户不存在');
      if (!isFriend(name, to)) return fail(res, 403, '你们还不是好友，请先添加好友');
    }
    const m = addMsg(name, to, 'text', text);
    saveState();
    return ok(res, { ok: true, message: m });
  }

  // 清空聊天记录(只影响自己这一侧)
  if (p === '/api/messages/clear' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    let to = String(b.to || '').trim();
    if (!to) return fail(res, 400, '参数错误');
    const g = groupById(to.indexOf('g:') === 0 ? to.slice(2) : to);
    if (g) to = 'g:' + g.id;
    else if (to.indexOf('g:') === 0) return fail(res, 404, '群聊不存在');
    else if (!state.users[to]) return fail(res, 404, '用户不存在');
    if (!state.cleared) state.cleared = {};
    if (!state.cleared[name]) state.cleared[name] = {};
    state.cleared[name][to] = state.nextId;
    saveState();
    return ok(res, { ok: true, clearedTo: state.nextId });
  }

  // 投诉 / 反馈
  if (p === '/api/report' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const rec = {
      id: crypto.randomBytes(6).toString('hex'),
      from: name,
      to: String(b.to || '').slice(0, 80),
      reason: String(b.reason || '').slice(0, 60),
      text: String(b.text || '').slice(0, 2000),
      time: now()
    };
    if (!state.reports) state.reports = [];
    state.reports.push(rec);
    if (state.reports.length > 1000) state.reports.splice(0, state.reports.length - 1000);
    saveState();
    console.log('REPORT ' + JSON.stringify(rec));
    return ok(res, { ok: true, id: rec.id });
  }

  // ---------- 火影帧同步(lockstep): 服务器只收集/打包/广播双方输入, 不做战斗模拟 ----------
  if (p === '/api/nrfs/start' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const rid = String(b.room || '').slice(0, 48);
    if (!rid) return fail(res, 400, '房间号无效');
    const t0 = Date.now() - 1800000;
    for (const k in fsRooms) { if (fsRooms[k].lastT < t0) delete fsRooms[k]; } // 半小时无人访问清理
    let r = fsRooms[rid];
    if (!r) r = fsRooms[rid] = { a: '', b: '', frames: {}, next: 0, lastT: Date.now() };
    r.lastT = Date.now();
    if (r.a === name) return ok(res, { ok: true, host: true, next: r.next });
    if (r.b === name) return ok(res, { ok: true, host: false, next: r.next });
    if (!r.a) { r.a = name; return ok(res, { ok: true, host: true, next: r.next }); }
    if (!r.b) { r.b = name; return ok(res, { ok: true, host: false, next: r.next }); }
    return fail(res, 409, '房间已满');
  }

  if (p === '/api/nrfs/input' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const r = fsRooms[String(b.room || '')];
    if (!r) return fail(res, 404, '房间不存在');
    if (r.a !== name && r.b !== name) return fail(res, 403, '不在房间中');
    const n = parseInt(b.frame, 10);
    if (!isFinite(n) || n < 0 || n < r.next - 400) return fail(res, 400, '帧号无效');
    const side = r.a === name ? 'a' : 'b';
    const f = r.frames[n] || (r.frames[n] = { n, a: null, b: null, ts: Date.now() });
    if (f[side] !== null) return fail(res, 409, '该帧输入已锁定');
    f[side] = b.input || {};
    // 写入时原子锁定: 单侧迟到超时立即盖章空输入, 所有读者看到同一真相
    if (Date.now() - f.ts > 200) {
      if (f.a === null) f.a = {};
      if (f.b === null) f.b = {};
    }
    if (n >= r.next) r.next = n + 1;
    r.lastT = Date.now();
    return ok(res, { ok: true });
  }

  if (p === '/api/nrfs/frames' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const r = fsRooms[qp(req, 'room') || ''];
    if (!r || (r.a !== name && r.b !== name)) return fail(res, 404, '房间不存在');
    const after = parseInt(qp(req, 'after') || '-1', 10);
    const deadline = Date.now() - 200; // 超时未到则盖章空输入(写回锁定), 迟到写入已被409拒收 → 所有读者同一真相
    const out = [];
    for (let n = after + 1; n < r.next && out.length < 240; n++) {
      const f = r.frames[n];
      if (!f) continue;
      const a = f.a !== null ? f.a : (f.ts < deadline ? (f.a = {}) : null);
      const b = f.b !== null ? f.b : (f.ts < deadline ? (f.b = {}) : null);
      if (a === null || b === null) break; // 未齐且未超时: 后续帧也不回
      out.push({ n, a: f.a, b: f.b });
    }
    const keepFrom = r.next - 500;
    for (const k in r.frames) { if (parseInt(k, 10) < keepFrom) delete r.frames[k]; }
    return ok(res, { ok: true, next: r.next, frames: out });
  }

  // ---------- 语音/视频通话信令 ----------
  if (p === '/api/call/config' && req.method === 'GET') {
    return ok(res, {
      ok: true,
      ice: iceServers(),
      tls: httpsStarted,
      httpsPort: HTTPS_PORT,
      secure: httpsStarted
    });
  }

  if (p === '/api/call/signal' && req.method === 'POST') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const to = sanName(b.to);
    const type = String(b.type || '');
    if (!to || !state.users[to]) return fail(res, 404, '用户不存在');
    if (to === name) return fail(res, 400, '不能呼叫自己');
    if (!isFriend(name, to)) return fail(res, 403, '只能给好友通话');
    if (['invite', 'answer', 'ice', 'hangup', 'reject', 'busy', 'cancel'].indexOf(type) < 0) return fail(res, 400, '信令类型无效');
    const item = pushCall(to, {
      from: name,
      type: type,
      media: b.media === 'video' ? 'video' : 'audio',
      callId: String(b.callId || '').slice(0, 48),
      sdp: b.sdp || null,
      cand: b.cand || null
    });
    return ok(res, { ok: true, seq: item.seq });
  }

  if (p === '/api/call/inbox' && req.method === 'GET') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const since = parseInt(qp(req, 'since') || '0', 10) || 0;
    const t0 = now() - 180000;
    let box = (callBox[name] || []).filter(function (x) { return x.time > t0; });
    callBox[name] = box;
    const list = box.filter(function (x) { return x.seq > since; }).slice(0, 80);
    return ok(res, { ok: true, seq: callSeq, messages: list });
  }

  // ---------- 文件 ----------
  if (p === '/api/upload') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    let to = String(qp(req, 'to') || '').trim();
    const fname = String(qp(req, 'name') || 'file').trim().slice(0, 200);
    const mime = qp(req, 'mime') || 'application/octet-stream';
    const data = await readBody(req, 30 * 1024 * 1024);
    if (!data) return fail(res, 413, '文件不能超过30MB');
    if (data.length === 0) return fail(res, 400, '文件为空');
    const g = groupById(to);
    if (g) {
      if (g.members.indexOf(name) < 0) return fail(res, 403, '你已不在该群聊中');
      to = 'g:' + g.id;
    } else if (to.indexOf('g:') === 0) {
      return fail(res, 404, '群聊不存在');
    } else {
      if (!state.users[to]) return fail(res, 404, '收件人不存在');
      if (!isFriend(name, to)) return fail(res, 403, '你们还不是好友，请先添加好友');
    }
    const fid = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(FILESDIR, fid + '.bin'), data);
    const kind = String(qp(req, 'kind') || '');
    if (kind === 'voice') {
      const dur = Math.max(0, Math.min(120, parseFloat(qp(req, 'dur') || '0') || 0));
      const vtext = String(qp(req, 'text') || '').slice(0, 2000);
      const m = addMsg(name, to, 'voice', '', {
        fileId: fid, fileName: fname || 'voice', fileSize: data.length, mime: mime || 'audio/webm',
        dur: Math.round(dur * 10) / 10, transcript: vtext
      });
      saveState();
      return ok(res, { ok: true, message: m });
    }
    const m = addMsg(name, to, mime.indexOf('image/') === 0 ? 'image' : 'file', '', {
      fileId: fid, fileName: fname, fileSize: data.length, mime: mime
    });
    saveState();
    return ok(res, { ok: true, message: m });
  }

  if (p === '/api/file') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const fid = qp(req, 'id');
    let m = null;
    for (let i = 0; i < state.messages.length; i++) if (state.messages[i].fileId === fid) { m = state.messages[i]; break; }
    if (!m) return fail(res, 404, '文件不存在');
    if (m.to.indexOf('g:') === 0) {
      if (!inGroup(name, m.to)) return fail(res, 403, '无权访问该文件');
    } else if (m.to !== name && m.from !== name) {
      return fail(res, 403, '无权访问该文件');
    }
    try {
      const b = fs.readFileSync(path.join(FILESDIR, fid + '.bin'));
      cors(res);
      res.writeHead(200, {
        'Content-Type': m.mime || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(m.fileName)
      });
      res.end(b);
    } catch (e) { fail(res, 404, '文件已被删除'); }
    return;
  }

  // ---------- 已读/撤回 ----------
  if (p === '/api/read') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const peer = String(b.peer || '').trim();
    const upTo = b.upToId || Number.MAX_SAFE_INTEGER;
    let changed = false;
    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i];
      if (m.id > upTo || m.type === 'system' || m.from === name) continue;
      let match;
      if (peer.indexOf('g:') === 0) match = m.to === peer && inGroup(name, peer);
      else match = m.from === peer && m.to === name;
      if (!match) continue;
      if (!m.readBy) m.readBy = [];
      if (m.readBy.indexOf(name) < 0) { m.readBy.push(name); changed = true; }
    }
    if (changed) saveState();
    return ok(res, { ok: true });
  }

  if (p === '/api/recall') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const id = b.id || 0;
    let m = null;
    for (let i = 0; i < state.messages.length; i++) if (state.messages[i].id === id) { m = state.messages[i]; break; }
    if (!m) return fail(res, 404, '消息不存在');
    if (m.from !== name) return fail(res, 403, '只能撤回自己发送的消息');
    if (m.recalled) return fail(res, 400, '该消息已撤回');
    if (now() - m.time > 120000) return fail(res, 400, '超过2分钟，无法撤回');
    m.recalled = true;
    saveState();
    return ok(res, { ok: true });
  }

  // ---------- 排行榜 ----------
  if (p === '/api/rank' && req.method === 'GET') {
    const name = auth(req);
    const arr = Object.keys(state.rank).map(function (n) {
      const R = state.rank[n];
      const total = (R.wins || 0) + (R.losses || 0);
      return { name: n, pts: R.pts, wins: R.wins, losses: R.losses, rate: total ? Math.round((R.wins || 0) * 100 / total) : 0 };
    }).sort(function (a, b) { return (b.rate - a.rate) || (b.wins - a.wins) || (b.pts - a.pts); });
    let me = null;
    if (name) {
      const R = state.rank[name];
      const total = R ? (R.wins || 0) + (R.losses || 0) : 0;
      me = R ? { name: name, pts: R.pts, wins: R.wins, losses: R.losses, rate: total ? Math.round((R.wins || 0) * 100 / total) : 0 }
             : { name: name, pts: 0, wins: 0, losses: 0, rate: 0 };
    }
    return ok(res, { ok: true, top: arr.slice(0, 30), me: me });
  }

  if (p === '/api/rank/report') {
    const name = auth(req);
    if (!name) return fail(res, 401, '请先登录');
    const b = JSON.parse(((await readBody(req)) || '{}').toString());
    const win = !!b.win;
    if (!state.rank[name]) state.rank[name] = { pts: 1000, wins: 0, losses: 0 };
    const r = state.rank[name];
    if (win) { r.wins++; r.pts += 25; }
    else { r.losses++; r.pts = Math.max(0, r.pts - 15); }
    saveState();
    const total = r.wins + r.losses;
    return ok(res, { ok: true, rank: { pts: r.pts, wins: r.wins, losses: r.losses, rate: total ? Math.round(r.wins * 100 / total) : 0 } });
  }

  fail(res, 404, '未知接口: ' + p);
}

// ---------- 通话信令 (WebRTC: 服务器只转发 SDP/ICE) ----------
const callBox = {};   // name -> [{seq,from,type,media,callId,sdp,cand,time}]
let callSeq = 0;
function pushCall(to, obj) {
  if (!callBox[to]) callBox[to] = [];
  const item = Object.assign({ seq: ++callSeq, time: now() }, obj);
  callBox[to].push(item);
  if (callBox[to].length > 200) callBox[to].splice(0, callBox[to].length - 200);
  return item;
}
function iceServers() {
  const list = [
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  const turn = args.turn || process.env.TURN_URL || '';
  if (turn) {
    list.push({
      urls: turn,
      username: args['turn-user'] || process.env.TURN_USER || '',
      credential: args['turn-pass'] || process.env.TURN_PASS || ''
    });
  }
  return list;
}
let httpsStarted = false;

const server = http.createServer(handle);
server.listen(PORT, '0.0.0.0', function () {
  console.log('NarutoCloud v3.6.1 listening on http://0.0.0.0:' + PORT + ' datadir=' + DATADIR);
});

// 自签名证书: 首次访问需在浏览器里点“高级 → 继续前往”
try {
  const certFile = args.cert || path.join(__dirname, 'cert.pem');
  const keyFile = args.key || path.join(__dirname, 'key.pem');
  const pfxFile = args.pfx || process.env.HTTPS_PFX || path.join(__dirname, 'cert.pfx');
  let tlsOpts = null;
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    tlsOpts = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } else if (fs.existsSync(pfxFile)) {
    tlsOpts = { pfx: fs.readFileSync(pfxFile), passphrase: args['pfx-pass'] || process.env.HTTPS_PFX_PASS || '' };
  }
  if (tlsOpts) {
    https.createServer(tlsOpts, handle)
      .listen(HTTPS_PORT, '0.0.0.0', function () {
        httpsStarted = true;
        console.log('HTTPS (麦克风/摄像头可用) on https://0.0.0.0:' + HTTPS_PORT);
      })
      .on('error', function (e) { console.log('HTTPS 启动失败: ' + e.message); });
  } else {
    console.log('未找到证书 (cert.pem/key.pem 或 cert.pfx), 仅提供 HTTP (语音消息/通话不可用)');
  }
} catch (e) { console.log('HTTPS 启动异常: ' + e.message); }

