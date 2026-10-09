' Local Model Studio -- windowless launcher.
'
' ASCII ONLY. Do not put Chinese (or any non-ASCII) text in this file: Windows
' Script Host decodes a BOM-less file as ANSI, which mangles the bytes and makes it
' fail with "Object required: 'sh'" / "缺少对象: 'sh'" pointing at a harmless line.
'
' To debug, run:  cscript //nologo "Local Model Studio.vbs"
'
' IMPORTANT (cmd parsing, 2026-10-07): do NOT fold the mkdir and the node call into
' one line like
'     cmd /c if not exist app\logs mkdir app\logs & node app\launch.js >> log 2>&1
' In cmd the "&" does NOT split an if-statement: everything after the condition is
' the if-body, so once app\logs exists the condition is false and the node command is
' silently skipped -- the launcher does nothing at all, with no window and no log
' line. Keep the two steps as separate sh.Run calls (proved by test; see the notes in
' the project memory card).
Option Explicit

Dim sh, fso, here, rc
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' A missing node.exe used to fail invisibly (hidden console, no message). Say it out loud.
rc = sh.Run("cmd /c where node >nul 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "Node.js was not found on PATH, so Local Model Studio cannot start." & vbCrLf & vbCrLf & _
         "Install Node.js 18 or newer (or add its folder, e.g. D:\node, to PATH) and try again.", _
         16, "Local Model Studio"
  WScript.Quit 1
End If

' Step 1: make sure the log folder exists (waits for completion).
rc = sh.Run("cmd /c if not exist app\logs mkdir app\logs", 0, True)

' Step 2: start the stack; its own console stays hidden and everything lands in the log.
rc = sh.Run("cmd /c node app\launch.js >> app\logs\launcher.log 2>&1", 0, False)
