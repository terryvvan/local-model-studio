' Bonsai Studio - windowless launcher.
' ASCII ONLY on purpose: WSH reads .vbs as ANSI, and a non-ASCII comment makes it die
' with "Object required: 'sh'" (see the project notes on the VBScript encoding trap).
Option Explicit

Dim sh, fso, base, logs, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
logs = base & "\app\logs"
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs) End If

sh.CurrentDirectory = base
cmd = "cmd /c node """ & base & "\app\launch.js"" >> """ & logs & "\launcher.log"" 2>&1"
sh.Run cmd, 0, False
