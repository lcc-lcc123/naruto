#!/bin/bash
# 云服务器更新 v3
# 规则：
#   1) 程序文件（server.js / *.html）每次下载到临时文件，按内容判断是否变化；
#   2) BGM / 配音 / 视频先 HEAD 比较文件大小，未变化直接跳过，不再重复下载；
#   3) 所有下载先写 .part，大小校验通过后才替换旧文件；失败不会破坏旧文件；
#   4) 只有 server.js 或 HTTPS 证书变化时才重启服务。
# 强制全部重下：FORCE=1 sudo bash update2.sh

BASE="${BASE:-https://lcc-lcc123.github.io/naruto}"
TS=$(date +%s)   # 绕过 GitHub Pages CDN 缓存
cd "${TARGET_DIR:-/home/admin/naruto-srv}" || exit 1
FORCE="${FORCE:-0}"

PROGRAMS="server.js naruto.html mobile.html portal.html world.html"
BGM_LIST="1 2 3 4 5 6 7 8"
VOICE_LIST="naruto_s1.m4a naruto_s2.m4a naruto_ult.mp3 sasuke_s1.mp3 sasuke_s2.mp3 sasuke_ult.mp3"
VIDEO_LIST="naruto_win1 naruto_win2 naruto_win3 naruto_win4 sasuke_win1 sasuke_win2 sasuke_win3"

DL=0
SKIP=0
FAIL=0
CHANGED=0
RESTART=0

fetch() {
  if [ -t 1 ]; then
    curl -fL --progress-bar -S "$@"
  else
    curl -fL -sS "$@"
  fi
}

size_of() {
  stat -c %s "$1" 2>/dev/null || echo -1
}

remote_size() {
  local url="$1" hdr len
  hdr=$(curl -fsSIL --connect-timeout 15 --max-time 40 -H 'Cache-Control: no-cache' "$url?t=$TS" 2>/dev/null) || return 1
  len=$(printf '%s\n' "$hdr" | tr -d '\r' | grep -i '^content-length:' | tail -n 1 | cut -d' ' -f2 | tr -d ' ')
  [ -n "$len" ] || return 1
  printf '%s' "$len"
}

download() {
  local rel="$1" url="$2" want="$3" tmo="${4:-900}"
  local tmp="$rel.part" rc=0 ok=0 try tsize
  mkdir -p "$(dirname "$rel")" || return 1
  rm -f "$tmp"

  for try in 1 2 3; do
    if [ -f "$tmp" ]; then
      fetch --connect-timeout 20 --max-time "$tmo" --retry 2 --retry-delay 2 --speed-limit 1024 --speed-time 60 -C - -o "$tmp" "$url?t=$TS"
      rc=$?
    else
      fetch --connect-timeout 20 --max-time "$tmo" --retry 2 --retry-delay 2 --speed-limit 1024 --speed-time 60 -o "$tmp" "$url?t=$TS"
      rc=$?
    fi

    if [ "$rc" -eq 0 ]; then ok=1; break; fi

    # 有些情况下文件其实已经下完，但 curl 因范围请求返回非 0
    if [ "$want" != "-1" ]; then
      tsize=$(size_of "$tmp")
      if [ "$tsize" = "$want" ]; then ok=1; break; fi
    fi

    # 服务器不支持断点续传时，清掉临时文件，下一次从头下载
    if [ "$rc" -eq 33 ]; then rm -f "$tmp"; fi
    echo "   retry $rel（第 $try/3 次，curl=$rc）"
    sleep 2
  done

  if [ "$ok" -ne 1 ]; then
    echo "fail $rel（旧文件保留，未完成文件：$tmp）"
    return 1
  fi

  tsize=$(size_of "$tmp")
  if [ "$want" != "-1" ] && [ "$tsize" != "$want" ]; then
    echo "fail $rel（大小 $tsize != 远程 $want，旧文件保留）"
    return 1
  fi

  mv -f "$tmp" "$rel" || return 1
  echo "ok   $rel（$tsize B）"
  return 0
}

program_file() {
  local rel="$1" old_sum new_sum
  old_sum=$(md5sum "$rel" 2>/dev/null | awk '{print $1}')
  if ! download "$rel" "$BASE/$rel" -1 300; then
    FAIL=$((FAIL + 1))
    return 1
  fi
  new_sum=$(md5sum "$rel" 2>/dev/null | awk '{print $1}')
  if [ -n "$old_sum" ] && [ "$old_sum" = "$new_sum" ]; then
    echo "same $rel（内容未变化）"
    return 0
  fi
  echo "upd  $rel（内容已更新）"
  CHANGED=$((CHANGED + 1))
  if [ "$rel" = "server.js" ]; then RESTART=1; fi
  return 0
}

media_file() {
  local rel="$1" lsize want
  lsize=$(size_of "$rel")
  want=-1
  if want=$(remote_size "$BASE/$rel"); then :; else want=-1; fi

  if [ "$FORCE" != "1" ] && [ "$lsize" -ge 0 ]; then
    if [ "$want" != "-1" ]; then
      if [ "$lsize" = "$want" ]; then
        echo "skip $rel（未变化 $lsize B）"
        SKIP=$((SKIP + 1))
        return 0
      fi
      echo "diff $rel（本地 $lsize B → 远程 $want B）"
    else
      echo "warn $rel（无法检查更新，保留本地 $lsize B）"
      SKIP=$((SKIP + 1))
      return 0
    fi
  fi

  if [ "$want" = "-1" ]; then
    echo "get  $rel（远程大小未知）"
  else
    echo "get  $rel（$want B）"
  fi

  if download "$rel" "$BASE/$rel" "$want" 900; then
    DL=$((DL + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

echo "== 程序文件（内容比对，5 个） =="
for f in $PROGRAMS; do
  program_file "$f"
done

echo "== BGM（大小比对，8 首） =="
for i in $BGM_LIST; do
  media_file "bgm/bgm$i.mp3"
done

echo "== 配音（大小比对，6 句） =="
rm -f voice/naruto_stl.mp3 voice/naruto_atk3.mp3 voice/sasuke_stl.mp3 voice/sasuke_atk3.mp3 voice/naruto_s1.mp3 voice/naruto_s2.mp3
for f in $VOICE_LIST; do
  media_file "voice/$f"
done

echo "== 胜利奥义视频（大小比对，7 个） =="
for f in $VIDEO_LIST; do
  media_file "video/$f.mp4"
done

echo "== HTTPS 证书（语音消息/语音通话/视频通话需要） =="
if [ ! -f cert.pem ] || [ ! -f key.pem ]; then
  if command -v openssl >/dev/null 2>&1; then
    IP0=$(curl -s --max-time 8 ifconfig.me || echo "101.200.171.33")
    if openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
      -subj "/CN=$IP0" -addext "subjectAltName=IP:$IP0" >/dev/null 2>&1; then
      echo "ok   cert.pem（CN=$IP0）"
      RESTART=1
    else
      echo "fail 证书生成"
    fi
  else
    echo "skip 未安装 openssl，无法启用 HTTPS"
  fi
else
  echo "ok   cert.pem 已存在"
fi

if [ "$RESTART" = "1" ]; then
  echo "== 重启服务（server.js 或证书有变化） =="
  systemctl restart naruto-srv
elif ! systemctl is-active --quiet naruto-srv; then
  echo "== 服务未运行，启动 =="
  systemctl restart naruto-srv
else
  echo "== 服务端程序未变化，跳过重启 =="
fi
sleep 1

IP=$(curl -s --max-time 8 ifconfig.me || echo "101.200.171.33")
echo ""
echo "完成：媒体更新 $DL 个 · 跳过 $SKIP 个 · 失败 $FAIL 个 · 程序变化 $CHANGED 个"
if [ "$FAIL" -gt 0 ]; then
  echo "提示：失败文件未覆盖旧版本；重新运行本脚本即可重试。"
fi
echo "游戏: http://$IP:3777/game"
echo "聊天: http://$IP:3777/m"
echo "世界: http://$IP:3777/world"
echo "语音/通话请用 https://$IP:3778/m（首次点 高级 -> 继续前往）"

[ "$FAIL" -eq 0 ]
