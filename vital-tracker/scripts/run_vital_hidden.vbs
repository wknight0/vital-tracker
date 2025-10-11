' Launches Vital Tracker server hidden, with working directory set to the repo root.
' This runs the built release exe: target\release\vital-tracker.exe
' Double-click to test; add a Startup shortcut to run on login.

Option Explicit
Dim fso, scriptPath, scriptFolder, repoRoot, exeRel, exePath, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = WScript.ScriptFullName
scriptFolder = fso.GetParentFolderName(scriptPath)
repoRoot = fso.GetParentFolderName(scriptFolder)
exeRel = "target\release\vital-tracker.exe"
exePath = repoRoot & "\" & exeRel

Set shell = CreateObject("WScript.Shell")
' Ensure the working directory is the repo root so ServeDir("static") resolves correctly
shell.CurrentDirectory = repoRoot

If Not fso.FileExists(exePath) Then
  shell.Popup "vital-tracker.exe not found. Build first: cargo build --release", 5, "Vital Tracker", 48
  WScript.Quit 1
End If

' 0 = hidden window style, False = do not wait
shell.Run Chr(34) & exePath & Chr(34), 0, False
