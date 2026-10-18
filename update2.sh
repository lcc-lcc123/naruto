#!/bin/bash
# 云服务器更新 v2: 从 GitHub Pages 逐个下载更新文件(免解压, 单文件均小于25MB)
BASE=https://lcc-lcc123.github.io/naruto
cd "$(dirname "$0")"
mkdir -p bgm voice
echo "== 下载程序文件 =="
for f in server.js naruto.html mobile.html portal.html; do
  curl -sL --max-time 120 -o "$f" "$BASE/$f" && echo "ok  $f" || echo "fail $f"
done
echo "== 下载BGM(8首) =="
for i in 1 2 3 4 5 6 7 8; do
  curl -sL --max-time 300 -o "bgm/bgm$i.mp3" "$BASE/bgm/bgm$i.mp3" && echo "ok  bgm$i.mp3" || echo "fail bgm$i.mp3"
done
echo "== 下载配音(6句) =="
rm -f voice/naruto_stl.mp3 voice/naruto_atk3.mp3 voice/sasuke_stl.mp3 voice/sasuke_atk3.mp3
for f in naruto_s1 naruto_s2 naruto_ult sasuke_s1 sasuke_s2 sasuke_ult; do
  curl -sL --max-time 120 -o "voice/$f.mp3" "$BASE/voice/$f.mp3" && echo "ok  $f" || echo "fail $f"
done
echo "== 重启服务 =="
systemctl restart naruto-srv
sleep 1
IP=$(curl -s --max-time 8 ifconfig.me || echo "服务器公网IP")
echo ""
echo "更新完成! 游戏: http://$IP:3777/game"
