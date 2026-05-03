const { spawn } = require('child_process');
const proc = spawn('powershell.exe', [
  '-ExecutionPolicy', 'Bypass',
  '-File', 'C:\\Users\\Assistant\\JRBAgent\\agent\\launcher\\start-agent.ps1',
  'teams'
], { stdio: 'inherit' });
proc.on('exit', code => process.exit(code));
