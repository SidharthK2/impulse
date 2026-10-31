#!/usr/bin/env bash
# Downloads UwU mode's media into web/public/uwu/ (gitignored). Internal demo only: the Anya Forger art and the
# anime voice clips are copyrighted, so they stay out of git and out of any deploy (CI never has them). The
# music is CC0 (OpenGameArt). Without these files the app falls back to the SVG mascot and synthesized sounds.
set -euo pipefail
cd "$(dirname "$0")/../public"
mkdir -p uwu/anya uwu/voice uwu/music
# The voice set is renumbered when it changes, so always fetch it fresh (overwriting, never deleting).
refresh() { curl -fsSL -A "$UA" -e "$(echo "$1" | cut -d/ -f1-3)/" -o "$2" "$1" && echo "  $2"; }
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
# Asleep: Anya nodding off (Tenor "anya-spy-x-family-sleepy-drowsy-falling-asleep"), as a small looping video.
get https://media.tenor.com/-yFcDy-4T8wAAAPo/anya-spy-x-family.mp4 uwu/anya/asleep.mp4
# The app shows the sprites as WebP, 330px tall (about twice their 150px on screen): a tenth of the PNGs' size, and
# quick to decode when she switches pose. Needs cwebp (brew install webp).
if command -v cwebp >/dev/null; then
  for f in uwu/anya/*.png; do
    w="${f%.png}.webp"
    [ -s "$w" ] || { cwebp -quiet -q 85 -alpha_q 100 -m 6 -resize 0 330 "$f" -o "$w" && echo "  $w"; }
  done
else
  echo "cwebp not found (brew install webp): no WebP sprites, so Anya shows as Pulse-chan" >&2
fi
# Classic anime-girl sound bites (nya, kyaa, sugoi, baka, giggles). Loudness varies wildly between them;
# audio.ts levels each one in the browser and trims long ones.
MI=https://www.myinstants.com/media/sounds
refresh $MI/tuturu_1.mp3 uwu/voice/greet-1.mp3
refresh $MI/konnichiwa.mp3 uwu/voice/greet-2.mp3
refresh $MI/yatta-edited.mp3 uwu/voice/win-1.mp3
refresh $MI/yui-hirasawa-yahooo.mp3 uwu/voice/win-2.mp3
refresh $MI/sugoi-sugoi.mp3 uwu/voice/win-3.mp3
refresh $MI/video-1423104022.mp3 uwu/voice/win-4.mp3
refresh $MI/wow-anime-voice-accent.mp3 uwu/voice/win-5.mp3
refresh $MI/anime-girl-crying.mp3 uwu/voice/lose-1.mp3
refresh $MI/ehhh-cute-anime-voice-magicalmysticva.mp3 uwu/voice/lose-2.mp3
refresh $MI/baka-cirno.mp3 uwu/voice/lose-3.mp3
refresh $MI/nani_mkANQUf.mp3 uwu/voice/warn-1.mp3
refresh $MI/uchu-3-kyaaa-u_uEh1bWw.mp3 uwu/voice/warn-2.mp3
refresh $MI/woah-cute-anime-voice-magicalmysticva.mp3 uwu/voice/warn-3.mp3
refresh $MI/ah-cute-anime-voice-sound-effect.mp3 uwu/voice/info-1.mp3
refresh $MI/uwu-anime-sound.mp3 uwu/voice/info-2.mp3
# Clicking Anya: her own lines from Spy x Family.
refresh $MI/sxf-anya-waku-waku.mp3 uwu/voice/anya-1.mp3
refresh $MI/spy-mission-waku-waku.mp3 uwu/voice/anya-2.mp3
refresh $MI/anya-likes-peanuts.mp3 uwu/voice/anya-3.mp3
refresh $MI/anya-hi-honey.mp3 uwu/voice/anya-4.mp3
refresh $MI/anya-okeydoke.mp3 uwu/voice/anya-5.mp3
refresh $MI/anya_4gzso24.mp3 uwu/voice/anya-6.mp3
refresh $MI/voice_sys_gacha_arn_05.mp3 uwu/voice/anya-7.mp3
refresh $MI/anya-pistol-with-a.mp3 uwu/voice/anya-8.mp3
refresh $MI/giggle_XuDecHl.mp3 uwu/voice/idle-1.mp3
refresh $MI/nyaaa.mp3 uwu/voice/idle-2.mp3
refresh $MI/uwu-anime-sound.mp3 uwu/voice/idle-3.mp3
OGA=https://opengameart.org/sites/default/files
get $OGA/audio_preview/frivolous_chiptune_1.ogg.mp3 uwu/music/frivolous.mp3 # "frivolous chiptune", Spring Spring, CC0
get $OGA/chiploop_0.mp3 uwu/music/chiploop.mp3                             # "chiploop", iamoneabe, CC0
echo "UwU assets ready in web/public/uwu"
