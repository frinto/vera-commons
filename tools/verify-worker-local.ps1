<#
  Verify the Cloudflare Worker in the REAL Workers runtime — locally, for $0.

  Why this exists. The Worker's 16 unit tests run against a JavaScript mock of KV.
  That proves the logic but NOT that the code runs on workerd. `wrangler dev`
  executes the actual runtime the edge uses — same request parsing, same KV binding
  semantics, same Web-API surface — with no account, no login and no deploy.

  What this still does NOT prove: multi-region replication, real KV consistency
  guarantees, or account quotas. Those need an actual deployment.

  Usage:  pwsh -File tools/verify-worker-local.ps1
  Exit:   0 = every check passed, 1 = at least one failed, 2 = runtime never came up.
#>

$ErrorActionPreference = 'Continue'
$root    = Split-Path $PSScriptRoot -Parent
$worker  = Join-Path $root 'worker'
$port    = 8787
$base    = "http://127.0.0.1:$port"
$devToml = Join-Path $worker 'wrangler.dev.toml'
$log     = Join-Path $worker 'wrangler.dev.log'
$errLog  = Join-Path $worker 'wrangler.dev.err'
# wrangler dev PERSISTS its local KV between runs. Left alone, every run adds to
# the previous run's data, so "exactly one copy exists" starts failing against
# leftovers — which is exactly what happened the moment the id assertion got
# strong enough to actually look at the store. Use a throwaway store per run, so
# the checks mean what they say and the script is re-runnable.
$persist = Join-Path $env:TEMP "commons-kv-$([guid]::NewGuid().ToString('N'))"
$script:fails = 0
$proc = $null

function Check($name, $cond, $detail) {
  if ($cond) { Write-Host "PASS $name" }
  else       { Write-Host "FAIL $name -- $detail"; $script:fails++ }
}

try {
  # A syntactically valid namespace id so wrangler accepts the config. Local dev
  # never contacts the account; the id only has to look like a real one.
  $toml = Get-Content (Join-Path $worker 'wrangler.toml') -Raw
  $toml = $toml -replace 'REPLACE_WITH_KV_NAMESPACE_ID', '0123456789abcdef0123456789abcdef'
  Set-Content -Path $devToml -Value $toml -Encoding ASCII

  foreach ($f in @($log, $errLog)) { if (Test-Path $f) { Remove-Item $f -Force } }

  Write-Host "starting the real Workers runtime (workerd) on port $port ..."
  $proc = Start-Process -FilePath 'npx.cmd' `
    -ArgumentList @('--yes', 'wrangler', 'dev', '--config', 'wrangler.dev.toml', '--port', "$port", '--persist-to', $persist) `
    -WorkingDirectory $worker -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError $errLog

  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri "$base/health" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $up = $true; break }
    } catch { }
    if ($proc.HasExited) { break }
  }

  if (-not $up) {
    Write-Host "`nFAIL: the runtime never answered on $base/health"
    Write-Host "--- stdout tail ---"; if (Test-Path $log)    { Get-Content $log    -Tail 25 }
    Write-Host "--- stderr tail ---"; if (Test-Path $errLog) { Get-Content $errLog -Tail 25 }
    exit 2
  }
  Write-Host "runtime is up.`n"

  # --- 1. the relay advertises itself --------------------------------------
  $wk = Invoke-RestMethod -Uri "$base/.well-known/agent-commons.json" -TimeoutSec 10
  Check 'discovery document is served by the real runtime' ($wk.v -eq 1 -and $wk.protocol -eq 'agent-commons/1') "got v=$($wk.v) protocol=$($wk.protocol)"
  Check 'the keyless relay claims no identity' ($null -eq $wk.identity -and $null -eq $wk.sig) "identity=$($wk.identity) sig=$($wk.sig)"
  Check 'the relay advertises its own origin' ($wk.baseUrl -like "http://127.0.0.1:$port*" -or $wk.baseUrl -like "http://localhost:$port*") "baseUrl=$($wk.baseUrl)"

  # --- 2. a genuine signed message is accepted ------------------------------
  $msgFile  = Join-Path $env:TEMP "commons-msg-$([guid]::NewGuid().ToString('N')).json"
  $feedFile = Join-Path $env:TEMP "commons-feed-$([guid]::NewGuid().ToString('N')).json"
  $id = (& node (Join-Path $root 'tools\make-message.mjs') $msgFile | Out-String).Trim()
  if (-not $id -or -not (Test-Path $msgFile)) { Write-Host 'FAIL: could not produce a signed message'; exit 1 }
  Write-Host "message id (content-addressed, computed locally): $id`n"

  $r1 = Invoke-RestMethod -Uri "$base/messages" -Method Post -ContentType 'application/json' -InFile $msgFile -TimeoutSec 15
  Check 'a real signed message is accepted by workerd' ($r1.ok -eq $true -and $r1.accepted -eq $true) "got $($r1 | ConvertTo-Json -Compress)"

  # --- 3. the SAME message replayed is suppressed ---------------------------
  # This is the fix that a Node-only mock could not prove against real KV.
  $r2 = Invoke-RestMethod -Uri "$base/messages" -Method Post -ContentType 'application/json' -InFile $msgFile -TimeoutSec 15
  Check 'a replayed message is suppressed against real KV' ($r2.ok -eq $true -and $r2.accepted -eq $false -and $r2.reason -eq 'duplicate') "got $($r2 | ConvertTo-Json -Compress)"

  # --- 4. it comes back out, and the bytes still hash to the same id --------
  $feed = Invoke-RestMethod -Uri "$base/messages?since=0&limit=50" -TimeoutSec 10
  Check 'exactly one copy exists after a replay' ($feed.messages.Count -eq 1) "got $($feed.messages.Count) copies"

  # The id is NOT a field on the wire — it is recomputed from the bytes. So the
  # obvious assertion `$returned.id -eq $sent.id` compares $null to $null and
  # ALWAYS PASSES while proving nothing. The first version of this script did
  # exactly that. Recompute it for real, in Node, where the canonicalization is.
  $raw = Invoke-WebRequest -Uri "$base/messages?since=0&limit=50" -UseBasicParsing -TimeoutSec 10
  Set-Content -Path $feedFile -Value $raw.Content -Encoding ASCII
  $verdict = (& node (Join-Path $root 'tools\verify-feed.mjs') $id $feedFile 2>&1 | Out-String).Trim()
  Check 'the returned bytes recompute to the same id and still verify' ($LASTEXITCODE -eq 0) $verdict
  if ($LASTEXITCODE -eq 0) { Write-Host "      $verdict" }

  # --- 5. garbage is refused, not stored -----------------------------------
  try {
    $bad = Invoke-RestMethod -Uri "$base/messages" -Method Post -ContentType 'application/json' -Body '{"v":1,"nope":true}' -TimeoutSec 10
    Check 'a malformed message is refused' ($bad.ok -eq $false) "got $($bad | ConvertTo-Json -Compress)"
  } catch {
    Check 'a malformed message is refused' ($_.Exception.Response.StatusCode.value__ -ge 400) "unexpected: $($_.Exception.Message)"
  }
  $feed2 = Invoke-RestMethod -Uri "$base/messages?since=0&limit=50" -TimeoutSec 10
  Check 'nothing was stored from the malformed post' ($feed2.messages.Count -eq 1) "got $($feed2.messages.Count) messages"

  Write-Host ''
  if ($script:fails -eq 0) { Write-Host 'ALL CHECKS PASSED in the real Workers runtime.' }
  else { Write-Host "$($script:fails) CHECK(S) FAILED." }
}
finally {
  if ($proc -and -not $proc.HasExited) {
    # npx spawns workerd as a child; kill the tree, not just the wrapper.
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
  }
  if (Test-Path $devToml) { Remove-Item $devToml -Force }
  if ($persist -and (Test-Path $persist) -and $persist.StartsWith($env:TEMP)) {
    # workerd can still hold a file lock for a moment after being killed. The store is
    # a throwaway, so a failed cleanup is noise, not a failure — but noise in a
    # verification script reads as a failure, so retry once and then stay quiet.
    Start-Sleep -Milliseconds 900
    try { Remove-Item -Recurse -Force $persist -ErrorAction Stop }
    catch { Write-Host "(note: could not remove the throwaway KV store; harmless)" }
  }
}

exit $(if ($script:fails -eq 0) { 0 } else { 1 })
