# Creates (or removes with -Remove) the ORBIT shortcuts on the Desktop and in
# the Start Menu, so ORBIT opens like any other app. No administrator rights needed.
param([switch]$Remove)

$root = Split-Path -Parent $PSScriptRoot
$places = @(
  [Environment]::GetFolderPath("Desktop"),
  [Environment]::GetFolderPath("Programs")
)

# The shortcuts of the former name (AuraJobs) are always replaced.
foreach ($dir in $places) {
  foreach ($name in @("AuraJobs.lnk") + $(if ($Remove) { @("ORBIT.lnk") } else { @() })) {
    $path = Join-Path $dir $name
    if (Test-Path $path) {
      Remove-Item $path
      Write-Output "Removed $path"
    }
  }
}
if ($Remove) { exit 0 }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $places) {
  $path = Join-Path $dir "ORBIT.lnk"
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $link.Arguments = '"' + (Join-Path $root "scripts\Orbit.vbs") + '"'
  $link.WorkingDirectory = $root
  $link.IconLocation = (Join-Path $root "scripts\orbit.ico") + ",0"
  $link.Description = "ORBIT, suivi des candidatures"
  $link.Save()
  Write-Output "Created $path"
}
Write-Output "Tip: right-click the ORBIT icon and choose Pin to taskbar or Pin to Start."
