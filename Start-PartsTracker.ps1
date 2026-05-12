if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "npm was not found. Install Node.js LTS from https://nodejs.org/ first."
  exit 1
}

if (-not (Test-Path "node_modules")) {
  npm.cmd install
}

npm.cmd run dev
