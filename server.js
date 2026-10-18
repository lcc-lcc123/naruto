// 极简云服务端 v3.2.0 (Node.js 零依赖)
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
try { fs.mkdirSync(FILESDIR, { recursive: true }); } catch (e) {}

// ---------- 状态 ----------
const state = { users: {}, friends: {}, requests: {}, groups: [], messages: [], nextId: 1, rank: {} };
const fsRooms = {};   // 火影帧同步房间: id -> {a,b,frames:{},next}
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
  if (p === '/api/status') { ok(res, { ok: true, app: '极简聊天云服务端', version: '3.2.0' }); return; }

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
    const vis = state.messages.filter(function (m) { return canSee(m, name); });
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
  console.log('NarutoCloud v3.2.0 listening on http://0.0.0.0:' + PORT + ' datadir=' + DATADIR);
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

