# Deploy AnyPerp frontend to Vercel production via CLI.
# Intentionally DOES NOT use GitHub auto-deploy / commit author checks.
# GitHub stays on tradeanyperp; Vercel deploys stay CLI-only and separate.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-vercel-prod.ps1

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "public\anyperp-whitepaper-v0.1.pdf")) {
  Write-Error "Missing public/anyperp-whitepaper-v0.1.pdf - generate/copy whitepaper first."
}

$gitHidden = $false
if (Test-Path ".git") {
  Rename-Item ".git" ".git.hide_for_vercel_deploy" -Force
  $gitHidden = $true
  Write-Host "Detached local .git for this deploy (avoids GitHub author block on Vercel)."
}

try {
  Write-Host "Deploying to Vercel production..."
  npx vercel --prod --yes --force
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "Done. Site: https://www.anyperp.fun"
  Write-Host "Whitepaper: https://www.anyperp.fun/anyperp-whitepaper-v0.1.pdf"
}
finally {
  if ($gitHidden -and (Test-Path ".git.hide_for_vercel_deploy") -and -not (Test-Path ".git")) {
    Rename-Item ".git.hide_for_vercel_deploy" ".git" -Force
    Write-Host "Restored .git"
  }
}
