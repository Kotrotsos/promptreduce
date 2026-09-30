# Installs the promptreduce binary on Windows from the latest GitHub release.
#   irm https://raw.githubusercontent.com/Kotrotsos/promptreduce/main/install.ps1 | iex
$Repo = if ($env:PROMPTREDUCE_REPO) { $env:PROMPTREDUCE_REPO } else { "Kotrotsos/promptreduce" }
$Dir = if ($env:PROMPTREDUCE_DIR) { $env:PROMPTREDUCE_DIR } else { Join-Path $env:LOCALAPPDATA "promptreduce" }
$Url = "https://github.com/$Repo/releases/latest/download/promptreduce-windows-x64.exe"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Exe = Join-Path $Dir "promptreduce.exe"
$Local = Join-Path $PSScriptRoot "dist\promptreduce-windows-x64.exe"
if ($PSScriptRoot -and (Test-Path $Local)) {
  Copy-Item $Local $Exe -Force
  Write-Host "installed $Exe from $Local"
} else {
  Write-Host "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Exe
}
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $Dir) {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$Dir", "User")
  Write-Host "added $Dir to your user PATH (open a new terminal to pick it up)"
}
Write-Host "next: promptreduce analyze     (your cost shape)"
Write-Host "      promptreduce setup --all  (point Claude Code at the proxy and start it at logon)"
