#!/bin/bash
# 云服务器更新 v2: 从 GitHub Pages 逐个下载更新文件(免解压, 单文件均小于25MB)
BASE=https://lcc-lcc123.github.io/naruto
TS=$(date +%s)   # 时间戳: 绕过 GitHub Pages CDN 缓存
cd /home/admin/naruto-srv   # 固定服务目录 (不能用 ~, sudo 下 $HOME 是 /root)
mkdir -p bgm voice
echo "== 下载程序文件 =="
for f in server.js naruto.html mobile.html portal.html; do
  curl -fsSL --max-time 120 -o "$f" "$BASE/$f?t=$TS" && echo "ok  $f" || echo "fail $f"
done
echo "== 下载BGM(8首) =="
for i in 1 2 3 4 5 6 7 8; do
  curl -fsSL --max-time 300 -o "bgm/bgm$i.mp3" "$BASE/bgm/bgm$i.mp3?t=$TS" && echo "ok  bgm$i.mp3" || echo "fail bgm$i.mp3"
done
echo "== 下载配音(6句) =="
rm -f voice/naruto_stl.mp3 voice/naruto_atk3.mp3 voice/sasuke_stl.mp3 voice/sasuke_atk3.mp3 voice/naruto_s1.mp3 voice/naruto_s2.mp3
for f in naruto_s1.m4a naruto_s2.m4a naruto_ult.mp3 sasuke_s1.mp3 sasuke_s2.mp3 sasuke_ult.mp3; do
  curl -fsSL --max-time 120 -o "voice/$f" "$BASE/voice/$f?t=$TS" && echo "ok  $f" || echo "fail $f"
done
echo "== 下载胜利奥义视频(7个) =="
mkdir -p video
for f in naruto_win1 naruto_win2 naruto_win3 naruto_win4 sasuke_win1 sasuke_win2 sasuke_win3; do
  curl -fsSL --max-time 300 -o "video/$f.mp4" "$BASE/video/$f.mp4?t=$TS" && echo "ok  $f.mp4" || echo "fail $f.mp4"
done
echo "== HTTPS 证书(语音消息/语音通话/视频通话需要) =="
if [ ! -f cert.pem ] || [ ! -f key.pem ]; then
  if command -v openssl >/dev/null 2>&1; then
    IP=$(curl -s --max-time 8 ifconfig.me || echo "101.200.171.33")
    openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
      -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" >/dev/null 2>&1 \
      && echo "ok  cert.pem (CN=$IP)" || echo "fail 证书生成"
  else
    echo "skip 未安装 openssl, 无法启用 HTTPS"
  fi
else
  echo "ok  cert.pem 已存在"
fi
echo "== 重启服务 =="
systemctl restart naruto-srv
sleep 1
IP=$(curl -s --max-time 8 ifconfig.me || echo "服务器公网IP")
echo ""
echo "更新完成! 游戏: http://$IP:3777/game"
echo "聊天: http://$IP:3777/m   (语音/通话请用 https://$IP:3778/m , 首次需点“高级→继续前往”)"
