Add-Type -AssemblyName System.Drawing

$projectDir = "C:\Users\jere_\Documents\phonecam-pro"
$assetsDir = Join-Path $projectDir "assets"
$iconJpg = Join-Path $assetsDir "icon.jpg"
$iconPng = Join-Path $assetsDir "icon.png"
$iconIco = Join-Path $assetsDir "icon.ico"
$electronExe = Join-Path $projectDir "node_modules\electron\dist\electron.exe"
$desktopDir = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDir "PhoneCam Pro.lnk"

# 1. Convert Image to PNG and ICO
if (Test-Path $iconJpg) {
    try {
        $img = [System.Drawing.Image]::FromFile($iconJpg)
        $bmp = New-Object System.Drawing.Bitmap($img, 256, 256)
        $bmp.Save($iconPng, [System.Drawing.Imaging.ImageFormat]::Png)
        
        $hIcon = $bmp.GetHicon()
        $ico = [System.Drawing.Icon]::FromHandle($hIcon)
        $stream = [System.IO.File]::OpenWrite($iconIco)
        $ico.Save($stream)
        $stream.Close()
        
        $img.Dispose()
        $bmp.Dispose()
        Write-Host "Icon files created successfully."
    } catch {
        Write-Host "Icon warning: $_"
    }
}

# 2. Create Direct Desktop Shortcut to electron.exe
$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)

if (Test-Path $electronExe) {
    $shortcut.TargetPath = $electronExe
    $shortcut.Arguments = "`"$projectDir`""
} else {
    $shortcut.TargetPath = "wscript.exe"
    $shortcut.Arguments = "`"$projectDir\PhoneCam-Pro.vbs`""
}

$shortcut.WorkingDirectory = $projectDir
$shortcut.Description = "PhoneCam Pro - Webcam HD"

if (Test-Path $iconIco) {
    $shortcut.IconLocation = "$iconIco,0"
}

$shortcut.Save()
Write-Host "Desktop shortcut created successfully at: $shortcutPath"
