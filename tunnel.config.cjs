module.exports = {
  apps: [{
    name: 'jrb-tunnel',
    script: 'C:\\Users\\Assistant\\scoop\\shims\\cloudflared.exe',
    args: 'tunnel run jrb-agent',
    interpreter: 'none',
    autorestart: true,
    watch: false,
  }]
}
