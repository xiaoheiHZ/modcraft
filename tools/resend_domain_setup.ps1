# Resend 域名验证一键脚本
# 用法: powershell -ExecutionPolicy Bypass -File tools\resend_domain_setup.ps1 -ResendKey re_xxxx
# 前置: 1) Resend key 必须为 Full access  2) 桌面 .cf_parsed.json 里有 Cloudflare token（Cloudflare 侧已配好者可用）
param(
  [Parameter(Mandatory = $true)][string]$ResendKey,
  [string]$Domain = 'modcraft.top'
)
$ErrorActionPreference = 'Stop'
Write-Host "== 1) 读取 Cloudflare token ==" -ForegroundColor Cyan
$cf = [IO.File]::ReadAllText("$env:USERPROFILE\Desktop\.cf_parsed.json") | ConvertFrom-Json
$CF_H = @{ Authorization = "Bearer $($cf.token)"; 'Content-Type' = 'application/json' }
$R_H = @{ Authorization = "Bearer $ResendKey"; 'Content-Type' = 'application/json' }

Write-Host "== 2) 查找 zone ==" -ForegroundColor Cyan
$zone = (Invoke-RestMethod "https://api.cloudflare.com/client/v4/zones?name=$Domain" -Headers $CF_H).result[0]
if (-not $zone) { throw "Cloudflare 账户里没有 $Domain" }
Write-Host "zone id: $($zone.id)"

Write-Host "== 3) 创建/获取 Resend 域名 ==" -ForegroundColor Cyan
$dom = $null
try {
  $list = (Invoke-RestMethod 'https://api.resend.com/domains' -Headers $R_H).data
  $dom = $list | Where-Object { $_.name -eq $Domain } | Select-Object -First 1
} catch { throw "Resend 查询失败（key 需要 Full access）: $($_.Exception.Message)" }
if (-not $dom) {
  $dom = Invoke-RestMethod 'https://api.resend.com/domains' -Method Post -Headers $R_H -Body (@{ name = $Domain } | ConvertTo-Json)
  if ($dom.id) { Write-Host "已创建域名: $($dom.id)" } else { throw "创建失败: $($dom | ConvertTo-Json -Compress)" }
} else { Write-Host "域名已存在: status=$($dom.status)" }

Write-Host "== 4) 拉取 DNS 记录并写入 Cloudflare ==" -ForegroundColor Cyan
$det = Invoke-RestMethod "https://api.resend.com/domains/$($dom.id)" -Headers $R_H
foreach ($r in $det.records) {
  $recName = $r.name
  $content = if ($r.value) { $r.value } else { $r.content }
  $type = $r.type
  Write-Host "→ $type $recName" -ForegroundColor Yellow
  $body = @{ type = $type; name = $recName; content = $content; ttl = 1; proxied = $false }
  if ($r.priority -ne $null) { $body.priority = [int]$r.priority }
  try {
    $null = Invoke-RestMethod "https://api.cloudflare.com/client/v4/zones/$($zone.id)/dns_records" -Method Post -Headers $CF_H -Body ($body | ConvertTo-Json)
    Write-Host "   OK" -ForegroundColor Green
  } catch {
    Write-Host "   失败（可能已存在，可忽略）: $($_.Exception.Message)" -ForegroundColor DarkYellow
  }
}

Write-Host "== 5) 触发验证并轮询（最多 5 分钟） ==" -ForegroundColor Cyan
try { $null = Invoke-RestMethod "https://api.resend.com/domains/$($dom.id)/verify" -Method Post -Headers $R_H } catch {}
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep -Seconds 15
  $d2 = Invoke-RestMethod "https://api.resend.com/domains/$($dom.id)" -Headers $R_H
  Write-Host "检查 $i/20: status=$($d2.status)"
  if ($d2.status -eq 'verified') {
    Write-Host "`n[OK] 域名验证完成！现在把 MAIL_FROM 换成：ModCraft <noreply@$Domain>" -ForegroundColor Green
    Write-Host "命令: npx wrangler secret put MAIL_FROM  (输入 ModCraft <noreply@$Domain>)" -ForegroundColor Green
    exit 0
  }
}
Write-Host "`n[!] 还没验证通过，DNS 可能还在传播，稍后重新运行或到 Resend 后台查看" -ForegroundColor Yellow
