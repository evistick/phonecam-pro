' PhoneCam Pro — Lanzador silencioso de la aplicacion de escritorio
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir

electronExe = currentDir & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(electronExe) Then
    WshShell.Run """" & electronExe & """ .", 0, False
Else
    WshShell.Run "cmd /c npx electron .", 0, False
End If

Set WshShell = Nothing
Set fso = Nothing
