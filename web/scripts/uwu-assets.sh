#!/usr/bin/env bash
# Downloads UwU mode's media into web/public/uwu/ (gitignored). Internal demo only: the Anya Forger art and voice
# clips are copyrighted (Spy x Family), so they stay out of git and out of any deploy (CI never has them). The
# music is CC0 (OpenGameArt). Without these files the app falls back to the SVG mascot and synthesized sounds.
set -euo pipefail
cd "$(dirname "$0")/../public"
mkdir -p uwu/anya uwu/voice uwu/music
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
get() { # url dest
  [ -s "$2" ] && return 0
  curl -fsSL -A "$UA" -e "$(echo "$1" | cut -d/ -f1-3)/" -o "$2" "$1" && echo "  $2"
}
PM=https://www.pngmart.com/files/23
get $PM/Anya-Forger-PNG-Free-Download.png uwu/anya/idle.png
get $PM/Anya-Forger-PNG-Photos.png uwu/anya/happy.png
get $PM/Anya-Forger-PNG-Pic.png uwu/anya/sad.png
get $PM/Anya-Forger-PNG-HD.png uwu/anya/shock.png
get $PM/Anya-Forger-Transparent-PNG.png uwu/anya/poke.png
get $PM/Anya-Forger-PNG-Isolated-File.png uwu/anya/smug.png
get $PM/Anya-Forger-PNG-Isolated-Image.png uwu/anya/sleepy.png
MI=https://www.myinstants.com/media/sounds
get $MI/sxf-anya-waku-waku.mp3 uwu/voice/win-1.mp3
get $MI/anya-okeydoke.mp3 uwu/voice/win-2.mp3
get $MI/anime-girl-sad.mp3 uwu/voice/lose-1.mp3
get $MI/anya_4gzso24.mp3 uwu/voice/warn-1.mp3
get $MI/voice_sys_gacha_arn_03.mp3 uwu/voice/info-1.mp3
get $MI/voice_sys_gacha_arn_05.mp3 uwu/voice/poke-1.mp3
get $MI/anya-hi-honey.mp3 uwu/voice/poke-2.mp3
get $MI/anya-likes-peanuts.mp3 uwu/voice/poke-3.mp3
OGA=https://opengameart.org/sites/default/files
get $OGA/audio_preview/frivolous_chiptune_1.ogg.mp3 uwu/music/frivolous.mp3 # "frivolous chiptune", Spring Spring, CC0
get $OGA/chiploop_0.mp3 uwu/music/chiploop.mp3                             # "chiploop", iamoneabe, CC0
echo "UwU assets ready in web/public/uwu"
