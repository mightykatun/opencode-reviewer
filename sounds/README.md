# Notification sounds

I supply `attention.mp3`, `unsafe.mp3`, `question.mp3`,
`approved.mp3`, `error.mp3`, and `ended.mp3` for redistribution with this plugin. 
Playback decoding and RMS/peak normalization are performed by the plugin, including for custom MP3/WAV files.
Every sound uses the same -20 dBFS RMS target and -3 dBFS peak ceiling.
`scripts/build.mjs` embeds these six assets in `dist/tui.js`. No runtime sound
downloads or separately installed MP3 decoder are required.
You might recognize some of those sounds;)
